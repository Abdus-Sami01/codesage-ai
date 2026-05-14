import * as vscode from 'vscode';

/**
 * Provides "Review" CodeLens above functions, methods, and classes.
 * Uses VS Code's built-in DocumentSymbolProvider for reliable symbol detection.
 */
export class ReviewCodeLensProvider implements vscode.CodeLensProvider {
  private readonly _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  private enabled = true;

  constructor() {
    // Refresh CodeLenses when configuration changes
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('codesage-ai.enableCodeLens')) {
        this.enabled = vscode.workspace
          .getConfiguration('codesage-ai')
          .get<boolean>('enableCodeLens', true);
        this._onDidChangeCodeLenses.fire();
      }
    });

    this.enabled = vscode.workspace
      .getConfiguration('codesage-ai')
      .get<boolean>('enableCodeLens', true);
  }

  async provideCodeLenses(
    document: vscode.TextDocument,
    token: vscode.CancellationToken
  ): Promise<vscode.CodeLens[]> {
    if (!this.enabled) return [];

    try {
      const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider',
        document.uri
      );

      if (!symbols || token.isCancellationRequested) return [];

      const lenses: vscode.CodeLens[] = [];
      this.collectSymbols(symbols, lenses, document.uri);
      return lenses;
    } catch {
      // No symbol provider available for this language — silently return empty
      return [];
    }
  }

  resolveCodeLens(codeLens: vscode.CodeLens): vscode.CodeLens {
    // Command is already set in collectSymbols
    return codeLens;
  }

  /**
   * Recursively collects functions, methods, and classes from the symbol tree.
   */
  private collectSymbols(
    symbols: vscode.DocumentSymbol[],
    lenses: vscode.CodeLens[],
    uri: vscode.Uri
  ): void {
    const targetKinds = new Set([
      vscode.SymbolKind.Function,
      vscode.SymbolKind.Method,
      vscode.SymbolKind.Class,
      vscode.SymbolKind.Constructor,
    ]);

    for (const symbol of symbols) {
      if (targetKinds.has(symbol.kind)) {
        const lens = new vscode.CodeLens(symbol.range, {
          title: '$(code) Review',
          tooltip: `Review "${symbol.name}" with CodeSage AI`,
          command: 'codesage-ai.reviewFunction',
          arguments: [uri, symbol.range, symbol.name],
        });
        lenses.push(lens);
      }

      // Recurse into children (e.g., methods inside classes)
      if (symbol.children && symbol.children.length > 0) {
        this.collectSymbols(symbol.children, lenses, uri);
      }
    }
  }

  /**
   * Force a refresh of all CodeLenses.
   */
  refresh(): void {
    this._onDidChangeCodeLenses.fire();
  }

  dispose(): void {
    this._onDidChangeCodeLenses.dispose();
  }
}
