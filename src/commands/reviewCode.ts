import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { getConfig } from '../config';
import { createReviewService } from '../services/reviewService';
import { QuotaLedger } from '../services/rotation';
import { ensurePoolReady } from './configure';
import { ReviewPanel } from '../panels/reviewPanel';
import { ReviewHistory } from '../panels/sidebarProvider';
import { DiagnosticsProvider } from '../providers/diagnosticsProvider';
import { StatusBar } from '../statusBar';
import { ReviewResponse } from '../types';

/** Everything a review run needs from the extension host, bundled once in activate(). */
export interface ReviewContext {
  context: vscode.ExtensionContext;
  outputChannel: vscode.OutputChannel;
  diagnosticsProvider: DiagnosticsProvider;
  statusBar: StatusBar;
  ledger: QuotaLedger;
  history: ReviewHistory;
}

/** What is being reviewed, independent of where the request came from. */
export interface ReviewTarget {
  code: string;
  language: string;
  fileName: string;
  /** Document that receives inline diagnostics; absent for diffs and other non-file targets. */
  document?: vscode.TextDocument;
  /** Line offset added to reported issue lines when only part of the document was sent. */
  lineOffset?: number;
  progressLabel: string;
}

/**
 * Handles the "CodeSage: Review Code" command.
 * Captures the active editor content (or selection), sends it for AI review,
 * displays results in a Webview panel, and sets inline diagnostics.
 * Supports both streaming and non-streaming modes.
 */
export async function reviewCodeCommand(ctx: ReviewContext): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('CodeSage AI: No active editor. Open a file to review.');
    return;
  }

  const document = editor.document;
  const selection = editor.selection;
  const code = selection.isEmpty ? document.getText() : document.getText(selection);

  if (!code.trim()) {
    vscode.window.showWarningMessage('CodeSage AI: No code to review.');
    return;
  }

  await executeReview(ctx, {
    code,
    language: document.languageId,
    fileName: document.fileName,
    document,
    lineOffset: selection.isEmpty ? 0 : selection.start.line,
    progressLabel: 'Analyzing your code…',
  });
}

/**
 * Reviews a whole file by URI, which is how the explorer and editor-title menus
 * call in. Falls back to the active editor when invoked without an argument.
 */
export async function reviewFileCommand(ctx: ReviewContext, uri?: vscode.Uri): Promise<void> {
  const targetUri = uri ?? vscode.window.activeTextEditor?.document.uri;

  if (targetUri === undefined) {
    vscode.window.showWarningMessage('CodeSage AI: No file selected. Open or select a file to review.');
    return;
  }

  let document: vscode.TextDocument;
  try {
    document = await vscode.workspace.openTextDocument(targetUri);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`CodeSage AI: could not open ${targetUri.fsPath}: ${message}`);
    return;
  }

  const code = document.getText();
  if (!code.trim()) {
    vscode.window.showWarningMessage('CodeSage AI: That file is empty.');
    return;
  }

  await executeReview(ctx, {
    code,
    language: document.languageId,
    fileName: document.fileName,
    document,
    lineOffset: 0,
    progressLabel: `Reviewing ${baseName(document.fileName)}…`,
  });
}

/**
 * Reviews uncommitted git changes (staged and unstaged) in the workspace
 * folder of the active file, or the first workspace folder.
 */
export async function reviewChangesCommand(ctx: ReviewContext): Promise<void> {
  const folder = pickWorkspaceFolder();

  if (folder === undefined) {
    vscode.window.showWarningMessage('CodeSage AI: Open a folder that is a git repository to review changes.');
    return;
  }

  let diff: string;
  try {
    diff = await readGitDiff(folder.uri.fsPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.outputChannel.appendLine(`[Changes] git diff failed in ${folder.uri.fsPath}: ${message}`);
    vscode.window.showErrorMessage(`CodeSage AI: could not read git changes — ${message}`);
    return;
  }

  if (!diff.trim()) {
    vscode.window.showInformationMessage('CodeSage AI: No uncommitted changes to review.');
    return;
  }

  await executeReview(ctx, {
    code: diff,
    language: 'diff',
    fileName: `${folder.name} (uncommitted changes)`,
    progressLabel: 'Reviewing uncommitted changes…',
  });
}

/**
 * The single path every review takes: pool check, streaming or one-shot call,
 * panel, diagnostics, status bar, history. Commands only decide what to send.
 */
export async function executeReview(ctx: ReviewContext, target: ReviewTarget): Promise<ReviewResponse | undefined> {
  const { context, outputChannel, diagnosticsProvider, statusBar, ledger, history } = ctx;

  const config = getConfig();
  const service = await createReviewService(context.secrets, config, ledger, outputChannel);

  if (!(await ensurePoolReady(service, config))) {
    return undefined;
  }

  statusBar.setReviewing();
  history.setBusy(true);

  try {
    return await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'CodeSage AI',
        cancellable: true,
      },
      async (progress, token) => {
        progress.report({ message: target.progressLabel });
        const request = { code: target.code, language: target.language, fileName: target.fileName };

        let streamPanel: ReviewPanel | undefined;

        try {
          let response: ReviewResponse;

          if (config.enableStreaming) {
            streamPanel = ReviewPanel.showStreaming(context.extensionUri, target.fileName, target.language);

            response = await service.reviewStream(
              request,
              (partial) => {
                streamPanel?.updateStream(partial);
                progress.report({ message: 'Receiving review…' });
              },
              token
            );

            streamPanel.finalize(response, target.fileName, target.language);
          } else {
            response = await service.review(request, token);
            ReviewPanel.show(context.extensionUri, response, target.fileName, target.language);
          }

          if (target.document !== undefined && response.issues.length > 0) {
            const offset = target.lineOffset ?? 0;
            const issues = offset === 0
              ? response.issues
              : response.issues.map((issue) => ({
                ...issue,
                line: issue.line + offset,
                endLine: issue.endLine !== undefined ? issue.endLine + offset : undefined,
              }));
            diagnosticsProvider.setDiagnostics(target.document.uri, issues, target.document);
          }

          history.record(target.fileName, target.language, target.document?.uri, response);
          statusBar.setIdle();
          outputChannel.appendLine(
            `Review completed: ${target.fileName} — ${response.issues.length} issues, ${response.tokensUsed} tokens, ${(response.duration / 1000).toFixed(1)}s via ${response.routeLabel ?? response.model} (attempt ${response.attempts ?? 1})`
          );
          return response;
        } catch (error) {
          statusBar.setError();
          if (token.isCancellationRequested) {
            streamPanel?.showError('Review cancelled.');
            statusBar.setIdle();
            return undefined;
          }
          const message = error instanceof Error ? error.message : 'An unknown error occurred.';
          streamPanel?.showError(message);
          outputChannel.appendLine(`Error: ${message}`);
          vscode.window.showErrorMessage(`CodeSage AI: ${message}`);
          return undefined;
        }
      }
    );
  } finally {
    history.setBusy(false);
  }
}

function pickWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  const activeUri = vscode.window.activeTextEditor?.document.uri;

  if (activeUri !== undefined) {
    const owning = vscode.workspace.getWorkspaceFolder(activeUri);
    if (owning !== undefined) {
      return owning;
    }
  }

  return vscode.workspace.workspaceFolders?.[0];
}

/** Uncommitted changes against HEAD; falls back to staged-only for a repo with no commits yet. */
function readGitDiff(cwd: string): Promise<string> {
  const run = (args: string[]) =>
    new Promise<string>((resolve, reject) => {
      execFile('git', args, { cwd, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }
        resolve(stdout);
      });
    });

  return run(['diff', 'HEAD', '--no-color', '--no-ext-diff']).catch(() =>
    run(['diff', '--cached', '--no-color', '--no-ext-diff'])
  );
}

function baseName(fileName: string): string {
  return fileName.split(/[/\\]/).pop() || fileName;
}
