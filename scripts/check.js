#!/usr/bin/env node
// Dry-run every patch against the installed Claude Code versions (or the dirs given as
// arguments) without touching them. For each target file: revert whatever marker is on
// disk to get the clean upstream bundle, run the patch, and report per sub-patch skips,
// whether the result parses, and whether reverting it gives the clean bundle back.
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

    const result = site.compute(clean, { detachContextByDefault: true });
    const problems = [];
    if (!result.patched) problems.push(`not patched: ${result.reason}`);
    for (const warning of result.warnings || []) problems.push(`skipped ${warning}`);
    if (result.patched) {
      if (site.js) {
        const error = parseError(result.content);
        if (error) problems.push(`patched bundle does not parse: ${error}`);
      }
      if (site.revert(result.content).content !== clean) problems.push('revert does not restore the clean bundle');
    }

    const status = problems.length ? 'FAIL' : 'ok';
    if (problems.length) failed = true;
    console.log(`  ${status.padEnd(4)} ${site.rel}${reverted.reverted ? ' (on disk: patched)' : ' (on disk: clean)'}`);
    for (const problem of problems) console.log(`       - ${problem}`);
  }
}
process.exit(failed ? 1 : 0);
