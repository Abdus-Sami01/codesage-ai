import * as vscode from 'vscode';
import { reviewCodeCommand } from './commands/reviewCode';
import { reviewFunctionCommand } from './commands/reviewFunction';
import { setApiKey } from './config';
import { DiagnosticsProvider } from './providers/diagnosticsProvider';
import { ReviewCodeLensProvider } from './providers/codeLensProvider';
import { StatusBar } from './statusBar';

/**
 * Called when the extension is activated.
 */
export function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel('CodeSage AI');
  outputChannel.appendLine('CodeSage AI activated.');

  // ── Core providers ──
  const diagnosticsProvider = new DiagnosticsProvider();
  const codeLensProvider = new ReviewCodeLensProvider();
  const statusBar = new StatusBar();

  // ── Register CodeLens provider for all languages ──
  const codeLensDisposable = vscode.languages.registerCodeLensProvider(
    { scheme: 'file' },
    codeLensProvider
  );

  // ── Register CodeAction provider for quick fixes ──
  const codeActionDisposable = vscode.languages.registerCodeActionsProvider(
    { scheme: 'file' },
    diagnosticsProvider,
    {
      providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
    }
  );

  // ── Commands ──
  const reviewDisposable = vscode.commands.registerCommand(
    'codesage-ai.reviewCode',
    () => reviewCodeCommand(context, outputChannel, diagnosticsProvider, statusBar)
  );

  const reviewFunctionDisposable = vscode.commands.registerCommand(
    'codesage-ai.reviewFunction',
    (uri: vscode.Uri, range: vscode.Range, symbolName: string) =>
      reviewFunctionCommand(context, outputChannel, diagnosticsProvider, statusBar, uri, range, symbolName)
  );

  const apiKeyDisposable = vscode.commands.registerCommand(
    'codesage-ai.setApiKey',
    async () => {
      const key = await vscode.window.showInputBox({
        prompt: 'Enter your HuggingFace API Key',
        password: true,
        placeHolder: 'hf_...',
        ignoreFocusOut: true,
        validateInput: (value) => {
          if (!value || !value.trim()) return 'API key cannot be empty.';
          if (!value.startsWith('hf_')) return 'HuggingFace API keys typically start with "hf_".';
          return null;
        },
      });
      if (key) {
        await setApiKey(context.secrets, key);
        vscode.window.showInformationMessage('CodeSage AI: API key saved securely.');
      }
    }
  );

  const selectProfileDisposable = vscode.commands.registerCommand(
    'codesage-ai.selectProfile',
    () => statusBar.showProfilePicker()
  );

  const dismissDiagnosticDisposable = vscode.commands.registerCommand(
    'codesage-ai.dismissDiagnostic',
    (uri: vscode.Uri, diagnostic: vscode.Diagnostic) =>
      diagnosticsProvider.dismissDiagnostic(uri, diagnostic)
  );

  // ── Clear diagnostics when files are closed ──
  const closeListener = vscode.workspace.onDidCloseTextDocument((doc) => {
    diagnosticsProvider.clearDiagnostics(doc.uri);
  });

  // ── Push all disposables ──
  context.subscriptions.push(
    outputChannel,
    codeLensDisposable,
    codeActionDisposable,
    reviewDisposable,
    reviewFunctionDisposable,
    apiKeyDisposable,
    selectProfileDisposable,
    dismissDiagnosticDisposable,
    closeListener,
    { dispose: () => diagnosticsProvider.dispose() },
    { dispose: () => codeLensProvider.dispose() },
    { dispose: () => statusBar.dispose() },
  );
}

/**
 * Called when the extension is deactivated.
 */
export function deactivate() {}
