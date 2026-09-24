import * as vscode from 'vscode';
import {
  addPooledKey,
  getConfig,
  getKeyPool,
  removePooledKey,
  setApiKey,
} from '../config';
import { ModelDescriptor, ReviewService, createReviewService } from '../services/reviewService';
import { QuotaLedger, formatDuration, maskKey } from '../services/rotation';
import { ProviderPreset, ReviewConfig } from '../types';

const CONFIG_SECTION = 'codesage-ai';

export const PROVIDER_LABELS: Record<ProviderPreset, string> = {
  openrouter: 'OpenRouter',
  openai: 'OpenAI',
  ollama: 'Ollama (local)',
  omniroute: 'OmniRoute (self-hosted gateway)',
  custom: 'Custom OpenAI-compatible endpoint',
};

/** Tiers offered when adding a model to the pool. Lower is tried first. */
const TIER_CHOICES = [
  { label: 'Tier 1 — preferred', detail: 'Tried first, before anything else.', tier: 1 },
  { label: 'Tier 2 — fallback', detail: 'Used when every tier 1 route is rate limited.', tier: 2 },
  { label: 'Tier 3 — last resort', detail: 'Keeps reviews working when everything better is spent.', tier: 3 },
];

/**
 * Confirms the pool can serve a review, and offers the fix when it cannot.
 *
 * The check is "does any slot exist", not "is a key stored", so a local gateway
 * that needs no credential is never blocked by a key prompt.
 */
export async function ensurePoolReady(
  service: ReviewService,
  config: ReviewConfig
): Promise<boolean> {
  if (service.poolSize > 0) {
    return true;
  }

  if (config.invalidRoutes.length > 0) {
    vscode.window.showErrorMessage(`CodeSage AI: ${config.invalidRoutes.join(' ')}`);
    return false;
  }

  const action = await vscode.window.showWarningMessage(
    `CodeSage AI: no API key configured for ${PROVIDER_LABELS[config.provider]}.`,
    'Add API Key'
  );

  if (action === 'Add API Key') {
    await vscode.commands.executeCommand('codesage-ai.setApiKey');
  }

  return false;
}

/**
 * Prompts for a key and adds it to the pool.
 *
 * The prompt is provider-shaped rather than hard-wired to one vendor's prefix,
 * and the key lands in the pool rather than replacing whatever is already
 * there, so adding a second key is how capacity grows.
 */
export async function setApiKeyCommand(context: vscode.ExtensionContext): Promise<void> {
  const config = getConfig();
  const provider = await pickProvider(config.provider);

  if (provider === undefined) {
    return;
  }

  const key = await vscode.window.showInputBox({
    prompt: `Enter an API key for ${PROVIDER_LABELS[provider]}`,
    password: true,
    placeHolder: keyPlaceholder(provider),
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim().length === 0 ? 'API key cannot be empty.' : null),
  });

  if (key === undefined || key.trim().length === 0) {
    return;
  }

  const added = await addPooledKey(context.secrets, provider, key);

  // The legacy single-key secret stays in step so a downgrade, or an older
  // window open on the same machine, still finds a working credential.
  if (provider === config.provider) {
    await setApiKey(context.secrets, key.trim());
  }

  const pool = await getKeyPool(context.secrets);
  const total = (pool[provider] ?? []).length;

  vscode.window.showInformationMessage(
    added
      ? `CodeSage AI: key saved. ${PROVIDER_LABELS[provider]} now has ${total} key${total === 1 ? '' : 's'} in the pool.`
      : 'CodeSage AI: that key is already in the pool.'
  );
}

/** Lists stored keys and lets the user add or remove one. */
export async function manageKeysCommand(context: vscode.ExtensionContext): Promise<void> {
  const pool = await getKeyPool(context.secrets);

  const entries = Object.entries(pool).flatMap(([provider, keys]) =>
    keys.map((key) => ({
      label: `$(key) ${maskKey(key)}`,
      description: PROVIDER_LABELS[provider as ProviderPreset] ?? provider,
      detail: 'Select to remove this key from the pool.',
      provider,
      key,
    }))
  );

  const addItem = {
    label: '$(add) Add an API key',
    description: '',
    detail: 'More keys on one provider means more requests before the window runs dry.',
    provider: '',
    key: '',
  };

  const chosen = await vscode.window.showQuickPick([addItem, ...entries], {
    title: `CodeSage AI — API keys (${entries.length} in the pool)`,
    placeHolder: entries.length === 0 ? 'No keys stored yet' : 'Select a key to remove, or add another',
  });

  if (chosen === undefined) {
    return;
  }

  if (chosen.key.length === 0) {
    await setApiKeyCommand(context);
    return;
  }

  const confirmation = await vscode.window.showWarningMessage(
    `Remove ${maskKey(chosen.key)} from ${chosen.description}?`,
    { modal: true },
    'Remove'
  );

  if (confirmation === 'Remove') {
    await removePooledKey(context.secrets, chosen.provider, chosen.key);
    vscode.window.showInformationMessage('CodeSage AI: key removed.');
  }
}

/**
 * Replaces the free-text model setting with a pick from the provider's live
 * catalog, and offers to rank the choice into the rotation pool.
 */
export async function selectModelCommand(
  context: vscode.ExtensionContext,
  outputChannel: vscode.OutputChannel,
  ledger: QuotaLedger
): Promise<void> {
  const config = getConfig();
  const service = await createReviewService(context.secrets, config, ledger, outputChannel);

  if (!(await ensurePoolReady(service, config))) {
    return;
  }

  const models = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'CodeSage AI', cancellable: true },
    async (progress, token) => {
      progress.report({ message: 'Loading model catalog…' });

      try {
        return await service.listModels(token);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        outputChannel.appendLine(`[Models] ${message}`);
        vscode.window.showErrorMessage(`CodeSage AI: ${message}`);
        return null;
      }
    }
  );

  if (models === null) {
    return;
  }

  if (models.length === 0) {
    vscode.window.showWarningMessage(
      'CodeSage AI: the provider returned an empty model catalog. Set "codesage-ai.model" by hand.'
    );
    return;
  }

  const picked = await vscode.window.showQuickPick(
    models.map((model) => ({
      label: model.id,
      description: model.id === config.model ? '(current)' : (model.ownedBy ?? ''),
      detail: describeModel(model),
      model,
    })),
    {
      title: `CodeSage AI — ${models.length} models on ${PROVIDER_LABELS[config.provider]}`,
      placeHolder: 'Select a model',
      matchOnDetail: true,
    }
  );

  if (picked === undefined) {
    return;
  }

  await applyModelChoice(picked.model.id, config);
}

/** Renders every pool slot and why it is or is not usable right now. */
export async function showPoolCommand(
  context: vscode.ExtensionContext,
  outputChannel: vscode.OutputChannel,
  ledger: QuotaLedger
): Promise<void> {
  const config = getConfig();
  const service = await createReviewService(context.secrets, config, ledger, outputChannel);
  const now = Date.now();
  const slots = service.describePool();

  outputChannel.appendLine('');
  outputChannel.appendLine(`=== Rotation pool — ${slots.length} slot(s) across ${service.routeCount} route(s) ===`);

  for (const route of config.invalidRoutes) {
    outputChannel.appendLine(`  [skipped] ${route}`);
  }

  for (const slot of slots) {
    const recovery = slot.until !== null ? ` for ${formatDuration(slot.until - now)}` : '';
    const reason = slot.reason.length > 0 ? ` — ${slot.reason}` : '';
    outputChannel.appendLine(
      `  tier ${slot.tier}  ${slot.state.padEnd(14)} ${slot.routeLabel} [${slot.keyLabel}]${recovery}${reason}`
    );
  }

  outputChannel.show(true);

  if (slots.length === 0) {
    await ensurePoolReady(service, config);
    return;
  }

  const live = slots.filter((slot) => slot.state === 'live' || slot.state === 'in-flight').length;
  const action = await vscode.window.showInformationMessage(
    `CodeSage AI: ${live} of ${slots.length} pool slots are ready.`,
    'Clear Pauses'
  );

  if (action === 'Clear Pauses') {
    ledger.reset();
    vscode.window.showInformationMessage('CodeSage AI: every route is marked live again.');
  }
}

async function applyModelChoice(modelId: string, config: ReviewConfig): Promise<void> {
  const settings = vscode.workspace.getConfiguration(CONFIG_SECTION);

  const action = await vscode.window.showQuickPick(
    [
      {
        label: '$(star) Use as the primary model',
        detail: 'Sets "codesage-ai.model". Replaces the current single-model setting.',
        addToPool: false,
      },
      {
        label: '$(list-ordered) Add to the rotation pool',
        detail: 'Appends to "codesage-ai.routes" so reviews fall back to it when a window runs dry.',
        addToPool: true,
      },
    ],
    { title: `CodeSage AI — ${modelId}`, placeHolder: 'How should this model be used?' }
  );

  if (action === undefined) {
    return;
  }

  if (!action.addToPool) {
    await settings.update('model', modelId, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(`CodeSage AI: now reviewing with ${modelId}.`);
    return;
  }

  const tier = await vscode.window.showQuickPick(TIER_CHOICES, {
    title: `CodeSage AI — where does ${modelId} rank?`,
    placeHolder: 'Pick a tier',
  });

  if (tier === undefined) {
    return;
  }

  const existing = settings.get<Record<string, unknown>[]>('routes', []);

  if (existing.some((route) => route.model === modelId && (route.provider ?? config.provider) === config.provider)) {
    vscode.window.showInformationMessage('CodeSage AI: that route is already in the pool.');
    return;
  }

  // The first pooled route has to carry the primary model too, or turning on
  // rotation would silently drop the model the user was already using.
  const seeded = existing.length === 0 && config.model !== modelId
    ? [{ model: config.model, provider: config.provider, tier: 1 }]
    : [];

  const routes = [...seeded, ...existing, { model: modelId, provider: config.provider, tier: tier.tier }];
  await settings.update('routes', routes, vscode.ConfigurationTarget.Global);

  vscode.window.showInformationMessage(
    `CodeSage AI: pool now has ${routes.length} route${routes.length === 1 ? '' : 's'}.`
  );
}

async function pickProvider(current: ProviderPreset): Promise<ProviderPreset | undefined> {
  const picked = await vscode.window.showQuickPick(
    (Object.keys(PROVIDER_LABELS) as ProviderPreset[]).map((provider) => ({
      label: PROVIDER_LABELS[provider],
      description: provider === current ? '(active provider)' : '',
      provider,
    })),
    { title: 'CodeSage AI — which provider is this key for?', placeHolder: 'Select a provider' }
  );

  return picked?.provider;
}

function keyPlaceholder(provider: ProviderPreset): string {
  switch (provider) {
    case 'openai':
      return 'sk-...';
    case 'openrouter':
      return 'sk-or-v1-...';
    case 'ollama':
      return 'any value — Ollama ignores it';
    default:
      return 'your gateway token';
  }
}

function describeModel(model: ModelDescriptor): string {
  const parts: string[] = [];

  if (model.ownedBy !== null) {
    parts.push(model.ownedBy);
  }

  if (model.contextLength !== null) {
    parts.push(`${model.contextLength.toLocaleString()} token context`);
  }

  return parts.join(' · ');
}
