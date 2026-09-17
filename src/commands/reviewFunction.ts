import * as vscode from 'vscode';
import { getConfig } from '../config';
import { createReviewService } from '../services/reviewService';
import { QuotaLedger } from '../services/rotation';
import { ensurePoolReady } from './configure';
import { ReviewPanel } from '../panels/reviewPanel';
import { DiagnosticsProvider } from '../providers/diagnosticsProvider';
import { StatusBar } from '../statusBar';

/**
 * Handles the "CodeSage: Review Function" command triggered by CodeLens.
 * Reviews a specific function/method/class instead of the entire file.
 */
export async function reviewFunctionCommand(
  context: vscode.ExtensionContext,
  outputChannel: vscode.OutputChannel,
  diagnosticsProvider: DiagnosticsProvider,
  statusBar: StatusBar,
  ledger: QuotaLedger,
  uri: vscode.Uri,
  range: vscode.Range,
  symbolName: string
): Promise<void> {
  const document = await vscode.workspace.openTextDocument(uri);
  const code = document.getText(range);

  if (!code.trim()) {
    vscode.window.showWarningMessage('CodeSage AI: Selected function is empty.');
    return;
  }

  const config = getConfig();
  const service = await createReviewService(context.secrets, config, ledger, outputChannel);

  if (!(await ensurePoolReady(service, config))) {
    return;
  }

  statusBar.setReviewing();

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'CodeSage AI',
      cancellable: true,
    },
    async (progress, token) => {
      progress.report({ message: `Reviewing "${symbolName}"…` });

      try {
        let response;

        if (config.enableStreaming) {
          const streamPanel = ReviewPanel.showStreaming(
            context.extensionUri,
            document.fileName,
            document.languageId
          );

          response = await service.reviewStream(
            { code, language: document.languageId, fileName: document.fileName },
            (partial) => {
              streamPanel.updateStream(partial);
              progress.report({ message: `Receiving review of "${symbolName}"…` });
            },
            token
          );

          streamPanel.finalize(response, document.fileName, document.languageId);
        } else {
          response = await service.review(
            {
              code,
              language: document.languageId,
              fileName: document.fileName,
            },
            token
          );

          ReviewPanel.show(
            context.extensionUri,
            response,
            document.fileName,
            document.languageId
          );
        }

        // Set inline diagnostics — adjust line numbers relative to function start
        if (response.issues.length > 0) {
          const adjustedIssues = response.issues.map((issue) => ({
            ...issue,
            line: issue.line + range.start.line,
            endLine: issue.endLine ? issue.endLine + range.start.line : undefined,
          }));
          diagnosticsProvider.setDiagnostics(uri, adjustedIssues, document);
        }

        statusBar.setIdle();
        outputChannel.appendLine(
          `Function review completed: ${symbolName} (${response.tokensUsed} tokens, ${(response.duration / 1000).toFixed(1)}s via ${response.routeLabel ?? response.model})`
        );
      } catch (error) {
        statusBar.setError();
        if (token.isCancellationRequested) {
          statusBar.setIdle();
          return;
        }
        const message = error instanceof Error ? error.message : 'An unknown error occurred.';
        outputChannel.appendLine(`Error: ${message}`);
        vscode.window.showErrorMessage(`CodeSage AI: ${message}`);
      }
    }
  );
}
