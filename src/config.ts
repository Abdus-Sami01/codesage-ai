import * as vscode from 'vscode';
import { ProviderPreset, ReviewConfig } from './types';

const CONFIG_SECTION = 'codesage-ai';
const API_KEY_SECRET = 'codesage-ai.apiKey';

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

/**
 * Reads the user's CodeSage AI configuration from VS Code settings.
 */
export function getConfig(): ReviewConfig {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const provider = config.get<ProviderPreset>('provider', 'openrouter');

  return {
    provider,
    baseUrl: resolveBaseUrl(provider, config.get<string>('baseUrl', '')),
    model: config.get<string>('model', 'deepseek-ai/DeepSeek-R1'),
    maxTokens: config.get<number>('maxTokens', 4096),
    temperature: config.get<number>('temperature', 0.3),
    profile: config.get<string>('reviewProfile', 'general'),
    enableCodeLens: config.get<boolean>('enableCodeLens', true),
    enableStreaming: config.get<boolean>('enableStreaming', true),
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

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * Retrieves the API key from VS Code's secure SecretStorage.
 */
export async function getApiKey(secrets: vscode.SecretStorage): Promise<string | undefined> {
  return secrets.get(API_KEY_SECRET);
}

/**
 * Stores the API key in VS Code's secure SecretStorage.
 */
export async function setApiKey(secrets: vscode.SecretStorage, key: string): Promise<void> {
  await secrets.store(API_KEY_SECRET, key);
}
