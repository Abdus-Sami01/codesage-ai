import * as vscode from 'vscode';
import { getApiKey, getConfig } from '../config';
import { ReviewService } from '../services/reviewService';
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

  const apiKey = await getApiKey(context.secrets);
  if (!apiKey) {
    const action = await vscode.window.showWarningMessage(
      'CodeSage AI: No API key configured.',
      'Set API Key'
    );
    if (action === 'Set API Key') {
      vscode.commands.executeCommand('codesage-ai.setApiKey');
    }
    return;
  }

  const config = getConfig();
  const service = new ReviewService(config, apiKey, context.extensionPath, outputChannel);

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
        const response = await service.review(
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
          `Function review completed: ${symbolName} (${response.tokensUsed} tokens, ${(response.duration / 1000).toFixed(1)}s)`
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
