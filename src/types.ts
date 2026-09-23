/**
 * Request payload sent to the provider.
 */
export interface ReviewRequest {
  code: string;
  language: string;
  fileName: string;
}

/**
 * Parsed response from the provider.
 */
export interface ReviewResponse {
  content: string;
  model: string;
  tokensUsed: number;
  duration: number;
  issues: CodeIssue[];
}

/**
 * A structured issue extracted from the AI review.
 * Used for inline diagnostics and quick-fix CodeActions.
 */
export interface CodeIssue {
  line: number;
  endLine?: number;
  severity: 'critical' | 'warning' | 'info';
  message: string;
  fix?: string;
  ruleId?: string;
}

/**
 * Named provider presets. Every entry must expose an OpenAI-compatible
 * `/chat/completions` endpoint; providers with bespoke wire formats are reached
 * through a gateway rather than added here.
 */
export type ProviderPreset = 'openai' | 'openrouter' | 'ollama' | 'omniroute' | 'custom';

/**
 * User-configurable settings for CodeSage AI.
 */
export interface ReviewConfig {
  provider: ProviderPreset;
  baseUrl: string;
  model: string;
  maxTokens: number;
  temperature: number;
  profile: string;
  enableCodeLens: boolean;
  enableStreaming: boolean;
}

/**
 * A review profile that tailors the AI's review focus.
 */
export interface ReviewProfile {
  id: string;
  label: string;
  icon: string;
  description: string;
  systemPrompt: string;
}
