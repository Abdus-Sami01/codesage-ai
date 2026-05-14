import * as vscode from 'vscode';
import { getApiKey, getConfig } from '../config';
import { ReviewService } from '../services/reviewService';
import { ReviewPanel } from '../panels/reviewPanel';
import { DiagnosticsProvider } from '../providers/diagnosticsProvider';
import { StatusBar } from '../statusBar';

/**
 * Handles the "CodeSage: Review Code" command.
 * Captures the active editor content (or selection), sends it for AI review,
 * displays results in a Webview panel, and sets inline diagnostics.
 * Supports both streaming and non-streaming modes.
 */
export async function reviewCodeCommand(
  context: vscode.ExtensionContext,
  outputChannel: vscode.OutputChannel,
  diagnosticsProvider: DiagnosticsProvider,
  statusBar: StatusBar
): Promise<void> {
  // 1. Validate active editor
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('CodeSage AI: No active editor. Open a file to review.');
    return;
  }

  // 2. Get code — use selection if present, otherwise entire file
  const document = editor.document;
  const selection = editor.selection;
  const code = selection.isEmpty ? document.getText() : document.getText(selection);

  if (!code.trim()) {
    vscode.window.showWarningMessage('CodeSage AI: No code to review.');
    return;
  }

  // 3. Ensure API key is configured
  const apiKey = await getApiKey(context.secrets);
  if (!apiKey) {
    const action = await vscode.window.showWarningMessage(
      'CodeSage AI: No API key configured. Set your HuggingFace API key to get started.',
      'Set API Key'
    );
    if (action === 'Set API Key') {
      vscode.commands.executeCommand('codesage-ai.setApiKey');
    }
    return;
  }

  // 4. Run review
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
      progress.report({ message: 'Analyzing your code…' });

      try {
        let response;

        if (config.enableStreaming) {
          // Streaming mode — show incremental updates
          const streamPanel = ReviewPanel.showStreaming(
            context.extensionUri,
            document.fileName,
            document.languageId
          );

          response = await service.reviewStream(
            { code, language: document.languageId, fileName: document.fileName },
            (partial) => {
              streamPanel.updateStream(partial);
              progress.report({ message: 'Receiving review…' });
            },
            token
          );

          // Finalize with full metadata
          streamPanel.finalize(response, document.fileName, document.languageId);
        } else {
          // Non-streaming mode
          response = await service.review(
            { code, language: document.languageId, fileName: document.fileName },
            token
          );

          ReviewPanel.show(
            context.extensionUri,
            response,
            document.fileName,
            document.languageId
          );
        }

        // Set inline diagnostics
        if (response.issues.length > 0) {
          diagnosticsProvider.setDiagnostics(document.uri, response.issues, document);
        }

        statusBar.setIdle();
        outputChannel.appendLine(
          `Review completed: ${document.fileName} — ${response.issues.length} issues, ${response.tokensUsed} tokens, ${(response.duration / 1000).toFixed(1)}s`
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
