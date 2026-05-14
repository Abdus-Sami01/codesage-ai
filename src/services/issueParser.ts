import { CodeIssue } from '../types';

/**
 * Extracts structured issues from the AI review response.
 *
 * The AI is instructed to embed a hidden block at the end of its response:
 *   <!-- ISSUES_JSON [{"line":5,"severity":"warning","message":"..."}] -->
 *
 * This parser extracts and validates that block. Falls back gracefully
 * if the block is missing or malformed.
 */
export function parseIssues(content: string): { cleanContent: string; issues: CodeIssue[] } {
  const pattern = /<!--\s*ISSUES_JSON\s*(\[[\s\S]*?\])\s*-->/;
  const match = content.match(pattern);

  if (!match) {
    return { cleanContent: content, issues: [] };
  }

  // Remove the ISSUES_JSON block from the visible content
  const cleanContent = content.replace(pattern, '').trimEnd();

  try {
    const rawIssues = JSON.parse(match[1]);

    if (!Array.isArray(rawIssues)) {
      return { cleanContent, issues: [] };
    }

    const issues: CodeIssue[] = rawIssues
      .filter(isValidIssue)
      .map(normalizeIssue);

    return { cleanContent, issues };
  } catch {
    // JSON was malformed — return clean content with no issues
    return { cleanContent, issues: [] };
  }
}

/**
 * Validates that a raw issue object has the minimum required fields.
 */
function isValidIssue(raw: unknown): raw is Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null) return false;
  const obj = raw as Record<string, unknown>;
  return (
    typeof obj.line === 'number' &&
    typeof obj.severity === 'string' &&
    typeof obj.message === 'string'
  );
}

/**
 * Normalizes a raw issue into a typed CodeIssue.
 */
function normalizeIssue(raw: Record<string, unknown>): CodeIssue {
  const severityMap: Record<string, CodeIssue['severity']> = {
    critical: 'critical',
    error: 'critical',
    high: 'critical',
    warning: 'warning',
    medium: 'warning',
    info: 'info',
    low: 'info',
    suggestion: 'info',
  };

  return {
    line: Math.max(1, Math.floor(raw.line as number)),
    endLine: typeof raw.endLine === 'number' ? Math.floor(raw.endLine) : undefined,
    severity: severityMap[String(raw.severity).toLowerCase()] || 'info',
    message: String(raw.message),
    fix: typeof raw.fix === 'string' ? raw.fix : undefined,
    ruleId: typeof raw.ruleId === 'string' ? raw.ruleId : undefined,
  };
}
