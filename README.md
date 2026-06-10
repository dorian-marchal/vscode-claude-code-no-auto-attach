A personal VS Code extension that patches the installed Claude Code extension to fix annoyances upstream hasn't addressed yet:

1. **Auto-attach defaults to OFF.** Stops Claude Code attaching the current file/selection to every prompt. Addresses [anthropics/claude-code#24726](https://github.com/anthropics/claude-code/issues/24726).
2. **Optional auto-allow for Claude's own files.** In `bypassPermissions` mode, Claude Code still prompts when a tool call touches its own protected paths (e.g. project `.claude/`, `~/.claude/settings.json`). Set `claude-code-no-auto-attach.autoApproveProtectedPathWrites: true` to silently approve `Write`/`Edit`/`MultiEdit`/`NotebookEdit`/`Bash` prompts. Addresses [anthropics/claude-code#37029](https://github.com/anthropics/claude-code/issues/37029).
3. **Session-scoped model switching.** Upstream, picking a model in the UI rewrites the global default in `~/.claude/settings.json`, so every future session inherits it. The patch reroutes the switch through the SDK's session-scoped `set_model` control request: switching only affects the current session, new sessions start on your real default.
4. **Per-session model badge.** Each Claude session webview shows the current model in a badge (top-right). It turns warning-colored on Fable models (double cost). Click it to open the model picker. Being per-webview, it stays correct with many concurrent sessions.
5. **Ctrl+M cycles models.** With a Claude session focused, `Ctrl+M` cycles through the available models for that session only.

## How it works

On activation, the extension iterates every installed `~/.vscode/extensions/anthropic.claude-code-*` directory and applies independent sub-patches to two files (a sub-patch whose anchor no longer matches is skipped and logged without blocking the others):

- **`webview/index.js`**
  - finds the unique site wiring the attach state to the toggle (`includeSelection:X,onToggleIncludeSelection:()=>Y(`) and flips `useState(!0)` to `useState(!1)`;
  - appends to the reactive effect that registers the "Switch model…" command action: a DOM badge kept in sync with the session's `modelSelection`, plus a capture-phase `Ctrl+M` keydown listener calling the session's `setModel` with the next available model.
- **`extension.js`**
  - finds the unique `can_use_tool` site and injects an early return that approves Write/Edit/MultiEdit/NotebookEdit/Bash when `autoApproveProtectedPathWrites` is on;
  - captures permission-mode changes into `globalThis.__ccaaPermissionMode` to gate the above;
  - replaces the body of the `set_model` handler — upstream's `writeUserSettingsAndPush({model})` (which persists to `~/.claude/settings.json`) — with `withChannel(...query.setModel(...))`, the session-scoped control request, when `sessionScopedModelSwitch` is on.

Each patched file is prefixed with a versioned marker so re-launches don't re-patch. When the patch logic changes the marker version is bumped, and `applyPatch` reverts any older marker before re-applying so the rollover is seamless. `vscode.extensions.onDidChange` triggers a re-apply whenever Claude Code updates.

## Settings

- `claude-code-no-auto-attach.autoApproveProtectedPathWrites` (boolean, default `false`) — auto-approve `Write`/`Edit`/`MultiEdit`/`NotebookEdit`/`Bash` prompts that fire against Claude's own protected paths despite `bypassPermissions`. The setting is mode-gated, but the gate only takes effect after permission mode is set/changed once in the session — toggle to `bypassPermissions` once at session start to arm it. The injected code reads the setting on every prompt, so toggling takes effect immediately — no reload needed. ⚠️ Only enable in trusted workspaces.
- `claude-code-no-auto-attach.sessionScopedModelSwitch` (boolean, default `true`) — make model switching session-scoped instead of rewriting the global default. Read on every switch, so toggling takes effect immediately. To change your **global default** model: toggle this OFF, switch the model in any session, toggle back ON — or edit the `model` key in `~/.claude/settings.json` directly.

## Caveats

- ⚠️ This modifies files inside another extension's install directory. Expect it to break if Anthropic significantly refactors their bundle. When that happens the extension logs the reason to the `Claude Code: No Auto-Attach` output channel and skips only the broken sub-patch, nothing destructive.
- ⚠️ VS Code doesn't currently verify extension integrity post-install, but if that ever changes this approach could stop working.
- ⚠️ `autoApproveProtectedPathWrites` bypasses Claude Code's protected-path safety check (covering `.claude/`, `~/.claude/settings.json`, etc.). Don't enable it in workspaces where you don't fully trust the agent.
- The model badge and `Ctrl+M` handler live inside the Claude webview, so the shortcut only fires when a Claude session has focus (that's also what makes it target the right session).
- A window reload is required after the patch is applied; the extension will prompt you.

## Install

```
./install
```

(packages the vsix with `vsce` and runs `code --install-extension`)

## Commands

- **Claude Code No Auto-Attach: Reapply Patch** — manually re-run the patch (useful after a Claude Code reinstall).
- **Claude Code No Auto-Attach: Revert Patch** — strips the marker and reverses all patches across every installed Claude Code version. The extension will re-apply on next startup unless you disable it first.
