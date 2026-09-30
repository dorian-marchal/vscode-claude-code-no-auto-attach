# CLAUDE.md

This VS Code extension (`claude-code-no-auto-attach`) **monkey-patches the installed Claude Code extension's minified bundle in-place**. The repo dir is `vscode-claude-context`; the extension id is `dmarchal.claude-code-no-auto-attach`.

All logic is in [extension.js](extension.js) (no build step, no deps, no `node_modules`). See [README.md](README.md) for the feature list and per-patch detail.

⚠️ **Every change is tested, committed and pushed right away**, without being asked: run `node scripts/check.js` (plus any manual test the change needs), then commit on `main` and `git push`. Don't leave finished work uncommitted.

## How patching works (the parts that bite)

- Patch targets are 3 files inside the *Claude Code* install, not this repo:
  `~/.vscode/extensions/anthropic.claude-code-*/{webview/index.js, webview/index.css, extension.js}`.
  All installed versions are patched; patches re-apply on CC update (`onDidChange`) and on startup.
- Each sub-patch anchors on **minified CC internals via regex** and requires **exactly one match** — 0 or >1 → skipped with a logged reason, never destructive. When CC updates and the bundle shifts, anchors break and must be re-derived.
- Injected code is wrapped in `/*__ccaaX*/ … /*__ccaaXEnd*/` sentinels for byte-exact revert; the attach-toggle and permission-capture patches revert by reversing their specific edit.
- ⚠️ **Bump `MARKER` (`v60` → next) in [extension.js](extension.js) whenever patch logic changes.** `applyPatch` reverts any older marker before re-applying, so the bump is what makes the rollover seamless.
- An anchor that still matches is not proof the injection is valid: 2.1.261 turned the `listSessions("panel_boot")` statement into an `if(…)` operand, and the old `try{…}` insertion produced an unparsable webview bundle (blank Claude panel). Injected code that sits next to an expression must itself be an expression (IIFE + comma), and `applyPatch` now parses every patched `.js` result with `vm.Script` before writing — an unparsable result restores the clean upstream file instead. When updating anchors, also run `node --check` on the patched output.
- ⚠️ **Design every patch to minimize regression risk when CC's code changes.** Anchor on the smallest, most stable regex that still resolves to exactly one match, prefer behavior that degrades to a no-op (skip + log) over anything that could corrupt the bundle, and avoid coupling to incidental minified details that shift between releases. The goal is that a CC update either keeps working or cleanly skips the patch — never breaks the editor.

## Updating anchors after a CC release

Inspect the live bundle to rewrite regexes:
`~/.vscode/extensions/anthropic.claude-code-<version>/...` (current: `2.1.280-darwin-arm64`).
Since 2.1.251 the minifier also uses `$` as a bare variable name — anchor regexes must use `[\w$]+`, never `\w+`, and every `String.replace` whose replacement embeds captured variable names must use the function form (`replace(x, () => y)`) so `$`-sequences aren't interpreted.

## Build / release

- `./install` — packages the vsix into `dist/` via `vsce` and `code --install-extension --force`. Reload window after.
- Bump `version` in [package.json](package.json) before packaging (vsix filename is version-derived). `.vsix` files are gitignored.
- `node scripts/check.js` is the test: it dry-runs every sub-patch against each installed Claude Code version (reverting the on-disk marker first), parses the result, and checks the revert roundtrip. Run it after any anchor change; `--write-clean DIR` dumps the clean bundles for inspection. `/update` walks the whole release-update routine.
- Three more checks run in the same pass, because an anchor matching and a bundle parsing says nothing about whether the injection *means* the right thing (two bugs shipped green through the checks above: one suppressed the session's `applySelectionUpdate` and silently removed the composer's file chip, one left a retired patch's sentinel block behind because its revert helper was deleted with it):
  - **[scripts/assertions.js](scripts/assertions.js)** — one intent assertion per sub-patch, written against [README.md](README.md)'s "How it works" bullets rather than against `extension.js`'s own regexes, so a patch and its spec have to agree. Entries are `{ name, rel, applies?(clean, ctx), check(patched, clean, ctx) -> string | null }`; `applies` is how an assertion opts out on an older bundle that predates the upstream affordance it is about. One `upstream-affordances` canary per file asserts against the *clean* bundle that what the patches anchor on still exists, so an upstream rename fails loudly instead of a patch quietly becoming a no-op. ⚠️ Every new sub-patch needs an assertion; every retired one loses its assertion *and* its revert helper together.
  - **Rollover idempotence** — patching an already-patched bundle (current marker and older ones) must land byte-identical to patching the clean bundle once. This is what makes a `MARKER` bump seamless, and the only thing that sees a sentinel block from a retired patch, since `check.js` reverts the on-disk marker before it looks.
  - **No stray sentinels** — no `/*__ccaa` may remain in a reverted bundle, including the clean one derived from the live install.
