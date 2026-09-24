import * as vscode from 'vscode';
import {
  ReviewContext,
  reviewChangesCommand,
  reviewCodeCommand,
  reviewFileCommand,
} from './commands/reviewCode';
import { reviewFunctionCommand } from './commands/reviewFunction';
import {
  manageKeysCommand,
  selectModelCommand,
  setApiKeyCommand,
  showPoolCommand,
} from './commands/configure';
import { getConfig } from './config';
import { ReviewHistory, SidebarProvider } from './panels/sidebarProvider';
import { DiagnosticsProvider } from './providers/diagnosticsProvider';
import { ReviewCodeLensProvider } from './providers/codeLensProvider';
import { createReviewService } from './services/reviewService';
import { QuotaLedger, SlotRecord } from './services/rotation';
import { StatusBar } from './statusBar';

/** Where the rotation pool's pauses are persisted between windows. */
const LEDGER_STATE_KEY = 'codesage-ai.quotaLedger';

/** Set once the first-run setup prompt has been shown, so it never nags twice. */
const ONBOARDED_STATE_KEY = 'codesage-ai.onboarded';

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
  const history = new ReviewHistory(context.workspaceState);

  // A daily quota outlives a window reload, so the ledger is backed by global
  // state rather than kept in memory with the service that consults it.
  const ledger = new QuotaLedger({
    read: () => context.globalState.get<Record<string, SlotRecord>>(LEDGER_STATE_KEY),
    write: (records) => {
      void context.globalState.update(LEDGER_STATE_KEY, records);
    },
  });

  const reviewContext: ReviewContext = {
    context,
    outputChannel,
    diagnosticsProvider,
    statusBar,
    ledger,
    history,
  };

  // ── Sidebar ──
  const sidebar = new SidebarProvider(context, outputChannel, ledger, history);
  const sidebarDisposable = vscode.window.registerWebviewViewProvider(SidebarProvider.viewId, sidebar, {
    webviewOptions: { retainContextWhenHidden: true },
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
  const commandDisposables = [
    vscode.commands.registerCommand('codesage-ai.reviewCode', () => reviewCodeCommand(reviewContext)),
    vscode.commands.registerCommand('codesage-ai.reviewFile', (uri?: vscode.Uri) =>
      reviewFileCommand(reviewContext, uri instanceof vscode.Uri ? uri : undefined)
    ),
    vscode.commands.registerCommand('codesage-ai.reviewChanges', () => reviewChangesCommand(reviewContext)),
    vscode.commands.registerCommand(
      'codesage-ai.reviewFunction',
      (uri: vscode.Uri, range: vscode.Range, symbolName: string) =>
        reviewFunctionCommand(reviewContext, uri, range, symbolName)
    ),
    vscode.commands.registerCommand('codesage-ai.setApiKey', () => setApiKeyCommand(context)),
    vscode.commands.registerCommand('codesage-ai.manageKeys', () => manageKeysCommand(context)),
    vscode.commands.registerCommand('codesage-ai.selectModel', () => selectModelCommand(context, outputChannel, ledger)),
    vscode.commands.registerCommand('codesage-ai.showPool', () => showPoolCommand(context, outputChannel, ledger)),
    vscode.commands.registerCommand('codesage-ai.selectProfile', () => statusBar.showProfilePicker()),
    vscode.commands.registerCommand('codesage-ai.openSidebar', () => sidebar.reveal()),
    vscode.commands.registerCommand(
      'codesage-ai.dismissDiagnostic',
      (uri: vscode.Uri, diagnostic: vscode.Diagnostic) => diagnosticsProvider.dismissDiagnostic(uri, diagnostic)
    ),
  ];

  // ── Clear diagnostics when files are closed ──
  const closeListener = vscode.workspace.onDidCloseTextDocument((doc) => {
    diagnosticsProvider.clearDiagnostics(doc.uri);
  });

  // ── Push all disposables ──
  context.subscriptions.push(
    outputChannel,
    sidebarDisposable,
    codeLensDisposable,
    codeActionDisposable,
    ...commandDisposables,
    closeListener,
    { dispose: () => diagnosticsProvider.dispose() },
    { dispose: () => codeLensProvider.dispose() },
    { dispose: () => statusBar.dispose() },
    { dispose: () => sidebar.dispose() },
    { dispose: () => history.dispose() },
  );

  void offerFirstRunSetup(context, reviewContext);
}

/**
 * Opens the sidebar once for a user who has nothing configured, instead of
 * letting their first review fail with a missing-key error.
 */
async function offerFirstRunSetup(context: vscode.ExtensionContext, ctx: ReviewContext): Promise<void> {
  if (context.globalState.get<boolean>(ONBOARDED_STATE_KEY, false)) {
    return;
  }

  const service = await createReviewService(context.secrets, getConfig(), ctx.ledger, ctx.outputChannel);
  await context.globalState.update(ONBOARDED_STATE_KEY, true);

  if (service.poolSize > 0) {
    return;
  }

  const action = await vscode.window.showInformationMessage(
    'CodeSage AI needs a model provider before the first review. It takes about a minute.',
    'Set Up',
    'Later'
  );

  if (action === 'Set Up') {
    await vscode.commands.executeCommand('codesage-ai.openSidebar');
  }
}

/**
 * Called when the extension is deactivated.
 */
export function deactivate() {}
