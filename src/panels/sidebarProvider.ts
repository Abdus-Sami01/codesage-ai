import * as vscode from 'vscode';
import {
  addPooledKey,
  getConfig,
  getKeyPool,
  removePooledKey,
  resolveBaseUrl,
  setApiKey,
} from '../config';
import { PROVIDER_LABELS } from '../commands/configure';
import { PROFILES } from '../profiles';
import { ModelDescriptor, createReviewService } from '../services/reviewService';
import { QuotaLedger, maskKey } from '../services/rotation';
import { ProviderPreset, ReviewResponse } from '../types';
import { ReviewPanel } from './reviewPanel';

const CONFIG_SECTION = 'codesage-ai';
const HISTORY_STATE_KEY = 'codesage-ai.reviewHistory';
const HISTORY_LIMIT = 30;
const CATALOG_TIMEOUT_MS = 20_000;

/** Where each preset's key comes from, shown next to the key box during setup. */
const KEY_SOURCES: Record<ProviderPreset, string> = {
  openrouter: 'Free account at openrouter.ai/keys — the "openrouter/free" model costs nothing.',
  openai: 'platform.openai.com/api-keys',
  ollama: 'No key needed. Ollama runs locally.',
  omniroute: 'Create a key in your OmniRoute dashboard. Local gateways work without one.',
  custom: 'Whatever token your endpoint expects.',
};

/** One finished review, persisted per workspace so it can be reopened later. */
export interface HistoryEntry {
  id: string;
  fileName: string;
  language: string;
  uri?: string;
  time: number;
  response: ReviewResponse;
}

/**
 * Per-workspace log of finished reviews.
 *
 * Every review path records here, which is what lets the sidebar list them and
 * reopen one without calling the model again.
 */
export class ReviewHistory {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;
  private busy = false;

  constructor(private readonly state: vscode.Memento) {}

  get entries(): HistoryEntry[] {
    return this.state.get<HistoryEntry[]>(HISTORY_STATE_KEY, []);
  }

  get isBusy(): boolean {
    return this.busy;
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
    this.changeEmitter.fire();
  }

  record(fileName: string, language: string, uri: vscode.Uri | undefined, response: ReviewResponse): void {
    const entry: HistoryEntry = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      fileName,
      language,
      uri: uri?.toString(),
      time: Date.now(),
      response,
    };

    void this.state.update(HISTORY_STATE_KEY, [entry, ...this.entries].slice(0, HISTORY_LIMIT));
    this.changeEmitter.fire();
  }

  find(id: string): HistoryEntry | undefined {
    return this.entries.find((entry) => entry.id === id);
  }

  async clear(): Promise<void> {
    await this.state.update(HISTORY_STATE_KEY, []);
    this.changeEmitter.fire();
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}

/** Messages the webview sends. Anything not listed here is ignored. */
type InboundMessage =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'saveConnection'; provider: string; baseUrl: string }
  | { type: 'addKey'; provider: string; key: string }
  | { type: 'removeKey'; provider: string; index: number }
  | { type: 'test' }
  | { type: 'loadModels' }
  | { type: 'setModel'; model: string }
  | { type: 'addFallback'; model: string; tier: number }
  | { type: 'setProfile'; profile: string }
  | { type: 'review'; kind: 'file' | 'selection' | 'changes' }
  | { type: 'clearPauses' }
  | { type: 'openHistory'; id: string }
  | { type: 'clearHistory' }
  | { type: 'openSettings' };

/**
 * The CodeSage activity-bar view: setup, model choice, review actions, pool
 * health and history in one place, so nothing requires the Command Palette.
 *
 * Every action delegates to the same config helpers and commands the palette
 * uses, so the two surfaces can never disagree about state.
 */
export class SidebarProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'codesage-ai.sidebar';

  private view: vscode.WebviewView | undefined;
  private models: ModelDescriptor[] = [];
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly outputChannel: vscode.OutputChannel,
    private readonly ledger: QuotaLedger,
    private readonly history: ReviewHistory
  ) {
    this.disposables.push(
      history.onDidChange(() => void this.postState()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(CONFIG_SECTION)) {
          void this.postState();
        }
      }),
      context.secrets.onDidChange(() => void this.postState())
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    view.webview.html = this.renderShell(view.webview);

    view.webview.onDidReceiveMessage(
      (message: InboundMessage) => void this.handle(message),
      undefined,
      this.disposables
    );

    view.onDidChangeVisibility(() => {
      if (view.visible) {
        void this.postState();
      }
    }, undefined, this.disposables);
  }

  /** Brings the view forward, used by the walkthrough and first-run prompts. */
  async reveal(): Promise<void> {
    await vscode.commands.executeCommand(`${SidebarProvider.viewId}.focus`);
  }

  dispose(): void {
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
  }

  private async handle(message: InboundMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'ready':
        case 'refresh':
          await this.postState();
          return;
        case 'saveConnection':
          await this.saveConnection(message.provider, message.baseUrl);
          return;
        case 'addKey':
          await this.addKey(message.provider, message.key);
          return;
        case 'removeKey':
          await this.removeKey(message.provider, message.index);
          return;
        case 'test':
          await this.loadCatalog(true);
          return;
        case 'loadModels':
          await this.loadCatalog(false);
          return;
        case 'setModel':
          await this.settings().update('model', message.model, vscode.ConfigurationTarget.Global);
          this.notice(`Now reviewing with ${message.model}.`, 'ok');
          return;
        case 'addFallback':
          await this.addFallback(message.model, message.tier);
          return;
        case 'setProfile':
          if (PROFILES[message.profile] !== undefined) {
            await this.settings().update('reviewProfile', message.profile, vscode.ConfigurationTarget.Global);
          }
          return;
        case 'review':
          await this.runReview(message.kind);
          return;
        case 'clearPauses':
          this.ledger.reset();
          this.notice('Every route is marked live again.', 'ok');
          await this.postState();
          return;
        case 'openHistory':
          this.openHistory(message.id);
          return;
        case 'clearHistory':
          await this.history.clear();
          return;
        case 'openSettings':
          await vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${this.context.extension.id}`);
          return;
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.outputChannel.appendLine(`[Sidebar] ${message.type} failed: ${text}`);
      this.notice(text, 'error');
    }
  }

  private async saveConnection(provider: string, baseUrl: string): Promise<void> {
    if (!(provider in PROVIDER_LABELS)) {
      this.notice(`Unknown provider "${provider}".`, 'error');
      return;
    }

    const trimmed = baseUrl.trim();
    if (trimmed.length > 0 && !/^https?:\/\/[^\s]+$/i.test(trimmed)) {
      this.notice('Base URL has to start with http:// or https://.', 'error');
      return;
    }

    const settings = this.settings();
    await settings.update('provider', provider, vscode.ConfigurationTarget.Global);
    // An empty box means "use the preset", which is expressed by removing the override.
    await settings.update('baseUrl', trimmed.length > 0 ? trimmed : undefined, vscode.ConfigurationTarget.Global);

    this.models = [];
    this.notice(`Connection saved: ${PROVIDER_LABELS[provider as ProviderPreset]}.`, 'ok');
    await this.postState();
  }

  private async addKey(provider: string, key: string): Promise<void> {
    const trimmed = key.trim();
    if (!(provider in PROVIDER_LABELS) || trimmed.length === 0) {
      this.notice('Paste a key first.', 'error');
      return;
    }

    const added = await addPooledKey(this.context.secrets, provider, trimmed);

    // Mirrors the palette command so the legacy single-key slot stays in step.
    if (provider === getConfig().provider) {
      await setApiKey(this.context.secrets, trimmed);
    }

    this.notice(added ? 'Key saved to VS Code secret storage.' : 'That key is already saved.', added ? 'ok' : 'info');
    await this.postState();
  }

  private async removeKey(provider: string, index: number): Promise<void> {
    const pool = await getKeyPool(this.context.secrets);
    const key = pool[provider]?.[index];

    if (key === undefined) {
      await this.postState();
      return;
    }

    const confirmation = await vscode.window.showWarningMessage(
      `Remove ${maskKey(key)} from ${PROVIDER_LABELS[provider as ProviderPreset] ?? provider}?`,
      { modal: true },
      'Remove'
    );

    if (confirmation === 'Remove') {
      await removePooledKey(this.context.secrets, provider, key);
      this.notice('Key removed.', 'ok');
    }

    await this.postState();
  }

  /** Fetches the live catalog. As a connection test it reports; as a loader it fills the picker. */
  private async loadCatalog(asTest: boolean): Promise<void> {
    const config = getConfig();
    const service = await createReviewService(this.context.secrets, config, this.ledger, this.outputChannel);

    if (service.poolSize === 0) {
      const reason = config.invalidRoutes.length > 0
        ? config.invalidRoutes.join(' ')
        : `No key saved for ${PROVIDER_LABELS[config.provider]}. Add one above.`;
      this.notice(reason, 'error');
      return;
    }

    this.post({ type: 'loading', what: asTest ? 'test' : 'models' });
    const source = new vscode.CancellationTokenSource();
    const timer = setTimeout(() => source.cancel(), CATALOG_TIMEOUT_MS);

    try {
      const models = await service.listModels(source.token);
      this.models = models;

      if (!asTest && models.length === 0) {
        this.notice(
          config.provider === 'omniroute'
            ? 'OmniRoute answered but has no models. Connect at least one provider in the OmniRoute dashboard.'
            : 'The provider answered with an empty model list.',
          'error'
        );
      }

      if (asTest) {
        const hasCurrent = models.some((model) => model.id === config.model);
        this.notice(
          models.length === 0
            ? (config.provider === 'omniroute'
              ? 'Connected to OmniRoute, but it has no providers behind it yet. Connect one in the OmniRoute dashboard.'
              : 'Connected, but the provider listed no models.')
            : `Connected. ${models.length} models available.${hasCurrent || models.length === 0 ? '' : ` "${config.model}" is not one of them — pick a model below.`}`,
          models.length === 0 ? 'error' : (hasCurrent ? 'ok' : 'info')
        );
      }
    } catch (error) {
      const text = source.token.isCancellationRequested
        ? `No answer from ${config.baseUrl} within ${CATALOG_TIMEOUT_MS / 1000}s.`
        : (error instanceof Error ? error.message : String(error));
      this.outputChannel.appendLine(`[Sidebar] catalog: ${text}`);
      this.notice(`Connection failed: ${text}`, 'error');
    } finally {
      clearTimeout(timer);
      source.dispose();
      this.post({ type: 'loading', what: null });
      await this.postState();
    }
  }

  private async addFallback(model: string, tier: number): Promise<void> {
    const config = getConfig();
    const settings = this.settings();
    const existing = settings.get<Record<string, unknown>[]>('routes', []);
    const safeTier = Number.isFinite(tier) ? Math.max(1, Math.min(9, Math.floor(tier))) : 2;

    if (existing.some((route) => route.model === model && (route.provider ?? config.provider) === config.provider)) {
      this.notice(`${model} is already in the rotation pool.`, 'info');
      return;
    }

    // Seeding the primary keeps the model already in use when the pool is first created.
    const seeded = existing.length === 0 && config.model !== model
      ? [{ model: config.model, provider: config.provider, tier: 1 }]
      : [];

    await settings.update(
      'routes',
      [...seeded, ...existing, { model, provider: config.provider, tier: safeTier }],
      vscode.ConfigurationTarget.Global
    );
    this.notice(`${model} added to the pool at tier ${safeTier}.`, 'ok');
  }

  private async runReview(kind: 'file' | 'selection' | 'changes'): Promise<void> {
    const command = kind === 'changes'
      ? 'codesage-ai.reviewChanges'
      : kind === 'file' ? 'codesage-ai.reviewFile' : 'codesage-ai.reviewCode';

    if (kind !== 'changes' && vscode.window.activeTextEditor === undefined) {
      this.notice('Open a file in the editor first.', 'error');
      return;
    }

    if (kind === 'selection' && vscode.window.activeTextEditor?.selection.isEmpty) {
      this.notice('Nothing is selected, so the whole file will be reviewed.', 'info');
    }

    await vscode.commands.executeCommand(command);
  }

  private openHistory(id: string): void {
    const entry = this.history.find(id);
    if (entry === undefined) {
      return;
    }

    ReviewPanel.show(this.context.extensionUri, entry.response, entry.fileName, entry.language);

    if (entry.uri !== undefined) {
      void vscode.window.showTextDocument(vscode.Uri.parse(entry.uri), {
        viewColumn: vscode.ViewColumn.One,
        preserveFocus: true,
        preview: true,
      }).then(undefined, () => undefined);
    }
  }

  private async postState(): Promise<void> {
    if (this.view === undefined) {
      return;
    }

    const config = getConfig();
    const pool = await getKeyPool(this.context.secrets);
    const service = await createReviewService(this.context.secrets, config, this.ledger, this.outputChannel);
    const now = Date.now();

    const keys = Object.entries(pool).flatMap(([provider, list]) =>
      list.map((key, index) => ({
        provider,
        providerLabel: PROVIDER_LABELS[provider as ProviderPreset] ?? provider,
        index,
        masked: maskKey(key),
      }))
    );

    this.post({
      type: 'state',
      state: {
        provider: config.provider,
        baseUrl: this.settings().get<string>('baseUrl', ''),
        presetBaseUrl: resolveBaseUrl(config.provider, ''),
        effectiveBaseUrl: config.baseUrl,
        providers: (Object.keys(PROVIDER_LABELS) as ProviderPreset[]).map((id) => ({
          id,
          label: PROVIDER_LABELS[id],
          keySource: KEY_SOURCES[id],
          presetBaseUrl: resolveBaseUrl(id, ''),
        })),
        keys,
        model: config.model,
        models: this.models.map((model) => ({
          id: model.id,
          free: model.id.endsWith(':free') || model.id === 'openrouter/free',
          context: model.contextLength,
        })),
        profile: config.profile,
        profiles: Object.values(PROFILES).map((profile) => ({ id: profile.id, label: profile.label })),
        ready: service.poolSize > 0,
        invalidRoutes: config.invalidRoutes,
        busy: this.history.isBusy,
        pool: service.describePool().map((slot) => ({
          label: slot.routeLabel,
          key: slot.keyLabel,
          tier: slot.tier,
          state: slot.state,
          waitMs: slot.until !== null ? Math.max(0, slot.until - now) : null,
          reason: slot.reason,
        })),
        history: this.history.entries.map((entry) => ({
          id: entry.id,
          file: entry.fileName.split(/[/\\]/).pop() || entry.fileName,
          time: entry.time,
          issues: entry.response.issues.length,
          model: entry.response.model,
        })),
      },
    });
  }

  private notice(text: string, level: 'ok' | 'info' | 'error'): void {
    this.post({ type: 'notice', text, level });
  }

  private post(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }

  private settings(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration(CONFIG_SECTION);
  }

  private renderShell(webview: vscode.Webview): string {
    const nonce = makeNonce();

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
  body { padding: 0 12px 16px; overflow-x: hidden; min-width: 0; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
  h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; margin: 18px 0 8px; opacity: .85; display: flex; justify-content: space-between; align-items: center; }
  h2 .link { text-transform: none; letter-spacing: 0; }
  label { display: block; margin: 8px 0 4px; opacity: .9; }
  select, input { width: 100%; box-sizing: border-box; padding: 5px 6px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; font: inherit; }
  select:focus, input:focus { outline: 1px solid var(--vscode-focusBorder); }
  button { padding: 5px 10px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: none; border-radius: 2px; cursor: pointer; font: inherit; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: .5; cursor: default; }
  button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.full { width: 100%; margin-top: 6px; }
  .row { display: flex; gap: 6px; margin-top: 6px; }
  .row > * { flex: 1; min-width: 0; }
  .row > button { flex: 0 0 auto; }
  .row.even > button { flex: 1 1 0; min-width: 0; }
  .hint { font-size: 12px; opacity: .7; margin: 4px 0 0; }
  .card { padding: 8px 10px; border-radius: 3px; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border, transparent); }
  .status { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 8px; }
  .dot.live, .dot.in-flight, .dot.ready { background: var(--vscode-testing-iconPassed, #3fb950); }
  .dot.cooling, .dot.exhausted { background: var(--vscode-editorWarning-foreground, #d29922); }
  .dot.key-rejected, .dot.route-rejected, .dot.missing { background: var(--vscode-editorError-foreground, #f85149); }
  .list { list-style: none; padding: 0; margin: 0; }
  .list li { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 4px 0; border-bottom: 1px solid var(--vscode-widget-border, transparent); }
  .list li:last-child { border-bottom: none; }
  .list .grow { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .list .meta { font-size: 11px; opacity: .65; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 45%; }
  .list li.clickable { cursor: pointer; }
  .list li.clickable:hover { background: var(--vscode-list-hoverBackground); }
  .icon-btn { background: none; color: var(--vscode-foreground); padding: 0 4px; opacity: .7; }
  .icon-btn:hover { background: none; opacity: 1; }
  .link { background: none; color: var(--vscode-textLink-foreground); padding: 0; font-size: 12px; }
  .link:hover { background: none; text-decoration: underline; }
  .notice { background: var(--vscode-editorWidget-background); position: sticky; top: 0; z-index: 2; margin: 10px 0 0; overflow-wrap: anywhere; box-shadow: 0 2px 6px var(--vscode-widget-shadow, transparent); cursor: pointer; padding: 6px 8px; border-radius: 2px; font-size: 12px; border-left: 3px solid; }
  .notice.ok { border-color: var(--vscode-testing-iconPassed, #3fb950); }
  .notice.info { border-color: var(--vscode-editorInfo-foreground, #3794ff); }
  .notice.error { border-color: var(--vscode-editorError-foreground, #f85149); }
  .badge { font-size: 10px; padding: 1px 5px; border-radius: 8px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; }
  .grid button.wide { grid-column: span 2; }
  .hidden { display: none !important; }
  .empty { opacity: .6; font-size: 12px; padding: 4px 0; }
  .gap { margin-top: 6px; }
  .check { display: flex; gap: 6px; align-items: center; margin-top: 6px; }
  .check input { width: auto; }
  .footer { margin-top: 18px; }
</style>
</head>
<body>
  <div id="notice" class="notice hidden" title="Click to dismiss"></div>
  <div class="status card">
    <span class="dot missing" id="statusDot"></span>
    <div class="grow">
      <div id="statusText">Loading…</div>
      <div class="hint" id="statusModel"></div>
    </div>
  </div>

  <h2>Review</h2>
  <div class="grid">
    <button data-review="file">Current file</button>
    <button data-review="selection">Selection</button>
    <button data-review="changes" class="wide secondary">Uncommitted git changes</button>
  </div>
  <label for="profile">Focus</label>
  <select id="profile"></select>

  <h2>Connection</h2>
  <label for="provider">Provider</label>
  <select id="provider"></select>
  <label for="baseUrl">Endpoint</label>
  <input id="baseUrl" type="text" spellcheck="false" autocomplete="off">
  <p class="hint" id="baseUrlHint"></p>
  <div class="row even"><button id="saveConnection" class="secondary">Save</button><button id="test">Test</button></div>

  <label for="keyInput">API keys</label>
  <ul class="list" id="keys"></ul>
  <div class="row">
    <input id="keyInput" type="password" spellcheck="false" autocomplete="off" placeholder="Paste a key">
    <button id="addKey">Add</button>
  </div>
  <p class="hint" id="keySource"></p>

  <h2>Model <button class="link" id="loadModels">Load list</button></h2>
  <div class="card"><div class="grow" id="currentModel"></div></div>
  <div id="modelPicker" class="hidden">
    <input id="modelFilter" class="gap" type="text" placeholder="Filter models" spellcheck="false">
    <label class="check"><input id="freeOnly" type="checkbox"> Free only</label>
    <select id="models" class="gap" size="8"></select>
    <div class="row"><button id="useModel">Use</button><button id="fallbackModel" class="secondary">Add as fallback</button></div>
  </div>

  <h2>Rotation pool <button class="link" id="clearPauses">Clear pauses</button></h2>
  <ul class="list" id="pool"></ul>

  <h2>History <button class="link" id="clearHistory">Clear</button></h2>
  <ul class="list" id="history"></ul>

  <p class="footer"><button class="link" id="openSettings">All settings</button></p>

<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  let state = null;
  let noticeTimer = null;

  const el = (tag, props, children) => {
    const node = document.createElement(tag);
    Object.entries(props || {}).forEach(([key, value]) => {
      if (key === 'text') node.textContent = value;
      else if (key === 'className') node.className = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value);
    });
    (children || []).forEach((child) => node.appendChild(child));
    return node;
  };

  const send = (message) => vscode.postMessage(message);

  const formatWait = (ms) => {
    const s = Math.ceil(ms / 1000);
    if (s < 60) return s + 's';
    if (s < 3600) return Math.ceil(s / 60) + 'm';
    return (s / 3600).toFixed(1) + 'h';
  };

  const ago = (time) => {
    const s = Math.floor((Date.now() - time) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  };

  const showNotice = (text, level) => {
    const box = $('notice');
    box.textContent = text;
    box.className = 'notice ' + level;
    clearTimeout(noticeTimer);
    if (level !== 'error') noticeTimer = setTimeout(() => box.classList.add('hidden'), 6000);
  };

  const selectedProvider = () => state && state.providers.find((p) => p.id === $('provider').value);

  const renderProviderHints = () => {
    const provider = selectedProvider();
    if (!provider) return;
    $('baseUrl').placeholder = provider.presetBaseUrl || 'http://localhost:20128/v1';
    $('baseUrlHint').textContent = provider.presetBaseUrl
      ? 'Leave empty to use ' + provider.presetBaseUrl
      : 'Required for this provider, e.g. http://localhost:20128/v1';
    $('keySource').textContent = provider.keySource;
  };

  const renderModels = () => {
    const filter = $('modelFilter').value.trim().toLowerCase();
    const freeOnly = $('freeOnly').checked;
    const list = $('models');
    list.replaceChildren();
    state.models
      .filter((m) => (!freeOnly || m.free) && (!filter || m.id.toLowerCase().includes(filter)))
      .forEach((m) => {
        const extra = [m.free ? 'free' : '', m.context ? Math.round(m.context / 1000) + 'k ctx' : ''].filter(Boolean).join(' · ');
        list.appendChild(el('option', { value: m.id, text: m.id + (extra ? '   (' + extra + ')' : '') }));
      });
    if (state.models.some((m) => m.id === state.model)) list.value = state.model;
  };

  const render = () => {
    const s = state;

    $('statusDot').className = 'dot ' + (s.ready ? 'ready' : 'missing');
    $('statusText').textContent = s.busy ? 'Reviewing…' : (s.ready ? 'Ready' : 'Setup needed');
    $('statusModel').textContent = s.ready
      ? s.model + ' · ' + (s.providers.find((p) => p.id === s.provider) || {}).label
      : (s.invalidRoutes.length ? s.invalidRoutes.join(' ') : 'Pick a provider and add a key below.');
    document.querySelectorAll('[data-review]').forEach((button) => { button.disabled = s.busy; });

    const profile = $('profile');
    if (profile.options.length !== s.profiles.length) {
      profile.replaceChildren(...s.profiles.map((p) => el('option', { value: p.id, text: p.label })));
    }
    profile.value = s.profile;

    const provider = $('provider');
    if (provider.options.length !== s.providers.length) {
      provider.replaceChildren(...s.providers.map((p) => el('option', { value: p.id, text: p.label })));
    }
    if (document.activeElement !== provider) provider.value = s.provider;
    if (document.activeElement !== $('baseUrl')) $('baseUrl').value = s.baseUrl || '';
    renderProviderHints();

    const keys = $('keys');
    keys.replaceChildren();
    if (s.keys.length === 0) keys.appendChild(el('li', { className: 'empty', text: 'No keys saved yet.' }));
    s.keys.forEach((k) => keys.appendChild(el('li', {}, [
      el('span', { className: 'grow', text: k.masked }),
      el('span', { className: 'meta', text: k.providerLabel }),
      el('button', { className: 'icon-btn', title: 'Remove key', text: '✕', onclick: () => send({ type: 'removeKey', provider: k.provider, index: k.index }) }),
    ])));

    $('currentModel').textContent = s.model;
    $('modelPicker').classList.toggle('hidden', s.models.length === 0);
    if (s.models.length) renderModels();

    const pool = $('pool');
    pool.replaceChildren();
    if (s.pool.length === 0) pool.appendChild(el('li', { className: 'empty', text: 'Empty until a key or local endpoint is set.' }));
    s.pool.forEach((slot) => pool.appendChild(el('li', { title: slot.reason || slot.state }, [
      el('span', { className: 'dot ' + slot.state }),
      el('span', { className: 'grow', text: slot.label }),
      el('span', { className: 'meta', text: 'T' + slot.tier + (slot.waitMs !== null ? ' · ' + formatWait(slot.waitMs) : '') }),
    ])));

    const history = $('history');
    history.replaceChildren();
    if (s.history.length === 0) history.appendChild(el('li', { className: 'empty', text: 'Reviews you run show up here.' }));
    s.history.forEach((h) => history.appendChild(el('li', { className: 'clickable', title: h.model, onclick: () => send({ type: 'openHistory', id: h.id }) }, [
      el('span', { className: 'grow', text: h.file }),
      el('span', { className: 'badge', text: String(h.issues) }),
      el('span', { className: 'meta', text: ago(h.time) }),
    ])));
  };

  document.querySelectorAll('[data-review]').forEach((button) =>
    button.addEventListener('click', () => send({ type: 'review', kind: button.dataset.review })));
  $('profile').addEventListener('change', (e) => send({ type: 'setProfile', profile: e.target.value }));
  $('provider').addEventListener('change', renderProviderHints);
  $('saveConnection').addEventListener('click', () => send({ type: 'saveConnection', provider: $('provider').value, baseUrl: $('baseUrl').value }));
  $('test').addEventListener('click', () => send({ type: 'test' }));
  const addKey = () => {
    const key = $('keyInput').value;
    if (!key.trim()) return;
    send({ type: 'addKey', provider: $('provider').value, key });
    $('keyInput').value = '';
  };
  $('addKey').addEventListener('click', addKey);
  $('keyInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') addKey(); });
  $('loadModels').addEventListener('click', () => send({ type: 'loadModels' }));
  $('modelFilter').addEventListener('input', renderModels);
  $('freeOnly').addEventListener('change', renderModels);
  $('useModel').addEventListener('click', () => { if ($('models').value) send({ type: 'setModel', model: $('models').value }); });
  $('models').addEventListener('dblclick', () => { if ($('models').value) send({ type: 'setModel', model: $('models').value }); });
  $('fallbackModel').addEventListener('click', () => { if ($('models').value) send({ type: 'addFallback', model: $('models').value, tier: 2 }); });
  $('clearPauses').addEventListener('click', () => send({ type: 'clearPauses' }));
  $('clearHistory').addEventListener('click', () => send({ type: 'clearHistory' }));
  $('notice').addEventListener('click', () => $('notice').classList.add('hidden'));
  $('openSettings').addEventListener('click', () => send({ type: 'openSettings' }));

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'state') { state = message.state; render(); }
    else if (message.type === 'notice') showNotice(message.text, message.level);
    else if (message.type === 'loading') {
      $('test').disabled = message.what === 'test';
      $('loadModels').disabled = message.what === 'models';
      if (message.what) showNotice(message.what === 'test' ? 'Testing connection…' : 'Loading models…', 'info');
    }
  });

  send({ type: 'ready' });
})();
</script>
</body>
</html>`;
  }
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
