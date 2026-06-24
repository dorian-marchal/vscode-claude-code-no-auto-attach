# CLAUDE.md

This VS Code extension (`claude-code-no-auto-attach`) **monkey-patches the installed Claude Code extension's minified bundle in-place**. The repo dir is `vscode-claude-context`; the extension id is `dmarchal.claude-code-no-auto-attach`.

All logic is in [extension.js](extension.js) (no build step, no deps, no `node_modules`). See [README.md](README.md) for the feature list and per-patch detail.

## How patching works (the parts that bite)

- Patch targets are 3 files inside the *Claude Code* install, not this repo:
  `~/.vscode/extensions/anthropic.claude-code-*/{webview/index.js, webview/index.css, extension.js}`.
  All installed versions are patched; patches re-apply on CC update (`onDidChange`) and on startup.
- Each sub-patch anchors on **minified CC internals via regex** and requires **exactly one match** — 0 or >1 → skipped with a logged reason, never destructive. When CC updates and the bundle shifts, anchors break and must be re-derived.
- Injected code is wrapped in `/*__ccaaX*/ … /*__ccaaXEnd*/` sentinels for byte-exact revert; the attach-toggle and permission-capture patches revert by reversing their specific edit.
- ⚠️ **Bump `MARKER` (`v15` → next) in [extension.js](extension.js) whenever patch logic changes.** `applyPatch` reverts any older marker before re-applying, so the bump is what makes the rollover seamless.
- ⚠️ **Design every patch to minimize regression risk when CC's code changes.** Anchor on the smallest, most stable regex that still resolves to exactly one match, prefer behavior that degrades to a no-op (skip + log) over anything that could corrupt the bundle, and avoid coupling to incidental minified details that shift between releases. The goal is that a CC update either keeps working or cleanly skips the patch — never breaks the editor.

## Updating anchors after a CC release

Inspect the live bundle to rewrite regexes:
`~/.vscode/extensions/anthropic.claude-code-<version>/...` (current: `2.1.177-darwin-arm64`).

## Build / release

- `./install` — packages the vsix via `vsce` and `code --install-extension --force`. Reload window after.
- Bump `version` in [package.json](package.json) before packaging (vsix filename is version-derived). `.vsix` files are gitignored.
- No test runner despite the `// exported for tests` exports at the bottom of [extension.js](extension.js).
