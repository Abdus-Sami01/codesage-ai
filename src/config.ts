import * as vscode from 'vscode';
import { ReviewConfig } from './types';

const CONFIG_SECTION = 'codesage-ai';
const API_KEY_SECRET = 'codesage-ai.apiKey';

/**
 * Reads the user's CodeSage AI configuration from VS Code settings.
 */
export function getConfig(): ReviewConfig {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return {
    model: config.get<string>('model', 'deepseek-ai/DeepSeek-R1'),
    maxTokens: config.get<number>('maxTokens', 4096),
    temperature: config.get<number>('temperature', 0.3),
    pythonPath: config.get<string>('pythonPath', 'python'),
    profile: config.get<string>('reviewProfile', 'general'),
    enableCodeLens: config.get<boolean>('enableCodeLens', true),
    enableStreaming: config.get<boolean>('enableStreaming', true),
  };
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
