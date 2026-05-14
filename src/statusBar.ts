import * as vscode from 'vscode';
import { PROFILES, getProfile } from './profiles';

/**
 * Manages the status bar item that shows the current review profile
 * and extension state.
 */
export class StatusBar {
  private readonly item: vscode.StatusBarItem;
  private currentProfileId: string;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this.item.command = 'codesage-ai.selectProfile';
    this.item.tooltip = 'Click to switch review profile';

    this.currentProfileId = vscode.workspace
      .getConfiguration('codesage-ai')
      .get<string>('reviewProfile', 'general');

    this.setIdle();
    this.item.show();

    // React to config changes
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('codesage-ai.reviewProfile')) {
        this.currentProfileId = vscode.workspace
          .getConfiguration('codesage-ai')
          .get<string>('reviewProfile', 'general');
        this.setIdle();
      }
    });
  }

  /**
   * Shows the idle state with the active profile icon.
   */
  setIdle(): void {
    const profile = getProfile(this.currentProfileId);
    this.item.text = `$(code) CodeSage [${profile.label}]`;
    this.item.tooltip = `CodeSage AI -- ${profile.label} profile\nClick to switch`;
    this.item.backgroundColor = undefined;
  }

  /**
   * Shows the reviewing state with a spinner.
   */
  setReviewing(): void {
    this.item.text = '$(sync~spin) CodeSage Reviewing...';
    this.item.tooltip = 'CodeSage AI is analyzing your code...';
    this.item.backgroundColor = new vscode.ThemeColor(
      'statusBarItem.warningBackground'
    );
  }

  /**
   * Shows the error state.
   */
  setError(): void {
    this.item.text = '$(error) CodeSage Error';
    this.item.backgroundColor = new vscode.ThemeColor(
      'statusBarItem.errorBackground'
    );

    // Auto-recover to idle after 5s
    setTimeout(() => this.setIdle(), 5000);
  }

  /**
   * Shows a quick-pick to switch the active review profile.
   */
  async showProfilePicker(): Promise<void> {
    const items = Object.values(PROFILES).map((p) => ({
      label: `${p.label}`,
      description: p.id === this.currentProfileId ? '(active)' : '',
      detail: p.description,
      profileId: p.id,
    }));

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a review profile',
      title: 'CodeSage AI -- Review Profile',
    });

    if (selected) {
      await vscode.workspace
        .getConfiguration('codesage-ai')
        .update('reviewProfile', selected.profileId, vscode.ConfigurationTarget.Global);
      this.currentProfileId = selected.profileId;
      this.setIdle();
      vscode.window.showInformationMessage(
        `CodeSage AI: Switched to ${getProfile(selected.profileId).label} profile.`
      );
    }
  }

  dispose(): void {
    this.item.dispose();
  }
}
