import * as vscode from 'vscode';
import { marked } from 'marked';
import { ReviewResponse } from '../types';

/**
 * Manages the Webview panel that displays AI code review results.
 * Supports both one-shot and streaming updates.
 */
export class ReviewPanel {
  public static currentPanel: ReviewPanel | undefined;
  private static readonly viewType = 'codesageReview';

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private disposables: vscode.Disposable[] = [];

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  /**
   * Shows or updates the review panel with a complete review.
   */
  public static show(
    extensionUri: vscode.Uri,
    response: ReviewResponse,
    fileName: string,
    languageId: string
  ) {
    const instance = ReviewPanel.getOrCreate(extensionUri);
    instance.updateFull(response, fileName, languageId);
  }

  /**
   * Opens the panel in streaming mode with a loading state.
   */
  public static showStreaming(
    extensionUri: vscode.Uri,
    fileName: string,
    languageId: string
  ): ReviewPanel {
    const instance = ReviewPanel.getOrCreate(extensionUri);
    instance.showLoading(fileName, languageId);
    return instance;
  }

  /**
   * Sends a streaming content update to the webview.
   */
  public updateStream(partialContent: string): void {
    const html = marked.parse(partialContent) as string;
    this.panel.webview.postMessage({ type: 'update', html });
  }

  /**
   * Finalizes the streaming view with the complete response metadata.
   */
  public finalize(response: ReviewResponse, fileName: string, languageId: string): void {
    this.updateFull(response, fileName, languageId);
  }

  private static getOrCreate(extensionUri: vscode.Uri): ReviewPanel {
    const column = vscode.ViewColumn.Beside;

    if (ReviewPanel.currentPanel) {
      ReviewPanel.currentPanel.panel.reveal(column);
      return ReviewPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      ReviewPanel.viewType,
      'CodeSage AI Review',
      column,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
        retainContextWhenHidden: true,
      }
    );

    ReviewPanel.currentPanel = new ReviewPanel(panel, extensionUri);
    return ReviewPanel.currentPanel;
  }

  private showLoading(fileName: string, languageId: string): void {
    const cssUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'review.css')
    );
    const baseName = fileName.split(/[/\\]/).pop() || fileName;
    const nonce = getNonce();

    this.panel.webview.html = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none'; style-src ${this.panel.webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
    <link href="${cssUri}" rel="stylesheet">
    <title>CodeSage AI Review</title>
</head>
<body>
    <div class="review-container">
        <header class="review-header">
            <div class="header-brand">
                <h1>CodeSage AI</h1>
            </div>
            <div class="header-meta">
                <span class="meta-badge">${this.escapeHtml(baseName)}</span>
                <span class="meta-badge">${this.escapeHtml(languageId)}</span>
                <span class="meta-badge streaming-badge">Streaming...</span>
            </div>
        </header>
        <main class="review-content" id="review-content">
            <div class="streaming-indicator">
                <div class="typing-dots">
                    <span></span><span></span><span></span>
                </div>
                <p>Analyzing your code...</p>
            </div>
        </main>
    </div>
    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const content = document.getElementById('review-content');
        window.addEventListener('message', (event) => {
            const msg = event.data;
            if (msg.type === 'update' && content) {
                content.innerHTML = msg.html;
                content.scrollTop = content.scrollHeight;
            }
        });
    </script>
</body>
</html>`;
  }

  private updateFull(response: ReviewResponse, fileName: string, languageId: string): void {
    const cssUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'review.css')
    );

    const reviewHtml = marked.parse(response.content) as string;
    const baseName = fileName.split(/[/\\]/).pop() || fileName;
    const nonce = getNonce();
    const modelName = response.model.split('/').pop() || response.model;
    const durationStr = (response.duration / 1000).toFixed(1);
    const tokensStr = response.tokensUsed
      ? `<span class="meta-badge">${response.tokensUsed.toLocaleString()} tokens</span>`
      : '';
    const issuesStr = response.issues.length > 0
      ? `<span class="meta-badge issues-badge">${response.issues.length} issue${response.issues.length > 1 ? 's' : ''} found</span>`
      : '<span class="meta-badge success-badge">No issues</span>';

    this.panel.webview.html = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none'; style-src ${this.panel.webview.cspSource} 'nonce-${nonce}';">
    <link href="${cssUri}" rel="stylesheet">
    <title>CodeSage AI Review</title>
</head>
<body>
    <div class="review-container">
        <header class="review-header">
            <div class="header-brand">
                <h1>CodeSage AI</h1>
            </div>
            <div class="header-meta">
                <span class="meta-badge">${this.escapeHtml(baseName)}</span>
                <span class="meta-badge">${this.escapeHtml(languageId)}</span>
                <span class="meta-badge">${this.escapeHtml(modelName)}</span>
                <span class="meta-badge">${durationStr}s</span>
                ${tokensStr}
                ${issuesStr}
            </div>
        </header>
        <main class="review-content">
            ${reviewHtml}
        </main>
        <footer class="review-footer">
            <span>Generated by CodeSage AI -- Results should be verified by a human</span>
        </footer>
    </div>
</body>
</html>`;
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  private dispose() {
    ReviewPanel.currentPanel = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) { d.dispose(); }
    }
  }
}

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
