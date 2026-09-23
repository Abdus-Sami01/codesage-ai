import * as vscode from 'vscode';
import * as path from 'path';
import { ReviewConfig, ReviewRequest, ReviewResponse } from '../types';
import { getProfile } from '../profiles';
import { parseIssues } from './issueParser';
import { SseDecoder, parseChatCompletion, parseChatStreamPayload } from './sseParser';

const CANCELLED_MESSAGE = 'Review cancelled.';
const ERROR_BODY_SNIPPET_LENGTH = 400;

interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

/**
 * Bridges the VS Code extension to any provider exposing an OpenAI-compatible
 * `/chat/completions` endpoint.
 *
 * Both entry points share one request builder so the streaming and batch paths
 * can never drift apart in prompt, model or sampling parameters.
 */
export class ReviewService {
  constructor(
    private readonly config: ReviewConfig,
    private readonly apiKey: string,
    private readonly outputChannel: vscode.OutputChannel
  ) {}

  async review(
    request: ReviewRequest,
    token: vscode.CancellationToken
  ): Promise<ReviewResponse> {
    const startTime = Date.now();

    return this.withRequest(request, false, token, async (response) => {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new Error('Provider returned a response body that was not valid JSON.');
      }

      const completion = parseChatCompletion(body);
      const { cleanContent, issues } = parseIssues(completion.content);

      return {
        content: cleanContent,
        model: completion.model ?? this.config.model,
        tokensUsed: completion.totalTokens,
        duration: Date.now() - startTime,
        issues,
      };
    });
  }

  async reviewStream(
    request: ReviewRequest,
    onChunk: (partialContent: string) => void,
    token: vscode.CancellationToken
  ): Promise<ReviewResponse> {
    const startTime = Date.now();

    return this.withRequest(request, true, token, (response) =>
      this.consumeStream(response, onChunk, token, startTime)
    );
  }

  private async consumeStream(
    response: Response,
    onChunk: (partialContent: string) => void,
    token: vscode.CancellationToken,
    startTime: number
  ): Promise<ReviewResponse> {
    if (response.body === null) {
      throw new Error('Provider accepted the streaming request but sent no response body.');
    }

    const reader = response.body.getReader();
    const textDecoder = new TextDecoder();
    const sseDecoder = new SseDecoder();

    let accumulated = '';
    let resolvedModel: string | null = null;
    let resolvedTokens: number | null = null;

    const consume = (payload: string): void => {
      const delta = parseChatStreamPayload(payload);
      if (delta === null) {
        return;
      }

      if (delta.error !== null) {
        throw new Error(delta.error);
      }

      resolvedModel = delta.model ?? resolvedModel;
      resolvedTokens = delta.totalTokens ?? resolvedTokens;

      if (delta.content.length > 0) {
        accumulated += delta.content;
        onChunk(accumulated);
      }
    };

    try {
      for (;;) {
        if (token.isCancellationRequested) {
          throw new Error(CANCELLED_MESSAGE);
        }

        const { value, done } = await reader.read();
        if (done) {
          break;
        }

        for (const event of sseDecoder.push(textDecoder.decode(value, { stream: true }))) {
          consume(event.data);
        }
      }

      for (const event of sseDecoder.flush()) {
        consume(event.data);
      }
    } catch (error) {
      // A stream that dies after producing prose still carries a usable review,
      // so partial output is preferred over discarding the whole request.
      if (token.isCancellationRequested || accumulated.length === 0) {
        throw this.asReportableError(error, token);
      }

      this.outputChannel.appendLine(
        `[Stream] Truncated after ${accumulated.length} characters: ${describe(error)}`
      );
    }

    const { cleanContent, issues } = parseIssues(accumulated);

    return {
      content: cleanContent,
      model: resolvedModel ?? this.config.model,
      tokensUsed: resolvedTokens ?? 0,
      duration: Date.now() - startTime,
      issues,
    };
  }

  /**
   * Owns the abort wiring for a whole request, including body consumption.
   * `fetch` settles once headers arrive, so a streamed body is still in flight
   * afterwards and the cancellation listener has to outlive it.
   */
  private async withRequest<T>(
    request: ReviewRequest,
    stream: boolean,
    token: vscode.CancellationToken,
    consume: (response: Response) => Promise<T>
  ): Promise<T> {
    const endpoint = this.resolveEndpoint();
    const controller = new AbortController();
    const cancelListener = token.onCancellationRequested(() => controller.abort());

    try {
      if (token.isCancellationRequested) {
        throw new Error(CANCELLED_MESSAGE);
      }

      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: this.config.model,
            messages: this.buildMessages(request),
            max_tokens: this.config.maxTokens,
            temperature: this.config.temperature,
            stream,
          }),
        });
      } catch (error) {
        throw this.asReportableError(error, token, endpoint);
      }

      if (!response.ok) {
        throw new Error(await this.describeFailedResponse(response));
      }

      return await consume(response);
    } finally {
      cancelListener.dispose();
    }
  }

  private buildMessages(request: ReviewRequest): ChatMessage[] {
    const profile = getProfile(this.config.profile);
    const baseName = path.basename(request.fileName);

    return [
      { role: 'system', content: profile.systemPrompt },
      {
        role: 'user',
        content:
          `Review this ${request.language} code from \`${baseName}\`:\n\n` +
          `\`\`\`${request.language}\n${request.code}\n\`\`\``,
      },
    ];
  }

  private resolveEndpoint(): string {
    const baseUrl = this.config.baseUrl.trim();

    if (baseUrl.length === 0) {
      throw new Error(
        `No endpoint configured for provider "${this.config.provider}". ` +
        'Set "codesage-ai.baseUrl" to your gateway URL, for example http://localhost:8080/v1.'
      );
    }

    return baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`;
  }

  private async describeFailedResponse(response: Response): Promise<string> {
    let snippet = '';
    try {
      snippet = (await response.text()).trim().slice(0, ERROR_BODY_SNIPPET_LENGTH);
    } catch {
      snippet = '';
    }

    this.outputChannel.appendLine(`[HTTP ${response.status}] ${snippet}`);

    const hint = this.hintForStatus(response.status);
    const detail = snippet.length > 0 ? ` ${snippet}` : '';

    return `Provider returned ${response.status} ${response.statusText}.${detail}${hint}`;
  }

  private hintForStatus(status: number): string {
    if (status === 401 || status === 403) {
      return ' Run "CodeSage: Set API Key" to update the key for this provider.';
    }

    if (status === 404) {
      return ` Check that "codesage-ai.model" (${this.config.model}) exists on this provider and that "codesage-ai.baseUrl" is correct.`;
    }

    if (status === 429) {
      return ' The provider rate limit was hit. Wait for the window to reset or switch provider.';
    }

    return '';
  }

  private asReportableError(
    error: unknown,
    token: vscode.CancellationToken,
    endpoint?: string
  ): Error {
    if (token.isCancellationRequested || isAbortError(error)) {
      return new Error(CANCELLED_MESSAGE);
    }

    this.outputChannel.appendLine(`[Request] ${describe(error)}`);

    if (endpoint !== undefined) {
      return new Error(
        `Could not reach ${endpoint}: ${describe(error)}. ` +
        'Check the endpoint URL, your network, and any proxy settings.'
      );
    }

    return error instanceof Error ? error : new Error(describe(error));
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
