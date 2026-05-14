/**
 * Request payload sent to the Python review backend.
 */
export interface ReviewRequest {
  code: string;
  language: string;
  fileName: string;
}

/**
 * Parsed response from the Python review backend.
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
 * User-configurable settings for CodeSage AI.
 */
export interface ReviewConfig {
  model: string;
  maxTokens: number;
  temperature: number;
  pythonPath: string;
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

/**
 * Streaming chunk from the Python backend.
 */
export type StreamChunk =
  | { type: 'chunk'; content: string }
  | { type: 'done'; content: string; model: string; tokens_used: number };
