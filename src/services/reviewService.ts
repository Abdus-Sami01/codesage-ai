import * as vscode from 'vscode';
import * as path from 'path';
import { ReviewConfig, ReviewRequest, ReviewResponse } from '../types';
import { resolveKeyLookup } from '../config';

export type { ModelDescriptor } from './sseParser';
import { getProfile } from '../profiles';
import { parseIssues } from './issueParser';
import {
  ModelDescriptor,
  SseDecoder,
  parseChatCompletion,
  parseChatStreamPayload,
  parseModelCatalog,
} from './sseParser';
import {
  AttemptOutcome,
  DEFAULT_EXHAUSTED_COOLDOWN_MS,
  DEFAULT_RATE_LIMIT_COOLDOWN_MS,
  Lease,
  QuotaLedger,
  RotationPool,
  RouteDefinition,
  SlotSnapshot,
  buildPool,
  classifyPause,
  formatDuration,
  parseRetryAfterMs,
} from './rotation';

const CANCELLED_MESSAGE = 'Review cancelled.';
const ERROR_BODY_SNIPPET_LENGTH = 400;

/** Wording providers use for a spent budget rather than a momentary throttle. */
const QUOTA_HINTS = /quota|credit|insufficient.?(balance|funds)|billing|exceeded your current/i;

/** Wording that means the prompt itself does not fit, which another key cannot fix. */
const CONTEXT_HINTS = /context (length|window)|maximum context|context_length|too many tokens|reduce the length|prompt is too long/i;

/** Wording that means throttling even when the status code or headers do not say so. */
const RATE_LIMIT_HINTS = /rate.?limit|too many requests|slow down|overloaded|capacity/i;

interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

/**
 * A failure that the pool can recover from by trying a different slot.
 * The outcome it carries is what the pool applies to the slot that produced it.
 */
class RouteFailure extends Error {
  constructor(message: string, readonly outcome: AttemptOutcome) {
    super(message);
    this.name = 'RouteFailure';
  }
}

/** A failure no other slot would survive either, so the attempt loop stops. */
class FatalRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FatalRequestError';
  }
}

/**
 * Aborts a request that has gone quiet.
 *
 * A non-streaming call gets one deadline for the whole exchange. A streaming
 * call is re-armed on every chunk instead, because a long review legitimately
 * takes minutes to produce and only silence means the connection is dead.
 */
class RequestTimer {
  private handle: ReturnType<typeof setTimeout> | undefined;
  private expired = false;

  constructor(private readonly timeoutMs: number, private readonly onExpire: () => void) {}

  get hasExpired(): boolean {
    return this.expired;
  }

  arm(): void {
    this.clear();

    if (this.timeoutMs <= 0) {
      return;
    }

    this.handle = setTimeout(() => {
      this.expired = true;
      this.onExpire();
    }, this.timeoutMs);
  }

  clear(): void {
    if (this.handle !== undefined) {
      clearTimeout(this.handle);
      this.handle = undefined;
    }
  }
}

/**
 * Bridges the VS Code extension to any provider exposing an OpenAI-compatible
 * `/chat/completions` endpoint.
 *
 * A review is not one request to one model. It is a walk over a rotation pool:
 * every (route, key) pair is tried in tier order until one answers, and whatever
 * the provider says about recovery is written back to the shared quota ledger so
 * the next review starts from what this one learned. Both entry points share one
 * request builder, so the streaming and batch paths can never drift apart in
 * prompt, model or sampling parameters.
 */
export class ReviewService {
  private readonly pool: RotationPool;
  private readonly bestTier: number;
  private tierDropReported = false;

  constructor(
    private readonly config: ReviewConfig,
    keysForRoute: (route: RouteDefinition) => readonly string[],
    ledger: QuotaLedger,
    private readonly outputChannel: vscode.OutputChannel
  ) {
    this.pool = buildPool(config.routes, keysForRoute, ledger);
    this.bestTier = config.routes.reduce(
      (lowest, route) => Math.min(lowest, route.tier),
      Number.POSITIVE_INFINITY
    );
  }

  /** Number of (route, key) pairs available. Zero means nothing is configured. */
  get poolSize(): number {
    return this.pool.size;
  }

  get routeCount(): number {
    return this.pool.routeCount;
  }

  describePool(): SlotSnapshot[] {
    return this.pool.describe();
  }

  async review(
    request: ReviewRequest,
    token: vscode.CancellationToken
  ): Promise<ReviewResponse> {
    const startTime = Date.now();

    return this.runWithRotation(request, false, token, async (response, lease, attempts) => {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new RouteFailure('Provider returned a response body that was not valid JSON.', {
          kind: 'cooling',
          retryAfterMs: null,
          reason: 'Malformed JSON response.',
        });
      }

      let completion;
      try {
        completion = parseChatCompletion(body);
      } catch (error) {
        throw this.failureFromMessage(describe(error));
      }

      const { cleanContent, issues } = parseIssues(completion.content);

      return this.decorate(
        {
          content: cleanContent,
          model: completion.model ?? lease.route.model,
          tokensUsed: completion.totalTokens,
          duration: Date.now() - startTime,
          issues,
        },
        lease,
        attempts
      );
    });
  }

  async reviewStream(
    request: ReviewRequest,
    onChunk: (partialContent: string) => void,
    token: vscode.CancellationToken
  ): Promise<ReviewResponse> {
    const startTime = Date.now();

    return this.runWithRotation(request, true, token, (response, lease, attempts, timer) =>
      this.consumeStream(response, onChunk, token, startTime, lease, attempts, timer)
    );
  }

  /**
   * Lists the models the configured provider actually serves.
   *
   * Free text in `codesage-ai.model` is a guess until something confirms it;
   * this is what turns the setting into a pick from a live catalog.
   */
  async listModels(token: vscode.CancellationToken): Promise<ModelDescriptor[]> {
    const route = this.config.routes[0];

    if (route === undefined) {
      throw new Error(
        'No route is configured. Set "codesage-ai.baseUrl" to your provider endpoint first.'
      );
    }

    const lease = this.pool.acquire();
    const apiKey = lease?.apiKey ?? '';

    if (lease !== null) {
      this.pool.release(lease, { kind: 'aborted' });
    }

    const controller = new AbortController();
    const cancelListener = token.onCancellationRequested(() => controller.abort());
    const timer = new RequestTimer(this.config.requestTimeoutMs, () => controller.abort());
    timer.arm();

    try {
      const response = await fetch(this.resolveEndpoint(route, 'models'), {
        method: 'GET',
        signal: controller.signal,
        headers: this.buildHeaders(apiKey),
      });

      if (!response.ok) {
        const snippet = await readSnippet(response);
        throw new Error(
          `Provider returned ${response.status} ${response.statusText} for /models.${snippet.length > 0 ? ` ${snippet}` : ''}`
        );
      }

      return parseModelCatalog(await response.json());
    } catch (error) {
      if (token.isCancellationRequested) {
        throw new Error(CANCELLED_MESSAGE);
      }
      if (timer.hasExpired) {
        throw new Error(`Listing models timed out after ${formatDuration(this.config.requestTimeoutMs)}.`);
      }
      throw error instanceof Error ? error : new Error(describe(error));
    } finally {
      timer.clear();
      cancelListener.dispose();
    }
  }

  /**
   * Walks the pool until a slot answers.
   *
   * Every failure teaches the ledger something, so an attempt is never wasted
   * even when it fails: a 429 parks that slot for exactly as long as the
   * provider asked for, and the next review skips it without paying for the
   * round trip again.
   */
  private async runWithRotation<T extends ReviewResponse>(
    request: ReviewRequest,
    stream: boolean,
    token: vscode.CancellationToken,
    consume: (response: Response, lease: Lease, attempts: number, timer: RequestTimer) => Promise<T>
  ): Promise<T> {
    this.assertPoolIsUsable();

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.config.maxAttempts; attempt += 1) {
      if (token.isCancellationRequested) {
        throw new Error(CANCELLED_MESSAGE);
      }

      let lease = this.pool.acquire();

      if (lease === null) {
        const waited = await this.waitForCapacity(token);

        if (token.isCancellationRequested) {
          throw new Error(CANCELLED_MESSAGE);
        }

        if (!waited) {
          throw lastError ?? this.exhaustionError();
        }

        lease = this.pool.acquire();
        if (lease === null) {
          throw lastError ?? this.exhaustionError();
        }
      }

      this.outputChannel.appendLine(
        `[Attempt ${attempt}/${this.config.maxAttempts}] ${lease.route.label} via ${lease.keyLabel} (tier ${lease.route.tier})`
      );

      try {
        const result = await this.executeAttempt(request, stream, token, lease, attempt, consume);
        this.pool.release(lease, { kind: 'ok' });
        this.reportTierDrop(lease);
        return result;
      } catch (error) {
        if (token.isCancellationRequested) {
          this.pool.release(lease, { kind: 'aborted' });
          throw new Error(CANCELLED_MESSAGE);
        }

        if (error instanceof FatalRequestError) {
          this.pool.release(lease, { kind: 'aborted' });
          throw new Error(error.message);
        }

        const failure = error instanceof RouteFailure
          ? error
          : this.failureFromMessage(describe(error));

        this.pool.release(lease, failure.outcome);
        lastError = new Error(failure.message);

        this.outputChannel.appendLine(
          `[Attempt ${attempt}] ${lease.route.label} failed (${failure.outcome.kind}): ${failure.message}`
        );
      }
    }

    throw lastError ?? this.exhaustionError();
  }

  /** One request against one leased slot, with its own abort wiring and deadline. */
  private async executeAttempt<T>(
    request: ReviewRequest,
    stream: boolean,
    token: vscode.CancellationToken,
    lease: Lease,
    attempt: number,
    consume: (response: Response, lease: Lease, attempts: number, timer: RequestTimer) => Promise<T>
  ): Promise<T> {
    const endpoint = this.resolveEndpoint(lease.route, 'chat/completions');
    const controller = new AbortController();
    const cancelListener = token.onCancellationRequested(() => controller.abort());
    const timer = new RequestTimer(this.config.requestTimeoutMs, () => controller.abort());

    try {
      if (token.isCancellationRequested) {
        throw new Error(CANCELLED_MESSAGE);
      }

      let response: Response;
      timer.arm();

      try {
        response = await fetch(endpoint, {
          method: 'POST',
          signal: controller.signal,
          headers: this.buildHeaders(lease.apiKey),
          body: JSON.stringify({
            model: lease.route.model,
            messages: this.buildMessages(request),
            max_tokens: this.config.maxTokens,
            temperature: this.config.temperature,
            stream,
          }),
        });
      } catch (error) {
        throw this.transportFailure(error, endpoint, timer);
      }

      if (!response.ok) {
        throw await this.failureFromResponse(response, lease.route);
      }

      return await consume(response, lease, attempt, timer);
    } finally {
      timer.clear();
      cancelListener.dispose();
    }
  }

  private async consumeStream(
    response: Response,
    onChunk: (partialContent: string) => void,
    token: vscode.CancellationToken,
    startTime: number,
    lease: Lease,
    attempts: number,
    timer: RequestTimer
  ): Promise<ReviewResponse> {
    if (response.body === null) {
      throw new RouteFailure('Provider accepted the streaming request but sent no response body.', {
        kind: 'cooling',
        retryAfterMs: null,
        reason: 'Empty streaming body.',
      });
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

        // Every chunk proves the connection is alive, so the silence deadline
        // restarts rather than counting down across a long review.
        timer.arm();

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
      if (token.isCancellationRequested) {
        throw new Error(CANCELLED_MESSAGE);
      }

      if (accumulated.length === 0) {
        throw timer.hasExpired
          ? this.timeoutFailure()
          : this.failureFromMessage(describe(error));
      }

      this.outputChannel.appendLine(
        `[Stream] Truncated after ${accumulated.length} characters: ${describe(error)}`
      );
    }

    const { cleanContent, issues } = parseIssues(accumulated);

    return this.decorate(
      {
        content: cleanContent,
        model: resolvedModel ?? lease.route.model,
        tokensUsed: resolvedTokens ?? 0,
        duration: Date.now() - startTime,
        issues,
      },
      lease,
      attempts
    );
  }

  private decorate<T extends ReviewResponse>(response: T, lease: Lease, attempts: number): T {
    return {
      ...response,
      provider: lease.route.provider,
      routeLabel: lease.route.label,
      tier: lease.route.tier,
      attempts,
    };
  }

  /**
   * Waits out a pause short enough to be worth waiting out.
   *
   * With one key and one model, a sixty second throttle is the difference
   * between a review and an error message. Anything longer than
   * `maxQueueWaitMs` is reported instead, because a silent multi-minute stall
   * is worse than a clear failure.
   */
  private async waitForCapacity(token: vscode.CancellationToken): Promise<boolean> {
    const recoveryAt = this.pool.nextRecoveryAt();
    if (recoveryAt === null) {
      return false;
    }

    const waitMs = recoveryAt - Date.now();
    if (waitMs <= 0) {
      return true;
    }

    if (waitMs > this.config.maxQueueWaitMs) {
      return false;
    }

    this.outputChannel.appendLine(
      `[Pool] Every route is paused; waiting ${formatDuration(waitMs)} for the next one to free up.`
    );

    await delay(waitMs + 50, token);
    return !token.isCancellationRequested;
  }

  private assertPoolIsUsable(): void {
    if (this.pool.size > 0) {
      return;
    }

    if (this.config.invalidRoutes.length > 0) {
      throw new Error(
        `No usable route. ${this.config.invalidRoutes.join(' ')}`
      );
    }

    throw new Error(
      'No API key is configured for any route. Run "CodeSage: Manage API Keys" to add one.'
    );
  }

  private exhaustionError(): Error {
    const recoveryAt = this.pool.nextRecoveryAt();

    if (recoveryAt === null) {
      return new Error(
        `All ${this.pool.size} pool slot${this.pool.size === 1 ? '' : 's'} failed. ` +
        'Run "CodeSage: Show Rotation Pool" for the per-route reason.'
      );
    }

    const wait = formatDuration(Math.max(0, recoveryAt - Date.now()));

    return new Error(
      `Every route is rate limited right now. The next one frees up in ${wait}. ` +
      'Add another model to "codesage-ai.routes" or another key to raise the ceiling.'
    );
  }

  /** One notice per review when the answer came from a fallback rather than the best model. */
  private reportTierDrop(lease: Lease): void {
    if (this.tierDropReported || lease.route.tier <= this.bestTier) {
      return;
    }

    this.tierDropReported = true;
    vscode.window.showWarningMessage(
      `CodeSage AI: reviewed with ${lease.route.label} (tier ${lease.route.tier}) because the tier ${this.bestTier} routes are rate limited.`
    );
  }

  private buildHeaders(apiKey: string): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };

    // A loopback gateway with no credential must not be sent an empty bearer
    // token, which some servers reject outright.
    if (apiKey.length > 0) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    return headers;
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

  /**
   * Users paste base URLs with the endpoint already on the end. Stripping a
   * known suffix before appending the wanted one keeps `/models` reachable for
   * someone whose `baseUrl` is a full `/chat/completions` URL.
   */
  private resolveEndpoint(route: RouteDefinition, suffix: string): string {
    const base = route.baseUrl.replace(/\/(chat\/completions|completions|models)$/, '');
    return `${base}/${suffix}`;
  }

  /**
   * Turns an HTTP failure into a pool outcome.
   *
   * The status code decides what kind of damage it is, and the provider's own
   * reset headers decide how long it lasts. Guessing is confined to the cases
   * where the provider said nothing.
   */
  private async failureFromResponse(
    response: Response,
    route: RouteDefinition
  ): Promise<RouteFailure | FatalRequestError> {
    const snippet = await readSnippet(response);
    const lookup = (name: string) => response.headers.get(name);
    const detail = snippet.length > 0 ? ` ${snippet}` : '';
    const summary = `${response.status} ${response.statusText}.${detail}`;

    this.outputChannel.appendLine(`[HTTP ${response.status}] ${snippet}`);

    if (response.status === 401 || response.status === 403) {
      return new RouteFailure(
        `Provider rejected the API key (${summary}) Run "CodeSage: Manage API Keys" to replace it.`,
        { kind: 'key-rejected', reason: `Rejected with ${response.status}.` }
      );
    }

    if (response.status === 404) {
      return new RouteFailure(
        `"${route.model}" is not served at ${route.baseUrl} (${summary})`,
        { kind: 'route-rejected', reason: 'Model or endpoint not found.' }
      );
    }

    if (response.status === 402) {
      return new RouteFailure(`Provider reports no remaining credit (${summary})`, {
        kind: 'exhausted',
        retryAfterMs: parseRetryAfterMs(lookup) ?? DEFAULT_EXHAUSTED_COOLDOWN_MS,
        reason: 'Out of credit.',
      });
    }

    if (response.status === 429) {
      const retryAfterMs = parseRetryAfterMs(lookup);
      const spent = QUOTA_HINTS.test(snippet) || classifyPause(retryAfterMs) === 'exhausted';

      return new RouteFailure(`Provider rate limited the request (${summary})`, {
        kind: spent ? 'exhausted' : 'cooling',
        retryAfterMs: retryAfterMs ?? (spent ? DEFAULT_EXHAUSTED_COOLDOWN_MS : DEFAULT_RATE_LIMIT_COOLDOWN_MS),
        reason: spent ? 'Window budget spent.' : 'Throttled.',
      });
    }

    if (response.status === 400 || response.status === 413 || response.status === 422) {
      if (CONTEXT_HINTS.test(snippet)) {
        return new RouteFailure(
          `The selection does not fit this model's context window (${summary})`,
          { kind: 'skip', reason: 'Prompt exceeds this model\'s context window.' }
        );
      }

      return new FatalRequestError(`Provider rejected the request (${summary})`);
    }

    return new RouteFailure(`Provider returned ${summary}`, {
      kind: 'cooling',
      retryAfterMs: parseRetryAfterMs(lookup),
      reason: `HTTP ${response.status}.`,
    });
  }

  private transportFailure(error: unknown, endpoint: string, timer: RequestTimer): Error {
    if (timer.hasExpired) {
      return this.timeoutFailure();
    }

    this.outputChannel.appendLine(`[Request] ${describe(error)}`);

    return new RouteFailure(
      `Could not reach ${endpoint}: ${describe(error)}. ` +
      'Check the endpoint URL, your network, and any proxy settings.',
      { kind: 'cooling', retryAfterMs: null, reason: 'Transport failure.' }
    );
  }

  private timeoutFailure(): RouteFailure {
    return new RouteFailure(
      `Provider went silent for ${formatDuration(this.config.requestTimeoutMs)}. ` +
      'Raise "codesage-ai.requestTimeoutMs" if your model is simply slow.',
      { kind: 'cooling', retryAfterMs: null, reason: 'Timed out.' }
    );
  }

  /** Classifies an error that arrived as prose rather than as a status code. */
  private failureFromMessage(message: string): RouteFailure {
    if (QUOTA_HINTS.test(message)) {
      return new RouteFailure(message, {
        kind: 'exhausted',
        retryAfterMs: DEFAULT_EXHAUSTED_COOLDOWN_MS,
        reason: 'Quota exhausted.',
      });
    }

    if (RATE_LIMIT_HINTS.test(message)) {
      return new RouteFailure(message, {
        kind: 'cooling',
        retryAfterMs: DEFAULT_RATE_LIMIT_COOLDOWN_MS,
        reason: 'Throttled.',
      });
    }

    if (CONTEXT_HINTS.test(message)) {
      return new RouteFailure(message, { kind: 'skip', reason: 'Prompt too long for this model.' });
    }

    return new RouteFailure(message, {
      kind: 'cooling',
      retryAfterMs: null,
      reason: 'Request failed.',
    });
  }
}

async function readSnippet(response: Response): Promise<string> {
  try {
    return (await response.text()).trim().slice(0, ERROR_BODY_SNIPPET_LENGTH);
  } catch {
    return '';
  }
}

function delay(ms: number, token: vscode.CancellationToken): Promise<void> {
  return new Promise((resolve) => {
    const handle = setTimeout(finish, ms);
    const listener = token.onCancellationRequested(finish);

    function finish(): void {
      clearTimeout(handle);
      listener.dispose();
      resolve();
    }
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Builds a service bound to the current credentials and the shared ledger.
 *
 * The ledger is deliberately not created here: quota accounting has to outlive
 * any single review, so it is owned by the extension and handed in.
 */
export async function createReviewService(
  secrets: vscode.SecretStorage,
  config: ReviewConfig,
  ledger: QuotaLedger,
  outputChannel: vscode.OutputChannel
): Promise<ReviewService> {
  const keysForRoute = await resolveKeyLookup(secrets, config.provider);
  return new ReviewService(config, keysForRoute, ledger, outputChannel);
}
