A personal VS Code extension that patches the installed Claude Code extension to fix annoyances upstream hasn't addressed yet:

1. **Auto-attach defaults to OFF.** Stops Claude Code attaching the current file/selection to every prompt. Addresses [anthropics/claude-code#24726](https://github.com/anthropics/claude-code/issues/24726). Configurable via `claude-code-no-auto-attach.detachContextByDefault` (set to `false` to keep upstream's attached-by-default behavior).
2. **Ctrl+F toggles context attachment.** With a Claude session focused, `Ctrl+F` attaches/detaches the current file/selection — independent of the default above.
3. **Slash commands keep your file context.** Upstream silently drops the current file/selection for *any* message starting with `/` (the flag is computed as `includeSelection && !startsWithSlash`), so invoking a skill or slash command never shows the agent your open file even with the toggle on. The patch makes the toggle authoritative: if context is on (default or `Ctrl+F`), it rides along with slash commands too. Explicitly attached files (`@`-mentions / attach button) were never affected.
4. **Optional auto-allow for Claude's own files.** In `bypassPermissions` mode, Claude Code still prompts when a tool call touches its own protected paths (e.g. project `.claude/`, `~/.claude/settings.json`). Set `claude-code-no-auto-attach.autoApproveProtectedPathWrites: true` to silently approve `Write`/`Edit`/`MultiEdit`/`NotebookEdit`/`Bash` prompts. Addresses [anthropics/claude-code#37029](https://github.com/anthropics/claude-code/issues/37029).
5. **Session-scoped model switching.** Upstream, picking a model in the UI rewrites the global default in `~/.claude/settings.json`, so every future session inherits it. The patch reroutes the switch through the SDK's session-scoped `set_model` control request: switching only affects the current session, new sessions start on your real default.
6. **Per-session model badge.** Each Claude session webview shows the current model in a badge (top-right), color-coded per model family (Haiku teal `#269473`, Sonnet gold `#bc8e26`, Opus red `#c63e3e`, Fable purple `#8052d2`; falls back to the default badge color otherwise). Click it to open the model picker. Being per-webview, it stays correct with many concurrent sessions.
7. **Ctrl+M cycles models.** With a Claude session focused, `Ctrl+M` cycles through the available models for that session only.
8. **Sonnet/Haiku quick-send buttons.** Two extra send buttons sit next to the composer's send button — gold switches the session to Sonnet, teal to Haiku — then submit the prompt in one click. They reuse the session-scoped `setModel`, so the switch only affects the current session. Each button hides when its model isn't available; the original send button keeps its native send/stop behavior.
9. **Capped, scrollable prompt bubbles.** A huge pasted prompt (e.g. a long stack trace) no longer fills the whole webview — rendered user prompts are capped at `40vh` and scroll instead. Short prompts are unaffected.

## How it works

On activation, the extension iterates every installed `~/.vscode/extensions/anthropic.claude-code-*` directory and applies independent sub-patches to three files (a sub-patch whose anchor no longer matches is skipped and logged without blocking the others):

- **`webview/index.js`**
  - finds the unique site wiring the attach state to the toggle (`includeSelection:X,onToggleIncludeSelection:()=>Y(`) and, when `detachContextByDefault` is on, flips its `useState(!0)` to `useState(!1)`. The `[X,Y]` pair is reused by an earlier component, so the patch anchors on the declaration closest *before* the toggle prop (same component) rather than the first match in the file;
  - rewrites the same toggle prop into an IIFE that exposes the toggle as `globalThis.__ccaaToggleContext` and binds a capture-phase `Ctrl+F` keydown calling it (the original click toggle is preserved and reconstructed byte-exact on revert);
  - finds the submit handler's include-selection computation (`let gt=v&&!De`, where `v` is the toggle and `De` is "message starts with `/`") and drops the `&&!De` guard so slash commands and skills keep the file/selection when the toggle is on. The stripped `&&!De` is parked in a `/*__ccaaSlashSel:…*/` sentinel comment for a byte-exact revert;
  - appends to the reactive effect that registers the "Switch model…" command action: a DOM badge kept in sync with the session's `modelSelection`, plus a capture-phase `Ctrl+M` keydown listener calling the session's `setModel` with the next available model;
  - finds the unique composer send button (`type:"submit"` + `className:X.sendButton` + `data-permission-mode`) and inserts two `type:"button"` siblings after it (Sonnet/gold, Haiku/teal) that call the in-scope session's `setModel` for the matching model, then `requestSubmit()` the form.
- **`webview/index.css`**
  - appends a rule capping the user prompt bubble at `max-height:40vh` with `overflow-y:auto`. It targets the bubble via a hash-independent attribute selector (`[class*="userMessage_"]`) and is appended last so its equal-specificity `overflow-y` wins over upstream's `overflow-y:hidden`.
- **`extension.js`**
  - finds the unique `can_use_tool` site and injects an early return that approves Write/Edit/MultiEdit/NotebookEdit/Bash when `autoApproveProtectedPathWrites` is on;
  - captures permission-mode changes into `globalThis.__ccaaPermissionMode` to gate the above;
  - replaces the body of the `set_model` handler — upstream's `writeUserSettingsAndPush({model})` (which persists to `~/.claude/settings.json`) — with `withChannel(...query.setModel(...))`, the session-scoped control request, when `sessionScopedModelSwitch` is on.

Each patched file is prefixed with a versioned marker so re-launches don't re-patch. When the patch logic changes the marker version is bumped, and `applyPatch` reverts any older marker before re-applying so the rollover is seamless. `vscode.extensions.onDidChange` triggers a re-apply whenever Claude Code updates.

## Settings

- `claude-code-no-auto-attach.detachContextByDefault` (boolean, default `true`) — start new Claude sessions with the current file/selection **not** attached as context. Set to `false` to keep upstream's attached-by-default behavior. Either way, `Ctrl+F` toggles the attachment while a Claude session is focused. Because this is baked in at patch time (the webview can't read VS Code settings), changing it re-applies the patch and prompts a window reload.
- `claude-code-no-auto-attach.autoApproveProtectedPathWrites` (boolean, default `false`) — auto-approve `Write`/`Edit`/`MultiEdit`/`NotebookEdit`/`Bash` prompts that fire against Claude's own protected paths despite `bypassPermissions`. The setting is mode-gated, but the gate only takes effect after permission mode is set/changed once in the session — toggle to `bypassPermissions` once at session start to arm it. The injected code reads the setting on every prompt, so toggling takes effect immediately — no reload needed. ⚠️ Only enable in trusted workspaces.
- `claude-code-no-auto-attach.sessionScopedModelSwitch` (boolean, default `true`) — make model switching session-scoped instead of rewriting the global default. Read on every switch, so toggling takes effect immediately. To change your **global default** model: toggle this OFF, switch the model in any session, toggle back ON — or edit the `model` key in `~/.claude/settings.json` directly.

## Caveats

- ⚠️ This modifies files inside another extension's install directory. Expect it to break if Anthropic significantly refactors their bundle. When that happens the extension logs the reason to the `Claude Code: No Auto-Attach` output channel and skips only the broken sub-patch, nothing destructive.
- ⚠️ VS Code doesn't currently verify extension integrity post-install, but if that ever changes this approach could stop working.
- ⚠️ `autoApproveProtectedPathWrites` bypasses Claude Code's protected-path safety check (covering `.claude/`, `~/.claude/settings.json`, etc.). Don't enable it in workspaces where you don't fully trust the agent.
- The model badge, `Ctrl+M`, and `Ctrl+F` handlers live inside the Claude webview, so the shortcuts only fire when a Claude session has focus (that's also what makes them target the right session). `Ctrl+F` is captured there and won't reach VS Code's find while the session is focused.
- A window reload is required after the patch is applied; the extension will prompt you.

## Install

```
./install
```

(packages the vsix with `vsce` and runs `code --install-extension`)

## Commands

- **Claude Code No Auto-Attach: Reapply Patch** — manually re-run the patch (useful after a Claude Code reinstall).
- **Claude Code No Auto-Attach: Revert Patch** — strips the marker and reverses all patches across every installed Claude Code version. The extension will re-apply on next startup unless you disable it first.
