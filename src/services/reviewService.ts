import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as path from 'path';
import { ReviewConfig, ReviewRequest, ReviewResponse, StreamChunk } from '../types';
import { getProfile } from '../profiles';
import { parseIssues } from './issueParser';

/**
 * Bridges the VS Code extension to the Python review backend.
 *
 * Communication protocol:
 * - Input:  JSON via stdin  { code, language, fileName }
 * - Config: Environment variables (HF_API_KEY, CODESAGE_MODEL, etc.)
 * - Output (non-streaming): single JSON line { content, model, tokens_used } or { error }
 * - Output (streaming): JSON lines { type: "chunk", content } followed by { type: "done", ... }
 */
export class ReviewService {
  private readonly scriptPath: string;

  constructor(
    private readonly config: ReviewConfig,
    private readonly apiKey: string,
    extensionPath: string,
    private readonly outputChannel: vscode.OutputChannel
  ) {
    this.scriptPath = path.join(extensionPath, 'code_review.py');
  }

  /**
   * Sends code to the Python backend for AI review (non-streaming).
   */
  async review(
    request: ReviewRequest,
    token: vscode.CancellationToken
  ): Promise<ReviewResponse> {
    const startTime = Date.now();
    const profile = getProfile(this.config.profile);

    return new Promise<ReviewResponse>((resolve, reject) => {
      const proc = spawn(this.config.pythonPath, [this.scriptPath], {
        env: {
          ...process.env,
          HF_API_KEY: this.apiKey,
          CODESAGE_MODEL: this.config.model,
          CODESAGE_MAX_TOKENS: String(this.config.maxTokens),
          CODESAGE_TEMPERATURE: String(this.config.temperature),
          CODESAGE_PROFILE: this.config.profile,
          CODESAGE_SYSTEM_PROMPT: profile.systemPrompt,
          CODESAGE_STREAM: 'false',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const cancelListener = token.onCancellationRequested(() => {
        proc.kill();
        reject(new Error('Review cancelled.'));
      });

      const input = JSON.stringify(request);
      proc.stdin.write(input);
      proc.stdin.end();

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
        this.outputChannel.appendLine(`[Python] ${data.toString().trim()}`);
      });

      proc.on('close', (code: number | null) => {
        cancelListener.dispose();
        const duration = Date.now() - startTime;

        if (code !== 0) {
          reject(new Error(stderr.trim() || `Python process exited with code ${code}`));
          return;
        }

        try {
          const result = JSON.parse(stdout);
          if (result.error) {
            reject(new Error(result.error));
            return;
          }

          const rawContent = result.content || '';
          const { cleanContent, issues } = parseIssues(rawContent);

          resolve({
            content: cleanContent,
            model: result.model || this.config.model,
            tokensUsed: result.tokens_used || 0,
            duration,
            issues,
          });
        } catch {
          reject(new Error(`Failed to parse review output. Raw: ${stdout.substring(0, 300)}`));
        }
      });

      proc.on('error', (err: Error) => {
        cancelListener.dispose();
        reject(
          new Error(
            `Failed to start Python (${this.config.pythonPath}): ${err.message}. ` +
            'Ensure Python is installed and the path is correct in settings.'
          )
        );
      });
    });
  }

  /**
   * Sends code to the Python backend with streaming output.
   * Calls onChunk() for each incremental content update.
   */
  async reviewStream(
    request: ReviewRequest,
    onChunk: (partialContent: string) => void,
    token: vscode.CancellationToken
  ): Promise<ReviewResponse> {
    const startTime = Date.now();
    const profile = getProfile(this.config.profile);

    return new Promise<ReviewResponse>((resolve, reject) => {
      const proc = spawn(this.config.pythonPath, [this.scriptPath], {
        env: {
          ...process.env,
          HF_API_KEY: this.apiKey,
          CODESAGE_MODEL: this.config.model,
          CODESAGE_MAX_TOKENS: String(this.config.maxTokens),
          CODESAGE_TEMPERATURE: String(this.config.temperature),
          CODESAGE_PROFILE: this.config.profile,
          CODESAGE_SYSTEM_PROMPT: profile.systemPrompt,
          CODESAGE_STREAM: 'true',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const cancelListener = token.onCancellationRequested(() => {
        proc.kill();
        reject(new Error('Review cancelled.'));
      });

      proc.stdin.write(JSON.stringify(request));
      proc.stdin.end();

      let stderr = '';
      let accumulatedContent = '';
      let lineBuffer = '';

      proc.stdout.on('data', (data: Buffer) => {
        lineBuffer += data.toString();

        // Process complete lines
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() || ''; // Keep incomplete last line in buffer

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          try {
            const chunk: StreamChunk = JSON.parse(trimmed);

            if (chunk.type === 'chunk') {
              accumulatedContent += chunk.content;
              onChunk(accumulatedContent);
            } else if (chunk.type === 'done') {
              const duration = Date.now() - startTime;
              const { cleanContent, issues } = parseIssues(chunk.content || accumulatedContent);

              resolve({
                content: cleanContent,
                model: chunk.model || this.config.model,
                tokensUsed: chunk.tokens_used || 0,
                duration,
                issues,
              });
            }
          } catch {
            // Skip malformed lines
            this.outputChannel.appendLine(`[Stream] Skipped malformed chunk: ${trimmed.substring(0, 100)}`);
          }
        }
      });

      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
        this.outputChannel.appendLine(`[Python] ${data.toString().trim()}`);
      });

      proc.on('close', (code: number | null) => {
        cancelListener.dispose();
        const duration = Date.now() - startTime;

        // Process any remaining buffer
        if (lineBuffer.trim()) {
          try {
            const chunk: StreamChunk = JSON.parse(lineBuffer.trim());
            if (chunk.type === 'done') {
              const { cleanContent, issues } = parseIssues(chunk.content || accumulatedContent);
              resolve({
                content: cleanContent,
                model: chunk.model || this.config.model,
                tokensUsed: chunk.tokens_used || 0,
                duration,
                issues,
              });
              return;
            }
          } catch { /* ignore */ }
        }

        if (code !== 0) {
          reject(new Error(stderr.trim() || `Python process exited with code ${code}`));
          return;
        }

        // If we never received a 'done' chunk, resolve with accumulated content
        if (accumulatedContent) {
          const { cleanContent, issues } = parseIssues(accumulatedContent);
          resolve({
            content: cleanContent,
            model: this.config.model,
            tokensUsed: 0,
            duration,
            issues,
          });
        }
      });

      proc.on('error', (err: Error) => {
        cancelListener.dispose();
        reject(
          new Error(
            `Failed to start Python (${this.config.pythonPath}): ${err.message}. ` +
            'Ensure Python is installed and the path is correct in settings.'
          )
        );
      });
    });
  }
}
