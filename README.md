A personal VS Code extension that patches the installed Claude Code extension to fix two annoyances upstream hasn't addressed yet:

1. **Auto-attach defaults to OFF.** Stops Claude Code attaching the current file/selection to every prompt. Addresses [anthropics/claude-code#24726](https://github.com/anthropics/claude-code/issues/24726).
2. **Optional auto-allow for Claude's own files.** In `bypassPermissions` mode, Claude Code still prompts when a tool call touches its own protected paths (e.g. project `.claude/`, `~/.claude/settings.json`). Set `claude-code-no-auto-attach.autoApproveProtectedPathWrites: true` to silently approve `Write`/`Edit`/`MultiEdit`/`NotebookEdit`/`Bash` prompts. Addresses [anthropics/claude-code#37029](https://github.com/anthropics/claude-code/issues/37029).

## How it works

On activation, the extension iterates every installed `~/.vscode/extensions/anthropic.claude-code-*` directory and applies two text patches:

- **`webview/index.js`** — finds the unique site wiring the attach state to the toggle (`includeSelection:X,onToggleIncludeSelection:()=>Y(`) and flips `useState(!0)` to `useState(!1)`.
- **`extension.js`** — finds the unique `if(V.request.subtype==="can_use_tool"){if(!this.canUseTool)throw Error(...)` site and injects an early return that approves Write/Edit/MultiEdit/NotebookEdit/Bash when the setting is on.

Each patched file is prefixed with a versioned marker so re-launches don't re-patch. When the patch logic changes the marker version is bumped, and `applyPatch` reverts any older marker before re-applying so the rollover is seamless. `vscode.extensions.onDidChange` triggers a re-apply whenever Claude Code updates.

## Settings

- `claude-code-no-auto-attach.autoApproveProtectedPathWrites` (boolean, default `false`) — auto-approve `Write`/`Edit`/`MultiEdit`/`NotebookEdit`/`Bash` prompts that fire against Claude's own protected paths despite `bypassPermissions`. The setting is mode-gated, but the gate only takes effect after permission mode is set/changed once in the session — toggle to `bypassPermissions` once at session start to arm it. The injected code reads the setting on every prompt, so toggling takes effect immediately — no reload needed. ⚠️ Only enable in trusted workspaces.

## Caveats

- ⚠️ This modifies files inside another extension's install directory. Expect it to break if Anthropic significantly refactors their bundle. When that happens the extension logs the reason to the `Claude Code: No Auto-Attach` output channel and does nothing destructive.
- ⚠️ VS Code doesn't currently verify extension integrity post-install, but if that ever changes this approach could stop working.
- ⚠️ `autoApproveProtectedPathWrites` bypasses Claude Code's protected-path safety check (covering `.claude/`, `~/.claude/settings.json`, etc.). Don't enable it in workspaces where you don't fully trust the agent.
- A window reload is required after the patch is applied; the extension will prompt you.

## Install

```
code --install-extension claude-code-no-auto-attach-0.1.0.vsix
```

## Commands

- **Claude Code No Auto-Attach: Reapply Patch** — manually re-run the patch (useful after a Claude Code reinstall).
- **Claude Code No Auto-Attach: Revert Patch** — strips the marker and reverses both patches across every installed Claude Code version. The extension will re-apply on next startup unless you disable it first.
