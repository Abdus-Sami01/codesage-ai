import * as vscode from 'vscode';
import { reviewCodeCommand } from './commands/reviewCode';
import { reviewFunctionCommand } from './commands/reviewFunction';
import {
  manageKeysCommand,
  selectModelCommand,
  setApiKeyCommand,
  showPoolCommand,
} from './commands/configure';
import { DiagnosticsProvider } from './providers/diagnosticsProvider';
import { ReviewCodeLensProvider } from './providers/codeLensProvider';
import { QuotaLedger, SlotRecord } from './services/rotation';
import { StatusBar } from './statusBar';

/** Where the rotation pool's pauses are persisted between windows. */
const LEDGER_STATE_KEY = 'codesage-ai.quotaLedger';

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

  // A daily quota outlives a window reload, so the ledger is backed by global
  // state rather than kept in memory with the service that consults it.
  const ledger = new QuotaLedger({
    read: () => context.globalState.get<Record<string, SlotRecord>>(LEDGER_STATE_KEY),
    write: (records) => {
      void context.globalState.update(LEDGER_STATE_KEY, records);
    },
  });

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
    () => reviewCodeCommand(context, outputChannel, diagnosticsProvider, statusBar, ledger)
  );

  const reviewFunctionDisposable = vscode.commands.registerCommand(
    'codesage-ai.reviewFunction',
    (uri: vscode.Uri, range: vscode.Range, symbolName: string) =>
      reviewFunctionCommand(context, outputChannel, diagnosticsProvider, statusBar, ledger, uri, range, symbolName)
  );

  const apiKeyDisposable = vscode.commands.registerCommand(
    'codesage-ai.setApiKey',
    () => setApiKeyCommand(context)
  );

  const manageKeysDisposable = vscode.commands.registerCommand(
    'codesage-ai.manageKeys',
    () => manageKeysCommand(context)
  );

  const selectModelDisposable = vscode.commands.registerCommand(
    'codesage-ai.selectModel',
    () => selectModelCommand(context, outputChannel, ledger)
  );

  const showPoolDisposable = vscode.commands.registerCommand(
    'codesage-ai.showPool',
    () => showPoolCommand(context, outputChannel, ledger)
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
    manageKeysDisposable,
    selectModelDisposable,
    showPoolDisposable,
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
