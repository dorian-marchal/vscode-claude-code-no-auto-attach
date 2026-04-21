# Claude Code: No Auto-Attach

A personal VS Code extension that disables Claude Code's default auto-attach of the current file/selection to every prompt.

Addresses [anthropics/claude-code#24726](https://github.com/anthropics/claude-code/issues/24726). Until upstream ships a real setting, this extension patches Claude Code's webview bundle on startup so the attach toggle defaults to OFF.

## How it works

On activation, the extension:

1. Locates the installed [`Anthropic.claude-code`](https://marketplace.visualstudio.com/items?itemName=Anthropic.claude-code) extension via the VS Code API.
2. Opens `webview/index.js` inside it.
3. Finds the unique site that wires the attach state to the toggle (matches `includeSelection:X,onToggleIncludeSelection:()=>Y(`) and flips the `useState(!0)` init to `useState(!1)`.
4. Prepends a marker comment so it won't re-patch on subsequent launches.
5. Subscribes to `vscode.extensions.onDidChange` so that when Claude Code updates (new versioned directory with fresh unpatched bundle), the patch is re-applied automatically.

## Caveats

- ⚠️ This modifies files inside another extension's install directory. Expect it to break if Anthropic significantly refactors their bundle. When that happens the extension logs the reason to the `Claude Code: No Auto-Attach` output channel and does nothing destructive.
- ⚠️ VS Code doesn't currently verify extension integrity post-install, but if that ever changes this approach could stop working.
- Requires a window reload after the patch is applied; the extension will prompt you.

## Install

```
code --install-extension claude-code-no-auto-attach-0.1.0.vsix
```

## Commands

- **Claude Code No Auto-Attach: Reapply Patch** — manually re-run the patch (useful after a Claude Code reinstall).
- **Claude Code No Auto-Attach: Revert Patch** — shows instructions for undoing (reinstall Claude Code from the Extensions panel).
