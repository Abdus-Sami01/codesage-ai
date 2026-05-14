import * as vscode from 'vscode';
import { CodeIssue } from '../types';

/**
 * Manages inline diagnostics (squiggly underlines) and quick-fix CodeActions
 * based on issues extracted from AI reviews.
 */
export class DiagnosticsProvider implements vscode.CodeActionProvider {
  public static readonly source = 'CodeSage AI';

  private readonly diagnosticCollection: vscode.DiagnosticCollection;
  private readonly issueMap = new Map<string, CodeIssue[]>();

  constructor() {
    this.diagnosticCollection = vscode.languages.createDiagnosticCollection('codesage-ai');
  }

  /**
   * Sets diagnostics for a file based on AI-extracted issues.
   */
  setDiagnostics(uri: vscode.Uri, issues: CodeIssue[], document: vscode.TextDocument): void {
    if (issues.length === 0) {
      this.diagnosticCollection.delete(uri);
      this.issueMap.delete(uri.toString());
      return;
    }

    this.issueMap.set(uri.toString(), issues);

    const diagnostics = issues.map((issue) => {
      const line = Math.min(issue.line - 1, document.lineCount - 1);
      const endLine = issue.endLine
        ? Math.min(issue.endLine - 1, document.lineCount - 1)
        : line;

      const lineText = document.lineAt(line).text;
      const startChar = lineText.length - lineText.trimStart().length;
      const endChar = lineText.length;

      const range = new vscode.Range(line, startChar, endLine, endChar);

      const diagnostic = new vscode.Diagnostic(
        range,
        issue.message,
        this.mapSeverity(issue.severity)
      );

      diagnostic.source = DiagnosticsProvider.source;
      diagnostic.code = issue.ruleId || undefined;

      return diagnostic;
    });

    this.diagnosticCollection.set(uri, diagnostics);
  }

  /**
   * Clears diagnostics for a specific file.
   */
  clearDiagnostics(uri: vscode.Uri): void {
    this.diagnosticCollection.delete(uri);
    this.issueMap.delete(uri.toString());
  }

  /**
   * Clears all diagnostics across all files.
   */
  clearAll(): void {
    this.diagnosticCollection.clear();
    this.issueMap.clear();
  }

  /**
   * Provides quick-fix CodeActions for diagnostics that have a suggested fix.
   */
  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range,
    context: vscode.CodeActionContext
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];
    const issues = this.issueMap.get(document.uri.toString());

    if (!issues) return actions;

    for (const diagnostic of context.diagnostics) {
      if (diagnostic.source !== DiagnosticsProvider.source) continue;

      // Find the matching issue
      const issue = issues.find(
        (i) =>
          i.message === diagnostic.message &&
          i.line - 1 === diagnostic.range.start.line
      );

      if (issue?.fix) {
        // Quick fix action
        const fixAction = new vscode.CodeAction(
          `Apply CodeSage fix: ${truncate(issue.fix, 50)}`,
          vscode.CodeActionKind.QuickFix
        );
        fixAction.edit = new vscode.WorkspaceEdit();
        fixAction.edit.replace(document.uri, diagnostic.range, issue.fix);
        fixAction.diagnostics = [diagnostic];
        fixAction.isPreferred = true;
        actions.push(fixAction);
      }

      // Dismiss action (always available)
      const dismissAction = new vscode.CodeAction(
        'Dismiss this CodeSage issue',
        vscode.CodeActionKind.QuickFix
      );
      dismissAction.command = {
        command: 'codesage-ai.dismissDiagnostic',
        title: 'Dismiss diagnostic',
        arguments: [document.uri, diagnostic],
      };
      dismissAction.diagnostics = [diagnostic];
      actions.push(dismissAction);
    }

    return actions;
  }

  /**
   * Removes a single diagnostic from a file.
   */
  dismissDiagnostic(uri: vscode.Uri, diagnostic: vscode.Diagnostic): void {
    const existing = this.diagnosticCollection.get(uri);
    if (!existing) return;

    const filtered = existing.filter(
      (d) =>
        d.range.start.line !== diagnostic.range.start.line ||
        d.message !== diagnostic.message
    );

    this.diagnosticCollection.set(uri, filtered);

    // Also remove from issue map
    const issues = this.issueMap.get(uri.toString());
    if (issues) {
      const filteredIssues = issues.filter(
        (i) => i.line - 1 !== diagnostic.range.start.line || i.message !== diagnostic.message
      );
      this.issueMap.set(uri.toString(), filteredIssues);
    }
  }

  /**
   * Returns the disposable for cleanup.
   */
  dispose(): void {
    this.diagnosticCollection.dispose();
  }

  private mapSeverity(severity: CodeIssue['severity']): vscode.DiagnosticSeverity {
    switch (severity) {
      case 'critical': return vscode.DiagnosticSeverity.Error;
      case 'warning': return vscode.DiagnosticSeverity.Warning;
      case 'info': return vscode.DiagnosticSeverity.Information;
    }
  }
}

function truncate(text: string, maxLength: number): string {
  const singleLine = text.replace(/\n/g, ' ').trim();
  return singleLine.length > maxLength
    ? singleLine.substring(0, maxLength) + '…'
    : singleLine;
}
