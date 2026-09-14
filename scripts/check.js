#!/usr/bin/env node
// Dry-run every patch against the installed Claude Code versions (or the dirs given as
// arguments) without touching them. For each target file: revert whatever marker is on
// disk to get the clean upstream bundle, run the patch, and report per sub-patch skips,
// whether the result parses, and whether reverting it gives the clean bundle back.
//
// On top of that, three checks on what the patch *means* rather than on whether it
// applied — an anchor matching and a bundle parsing is not evidence that the injection
// does the right thing:
//   - the intent assertions in scripts/assertions.js, one per sub-patch, written against
//     README.md's "How it works" bullets;
//   - rollover idempotence: patching an already-patched bundle (with the current marker
//     or an older one) must give exactly what patching the clean bundle gives, so a
//     sentinel block left behind by a retired patch cannot survive a marker bump;
//   - no stray sentinels: no `/*__ccaa` may remain after a revert.
//
// Exit code is 1 when any sub-patch is skipped or any check fails.
//
//   node scripts/check.js                      # newest ~/.vscode/extensions/anthropic.claude-code-*
//   node scripts/check.js --all                # every installed version (old ones skip newer anchors)
//   node scripts/check.js ~/.vscode/extensions/anthropic.claude-code-2.1.261-darwin-arm64
//   node scripts/check.js --write-clean DIR    # also dump the clean bundles to DIR/<version>/
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'vscode') return { workspace: { getConfiguration: () => ({ get: (key, fallback) => fallback }) } };
  return origLoad.call(this, request, ...rest);
};
const ext = require(path.join(__dirname, '..', 'extension.js'));
const { assertions } = require(path.join(__dirname, 'assertions.js'));

const args = process.argv.slice(2);
let cleanOut = null;
const cleanFlag = args.indexOf('--write-clean');
if (cleanFlag !== -1) {
  cleanOut = args[cleanFlag + 1];
  args.splice(cleanFlag, 2);
}
const allFlag = args.indexOf('--all');
const all = allFlag !== -1;
if (all) args.splice(allFlag, 1);
const semver = (name) => (name.match(/(\d+)\.(\d+)\.(\d+)/) || []).slice(1, 4).map(Number);
const byVersion = (a, b) => {
  const [x, y] = [semver(a), semver(b)];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};
let dirs = args;
if (!dirs.length) {
  const installed = fs
    .readdirSync(path.join(os.homedir(), '.vscode', 'extensions'))
    .filter((name) => name.startsWith('anthropic.claude-code-'))
    .sort(byVersion)
    .map((name) => path.join(os.homedir(), '.vscode', 'extensions', name));
  dirs = all ? installed : installed.slice(-1);
}

const sites = [
  { rel: 'webview/index.js', compute: ext.computeWebviewPatch, revert: ext.revertWebviewPatch, js: true },
  { rel: 'webview/index.css', compute: ext.computePromptHeightPatch, revert: ext.revertPromptHeightPatch, js: false },
  { rel: 'extension.js', compute: ext.computeExtensionPatch, revert: ext.revertExtensionPatch, js: true },
];

function parseError(content) {
  try {
    new vm.Script(content);
    return null;
  } catch (e) {
    return e.message;
  }
}

const OPTIONS = { detachContextByDefault: true };
const MARKER_LINE_RE = /^\/\*claude-code-no-auto-attach:v[^*]+\*\/\n/;
// Markers this extension has shipped under before the current one. Each stands for a
// bundle already patched by an older build, which is what applyPatch meets on an update.
const OLD_MARKERS = ['/*claude-code-no-auto-attach:v1*/', '/*claude-code-no-auto-attach:v48*/', '/*claude-code-no-auto-attach:v50*/'];

// Patching an already-patched bundle must land exactly where patching the clean one does.
// It is the revert that has to hold that up, so this catches a sub-patch whose revert
// helper was dropped or mistyped — including one retired along with its injection, whose
// block then survives every later marker bump invisibly (revert-then-reapply is what
// applyPatch does on disk, and check.js reverts the on-disk marker before it looks).
function rolloverProblem(site, clean, fresh) {
  const onDisk = [['the current marker', fresh]];
  for (const marker of OLD_MARKERS) {
    onDisk.push([`marker ${marker}`, fresh.replace(MARKER_LINE_RE, () => marker + '\n')]);
  }
  for (const [label, content] of onDisk) {
    const reverted = site.revert(content);
    if (!reverted.reverted) return `rollover: a bundle carrying ${label} is not recognised as patched`;
    const again = site.compute(reverted.content, OPTIONS);
    if (!again.patched) return `rollover: re-patching a bundle carrying ${label} fails (${again.reason})`;
    if (again.content !== fresh) {
      return `rollover: re-patching a bundle carrying ${label} does not match a fresh patch of the clean bundle`;
    }
  }
  return null;
}

function strayProblem(label, content) {
  const index = content.indexOf('/*__ccaa');
  if (index === -1) return null;
  const sentinel = (content.slice(index).match(/^\/\*__ccaa[\w:]*/) || ['/*__ccaa'])[0];
  return `${label} still carries a sentinel (${sentinel})`;
}

function assertionProblems(rel, patched, clean, ctx) {
  const problems = [];
  for (const assertion of assertions) {
    if (assertion.rel !== rel) continue;
    if (assertion.applies && !assertion.applies(clean, ctx)) continue;
    let failure;
    try {
      failure = assertion.check(patched, clean, ctx);
    } catch (e) {
      failure = `assertion threw: ${e.message}`;
    }
    if (failure) problems.push(`${assertion.name}: ${failure}`);
  }
  return problems;
}

let failed = false;
for (const dir of dirs) {
  const version = path.basename(dir).replace(/^anthropic\.claude-code-/, '');
  console.log(`== ${version}`);
  for (const site of sites) {
    const onDisk = fs.readFileSync(path.join(dir, site.rel), 'utf8');
    const reverted = site.revert(onDisk);
    const clean = reverted.reverted ? reverted.content : onDisk;
    if (cleanOut) {
      const target = path.join(cleanOut, version, site.rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, clean);
    }

    const result = site.compute(clean, OPTIONS);
    const problems = [];
    if (!result.patched) problems.push(`not patched: ${result.reason}`);
    for (const warning of result.warnings || []) problems.push(`skipped ${warning}`);
    // The clean bundle comes from reverting whatever is on disk, so a sentinel surviving
    // here is a block this build no longer knows how to revert.
    const stray = strayProblem('the clean bundle (reverted from disk)', clean);
    if (stray) problems.push(stray);
    if (result.patched) {
      if (site.js) {
        const error = parseError(result.content);
        if (error) problems.push(`patched bundle does not parse: ${error}`);
      }
      const reapplied = site.revert(result.content);
      if (reapplied.content !== clean) problems.push('revert does not restore the clean bundle');
      const strayAfterRevert = strayProblem('the reverted bundle', reapplied.content);
      if (strayAfterRevert) problems.push(strayAfterRevert);
      const rollover = rolloverProblem(site, clean, result.content);
      if (rollover) problems.push(rollover);
      const ctx = { version, semver: semver(version), rel: site.rel, compute: site.compute };
      problems.push(...assertionProblems(site.rel, result.content, clean, ctx));
    }

    const status = problems.length ? 'FAIL' : 'ok';
    if (problems.length) failed = true;
    console.log(`  ${status.padEnd(4)} ${site.rel}${reverted.reverted ? ' (on disk: patched)' : ' (on disk: clean)'}`);
    for (const problem of problems) console.log(`       - ${problem}`);
  }
}
process.exit(failed ? 1 : 0);
