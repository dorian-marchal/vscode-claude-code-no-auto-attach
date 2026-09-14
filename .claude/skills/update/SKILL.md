---
name: update
description: Re-align the patches with a new Claude Code release, verify, install.
argument-hint: [claude code version]
disable-model-invocation: true
---

Claude Code updated and the patches may have drifted. Do all of this, in order.

1. **Map the drift.** `ls ~/.vscode/extensions/anthropic.claude-code-*` to find the new version, then `node scripts/check.js` — it reverts the newest installed bundle in memory, re-applies every sub-patch, and reports skips, parse failures, revert roundtrips, rollover idempotence, stray sentinels, and the per-sub-patch intent assertions in `scripts/assertions.js` (`--all` covers older installs too; those legitimately skip anchors added after them). Also `node --check` the *live* patched bundles: a matching anchor can still leave a bundle unparsable (that is what a blank Claude panel means). Fetch `https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md` and read the `[VSCode]` entries between the old and new version: they say what moved.
2. **Get clean bundles to inspect.** `node scripts/check.js --write-clean <scratchpad>/clean` dumps the unpatched files per version. Compare old vs new around every anchor (`grep -o '.\{300\}<anchor>.\{300\}'` or a small node slice), not only the ones that skipped: check the surrounding statement shape (statement vs. expression operand), the return value the caller now expects, and new fields the webview reads (e.g. `applied`).
3. **Decide per sub-patch.** Fix the anchor when the shape changed; loosen it to the smallest stable regex (use `[\w$]+`, function-form `replace`). If upstream now ships the feature, prefer dropping our patch over keeping a duplicate, and say so. Injected code next to an expression must be an expression (IIFE + comma).
4. **Keep the assertions honest.** A failing assertion in `scripts/assertions.js` is a real report: either the patch no longer means what README says, or the spec moved. When an `upstream-affordances` canary fails, upstream renamed something a patch depends on — find its new name, do not just delete the entry. When a patch changes shape, update its assertion to the new intent (never loosen it to whatever the patch now emits), and when a patch is retired, delete its assertion *and* its revert helper together — a dropped revert helper is exactly what the rollover and stray-sentinel checks exist to catch. A new sub-patch needs a new assertion.
5. **Bump and document.** Bump `MARKER`, `version` in `package.json`, the current version in `CLAUDE.md`, and README lines that name versions or anchors.
6. **Verify.** `node scripts/check.js` must be all `ok` for the newest version (and `--all` must not regress the previous one), and `node --check extension.js` must pass.
7. **Ship.** `./install`, then apply the patches to the installed bundles right away so the user needs a single reload: drive the real `activate()` with a stubbed `vscode` (see `scripts/check.js` for the stub) or tell the user to run *Claude Code No Auto-Attach: Reapply Patch* after reloading. Do not commit unless asked.

Report: what actually broke (parse error vs. skipped anchor), what changed per sub-patch, what was dropped because upstream now does it, and that a reload is needed.

$ARGUMENTS
