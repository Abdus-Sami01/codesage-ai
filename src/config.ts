import * as vscode from 'vscode';
import { ProviderPreset, ReviewConfig } from './types';
import { RouteDefinition, makeRouteId } from './services/rotation';

const CONFIG_SECTION = 'codesage-ai';

/** Single key written by the original "Set API Key" command. Still honoured. */
const API_KEY_SECRET = 'codesage-ai.apiKey';

/** Provider-keyed credential pool. Multiple keys per provider multiply capacity. */
const KEY_POOL_SECRET = 'codesage-ai.keyPool';

const DEFAULT_MODEL = 'deepseek-ai/DeepSeek-R1';
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_ATTEMPTS = 6;
const DEFAULT_MAX_QUEUE_WAIT_MS = 15_000;

const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  'openai',
  'openrouter',
  'ollama',
  'omniroute',
  'custom',
];

/**
 * Base URLs for presets whose endpoint is publicly documented and stable. The
 * gateway presets resolve to an empty string on purpose: their host and port are
 * chosen by whoever runs the gateway, so the user supplies `baseUrl` instead of
 * inheriting a guess that would fail at request time.
 */
const PROVIDER_BASE_URLS: Record<ProviderPreset, string> = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  ollama: 'http://localhost:11434/v1',
  omniroute: '',
  custom: '',
};

/** Credentials held per provider preset. */
export type KeyPool = Record<string, string[]>;

/**
 * Reads the user's CodeSage AI configuration from VS Code settings.
 */
export function getConfig(): ReviewConfig {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const provider = normalizeProvider(config.get<string>('provider', 'openrouter'), 'openrouter');
  const baseUrl = resolveBaseUrl(provider, config.get<string>('baseUrl', ''));
  const model = config.get<string>('model', DEFAULT_MODEL);
  const { routes, invalidRoutes } = buildRoutes(
    provider,
    baseUrl,
    model,
    config.get<unknown[]>('routes', [])
  );

  return {
    provider,
    baseUrl,
    model,
    maxTokens: config.get<number>('maxTokens', 4096),
    temperature: config.get<number>('temperature', 0.3),
    profile: config.get<string>('reviewProfile', 'general'),
    enableCodeLens: config.get<boolean>('enableCodeLens', true),
    enableStreaming: config.get<boolean>('enableStreaming', true),
    routes,
    invalidRoutes,
    requestTimeoutMs: config.get<number>('requestTimeoutMs', DEFAULT_REQUEST_TIMEOUT_MS),
    maxAttempts: Math.max(1, config.get<number>('maxAttempts', DEFAULT_MAX_ATTEMPTS)),
    maxQueueWaitMs: Math.max(0, config.get<number>('maxQueueWaitMs', DEFAULT_MAX_QUEUE_WAIT_MS)),
  };
}

/**
 * An explicit `baseUrl` always wins so a preset can be pointed at a proxy or a
 * self-hosted mirror without switching to `custom`.
 */
export function resolveBaseUrl(provider: ProviderPreset, configuredBaseUrl: string): string {
  const trimmed = configuredBaseUrl.trim();
  if (trimmed.length > 0) {
    return stripTrailingSlashes(trimmed);
  }

  return stripTrailingSlashes(PROVIDER_BASE_URLS[provider] ?? '');
}

/**
 * Turns the `routes` setting into a ranked pool.
 *
 * When the list is empty the single `provider`/`baseUrl`/`model` triple becomes
 * a one-route pool, so an installation that never touches `routes` behaves
 * exactly as it did before rotation existed. When the list is non-empty it *is*
 * the pool: the primary triple is not silently merged in, because a user who
 * ranked their models did so deliberately.
 */
export function buildRoutes(
  fallbackProvider: ProviderPreset,
  fallbackBaseUrl: string,
  fallbackModel: string,
  configured: readonly unknown[]
): { routes: RouteDefinition[]; invalidRoutes: string[] } {
  const routes: RouteDefinition[] = [];
  const invalidRoutes: string[] = [];
  const seen = new Set<string>();

  for (const entry of configured) {
    const normalized = normalizeRoute(entry, fallbackProvider, fallbackBaseUrl);

    if (typeof normalized === 'string') {
      invalidRoutes.push(normalized);
      continue;
    }

    if (seen.has(normalized.id)) {
      continue;
    }

    seen.add(normalized.id);
    routes.push(normalized);
  }

  if (routes.length === 0 && invalidRoutes.length === 0) {
    const primary = makeRoute(fallbackProvider, fallbackBaseUrl, fallbackModel, 1, '');
    if (typeof primary === 'string') {
      invalidRoutes.push(primary);
    } else {
      routes.push(primary);
    }
  }

  // A stable sort keeps declaration order inside a tier, which is the order the
  // user sees in settings.json and therefore the order they expect to be tried.
  return { routes: routes.sort((left, right) => left.tier - right.tier), invalidRoutes };
}

/** Returns the route, or a human-readable reason it cannot be used. */
function normalizeRoute(
  entry: unknown,
  fallbackProvider: ProviderPreset,
  fallbackBaseUrl: string
): RouteDefinition | string {
  if (typeof entry !== 'object' || entry === null) {
    return 'A routes entry was not an object.';
  }

  const raw = entry as Record<string, unknown>;
  const model = typeof raw.model === 'string' ? raw.model.trim() : '';

  if (model.length === 0) {
    return 'A routes entry is missing a "model".';
  }

  const provider = normalizeProvider(raw.provider, fallbackProvider);
  const declaredBaseUrl = typeof raw.baseUrl === 'string' ? raw.baseUrl.trim() : '';

  // Inheriting the primary base URL only makes sense for the same provider;
  // a different provider falls back to its own preset.
  const baseUrl = declaredBaseUrl.length > 0
    ? stripTrailingSlashes(declaredBaseUrl)
    : (provider === fallbackProvider ? fallbackBaseUrl : resolveBaseUrl(provider, ''));

  const tier = typeof raw.tier === 'number' && Number.isFinite(raw.tier)
    ? Math.max(1, Math.floor(raw.tier))
    : 1;

  const label = typeof raw.label === 'string' && raw.label.trim().length > 0
    ? raw.label.trim()
    : '';

  return makeRoute(provider, baseUrl, model, tier, label);
}

function makeRoute(
  provider: ProviderPreset,
  baseUrl: string,
  model: string,
  tier: number,
  label: string
): RouteDefinition | string {
  if (baseUrl.length === 0) {
    return `"${model}" on provider "${provider}" has no base URL. Set "codesage-ai.baseUrl" or the route's own "baseUrl".`;
  }

  return {
    id: makeRouteId(provider, baseUrl, model),
    label: label.length > 0 ? label : `${model} (${provider})`,
    provider,
    baseUrl,
    model,
    tier,
  };
}

function normalizeProvider(value: unknown, fallback: ProviderPreset): ProviderPreset {
  return typeof value === 'string' && (PROVIDER_PRESETS as readonly string[]).includes(value)
    ? (value as ProviderPreset)
    : fallback;
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * Retrieves the API key from VS Code's secure SecretStorage.
 */
export async function getApiKey(secrets: vscode.SecretStorage): Promise<string | undefined> {
  const legacy = await secrets.get(API_KEY_SECRET);
  if (legacy !== undefined && legacy.trim().length > 0) {
    return legacy;
  }

  const pool = await getKeyPool(secrets);
  for (const keys of Object.values(pool)) {
    if (keys.length > 0) {
      return keys[0];
    }
  }

  return undefined;
}

/**
 * Stores the API key in VS Code's secure SecretStorage.
 */
export async function setApiKey(secrets: vscode.SecretStorage, key: string): Promise<void> {
  await secrets.store(API_KEY_SECRET, key);
}

/** Reads the provider-keyed credential pool, tolerating a corrupted blob. */
export async function getKeyPool(secrets: vscode.SecretStorage): Promise<KeyPool> {
  const raw = await secrets.get(KEY_POOL_SECRET);
  if (raw === undefined) {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return {};
    }

    const pool: KeyPool = {};
    for (const [provider, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(value)) {
        continue;
      }
      pool[provider] = value.filter((key): key is string => typeof key === 'string' && key.trim().length > 0);
    }

    return pool;
  } catch {
    return {};
  }
}

export async function saveKeyPool(secrets: vscode.SecretStorage, pool: KeyPool): Promise<void> {
  await secrets.store(KEY_POOL_SECRET, JSON.stringify(pool));
}

/** Adds a key to a provider's list. Returns false when the key was already there. */
export async function addPooledKey(
  secrets: vscode.SecretStorage,
  provider: string,
  key: string
): Promise<boolean> {
  const trimmed = key.trim();
  const pool = await getKeyPool(secrets);
  const existing = pool[provider] ?? [];

  if (existing.includes(trimmed)) {
    return false;
  }

  pool[provider] = [...existing, trimmed];
  await saveKeyPool(secrets, pool);
  return true;
}

export async function removePooledKey(
  secrets: vscode.SecretStorage,
  provider: string,
  key: string
): Promise<void> {
  const pool = await getKeyPool(secrets);
  const remaining = (pool[provider] ?? []).filter((candidate) => candidate !== key);

  if (remaining.length === 0) {
    delete pool[provider];
  } else {
    pool[provider] = remaining;
  }

  await saveKeyPool(secrets, pool);

  // The legacy slot is a duplicate of one pooled key; removing that key has to
  // clear it too, or the deleted credential keeps working.
  const legacy = await secrets.get(API_KEY_SECRET);
  if (legacy === key) {
    await secrets.delete(API_KEY_SECRET);
  }
}

/**
 * Builds the per-route credential lookup the pool needs.
 *
 * The legacy single key predates providers, so it is attributed to whichever
 * provider is currently primary. Reading it here rather than migrating it keeps
 * an older VS Code window on the same machine working.
 *
 * A route with no key is still usable when nothing could be authenticating it
 * anyway: Ollama, or any gateway on a loopback or private address. Those get one
 * credential-free slot so a fully local setup needs no key at all.
 */
export async function resolveKeyLookup(
  secrets: vscode.SecretStorage,
  primaryProvider: ProviderPreset
): Promise<(route: RouteDefinition) => string[]> {
  const pool = await getKeyPool(secrets);
  const legacy = await secrets.get(API_KEY_SECRET);

  if (legacy !== undefined && legacy.trim().length > 0) {
    const existing = pool[primaryProvider] ?? [];
    if (!existing.includes(legacy)) {
      pool[primaryProvider] = [legacy, ...existing];
    }
  }

  return (route: RouteDefinition) => {
    const keys = pool[route.provider] ?? [];
    if (keys.length > 0) {
      return keys;
    }

    return isKeylessRoute(route) ? [''] : [];
  };
}

/** Providers that never authenticate, regardless of where they are hosted. */
const KEYLESS_PROVIDERS: ReadonlySet<string> = new Set(['ollama']);

/**
 * True when a route can be reached without a credential: a keyless preset, or
 * any endpoint on a loopback or RFC 1918 address, where the network boundary is
 * already the authentication.
 */
export function isKeylessRoute(route: RouteDefinition): boolean {
  if (KEYLESS_PROVIDERS.has(route.provider)) {
    return true;
  }

  return isPrivateEndpoint(route.baseUrl);
}

function isPrivateEndpoint(baseUrl: string): boolean {
  let host: string;

  try {
    host = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }

  if (host === 'localhost' || host === '::1' || host === '0.0.0.0') {
    return true;
  }

  if (host.endsWith('.local') || host.endsWith('.localhost')) {
    return true;
  }

  return (
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
}

/** Total credential count across every provider, for status reporting. */
export function countKeys(pool: KeyPool): number {
  return Object.values(pool).reduce((total, keys) => total + keys.length, 0);
}
