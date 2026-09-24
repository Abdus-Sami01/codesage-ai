import * as vscode from 'vscode';
import { ReviewContext, executeReview } from './reviewCode';

/**
 * Handles the "CodeSage: Review Function" command triggered by CodeLens.
 * Reviews a specific function/method/class instead of the entire file.
 */
export async function reviewFunctionCommand(
  ctx: ReviewContext,
  uri: vscode.Uri,
  range: vscode.Range,
  symbolName: string
): Promise<void> {
  const document = await vscode.workspace.openTextDocument(uri);
  const code = document.getText(range);

  if (!code.trim()) {
    vscode.window.showWarningMessage('CodeSage AI: Selected function is empty.');
    return;
  }

  // Issue lines come back relative to the function, so they are shifted by its start line.
  await executeReview(ctx, {
    code,
    language: document.languageId,
    fileName: document.fileName,
    document,
    lineOffset: range.start.line,
    progressLabel: `Reviewing "${symbolName}"…`,
  });
}
