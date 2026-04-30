const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const MARKER = '/*claude-code-no-auto-attach:v5*/';
const MARKER_RE = /^\/\*claude-code-no-auto-attach:v[^*]+\*\/\n/;
const TARGET_EXT_ID = 'Anthropic.claude-code';

function escapeRegex(s) {
  return s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
}

function stripMarker(content) {
  const m = content.match(MARKER_RE);
  return m ? content.slice(m[0].length) : null;
}

function computeWebviewPatch(content) {
  if (content.startsWith(MARKER)) {
    return { patched: false, reason: 'already patched' };
  }

  const ownerRe = /includeSelection:([A-Za-z_$][\w$]*),onToggleIncludeSelection:\(\)=>([A-Za-z_$][\w$]*)\(/g;
  const matches = [...content.matchAll(ownerRe)];
  if (matches.length === 0) {
    return { patched: false, reason: 'owner site not found (Claude Code internals may have changed)' };
  }
  if (matches.length > 1) {
    return { patched: false, reason: `ambiguous: ${matches.length} owner sites found` };
  }

  const [, stateVar, setterVar] = matches[0];
  const declRe = new RegExp(
    `(\\[${escapeRegex(stateVar)},${escapeRegex(setterVar)}\\]=[A-Za-z_$][\\w$]*\\.useState\\()!0(\\))`
  );
  if (!declRe.test(content)) {
    return { patched: false, reason: `useState(!0) init for [${stateVar},${setterVar}] not found` };
  }

  const next = MARKER + '\n' + content.replace(declRe, '$1!1$2');
  return { patched: true, content: next };
}

function revertWebviewPatch(content) {
  const stripped = stripMarker(content);
  if (stripped === null) return { reverted: false, reason: 'not patched' };

  const ownerRe = /includeSelection:([A-Za-z_$][\w$]*),onToggleIncludeSelection:\(\)=>([A-Za-z_$][\w$]*)\(/g;
  const matches = [...stripped.matchAll(ownerRe)];
  if (matches.length !== 1) {
    return { reverted: false, reason: 'owner site not found/ambiguous on revert' };
  }
  const [, stateVar, setterVar] = matches[0];
  const declRe = new RegExp(
    `(\\[${escapeRegex(stateVar)},${escapeRegex(setterVar)}\\]=[A-Za-z_$][\\w$]*\\.useState\\()!1(\\))`
  );
  const next = declRe.test(stripped) ? stripped.replace(declRe, '$1!0$2') : stripped;
  return { reverted: true, content: next };
}

function injectCanUseToolGuard(content) {
  const anchorRe = /if\((\w+)\.request\.subtype==="can_use_tool"\)\{if\(!this\.canUseTool\)throw Error\("canUseTool callback is not provided\."\);/g;
  const matches = [...content.matchAll(anchorRe)];
  if (matches.length === 0) {
    return { ok: false, reason: 'can_use_tool anchor not found (Claude Code internals may have changed)' };
  }
  if (matches.length > 1) {
    return { ok: false, reason: `ambiguous: ${matches.length} can_use_tool anchors found` };
  }

  const [anchor, varName] = matches[0];
  const insertion =
    `try{var __ccaaCfg=require("vscode").workspace.getConfiguration("claude-code-no-auto-attach");` +
    `if(__ccaaCfg.get("autoApproveProtectedPathWrites",false)&&globalThis.__ccaaPermissionMode==="bypassPermissions"&&["Write","Edit","MultiEdit","NotebookEdit","Bash"].includes(${varName}.request.tool_name))` +
    `return{behavior:"allow",updatedInput:${varName}.request.input,toolUseID:${varName}.request.tool_use_id};}catch(__ccaaErr){}`;

  return { ok: true, content: content.replace(anchor, anchor + insertion) };
}

function injectPermissionModeCapture(content) {
  const anchorRe = /setPermissionMode\((\w+)\)\{await this\.request\(\{subtype:"set_permission_mode",mode:\1\}\)\}/g;
  const matches = [...content.matchAll(anchorRe)];
  if (matches.length === 0) {
    return { ok: false, reason: 'setPermissionMode anchor not found (Claude Code internals may have changed)' };
  }
  if (matches.length > 1) {
    return { ok: false, reason: `ambiguous: ${matches.length} setPermissionMode anchors found` };
  }

  const [anchor, varName] = matches[0];
  const replacement = anchor.replace(`${varName}){`, `${varName}){globalThis.__ccaaPermissionMode=${varName};`);
  return { ok: true, content: content.replace(anchor, replacement) };
}

function computeExtensionPatch(content) {
  if (content.startsWith(MARKER)) {
    return { patched: false, reason: 'already patched' };
  }

  const guard = injectCanUseToolGuard(content);
  if (!guard.ok) return { patched: false, reason: guard.reason };

  const capture = injectPermissionModeCapture(guard.content);
  if (!capture.ok) return { patched: false, reason: capture.reason };

  return { patched: true, content: MARKER + '\n' + capture.content };
}

function revertExtensionPatch(content) {
  const stripped = stripMarker(content);
  if (stripped === null) return { reverted: false, reason: 'not patched' };

  const guardRe = /try\{var __ccaaCfg=require\("vscode"\)\.workspace\.getConfiguration\("claude-code-no-auto-attach"\);[\s\S]*?\}catch\(__ccaaErr\)\{\}/;
  let next = guardRe.test(stripped) ? stripped.replace(guardRe, '') : stripped;

  const captureRe = /(setPermissionMode\((\w+)\)\{)globalThis\.__ccaaPermissionMode=\2;/;
  next = captureRe.test(next) ? next.replace(captureRe, '$1') : next;

  return { reverted: true, content: next };
}

const PATCH_SITES = [
  {
    relativePath: ['webview', 'index.js'],
    description: 'default file-attach toggle to OFF',
    compute: computeWebviewPatch,
    revert: revertWebviewPatch,
  },
  {
    relativePath: ['extension.js'],
    description: 'auto-allow gitignored Write/Edit prompts (bypass mode only) + capture permission mode',
    compute: computeExtensionPatch,
    revert: revertExtensionPatch,
  },
];

function getClaudeExtension() {
  return vscode.extensions.getExtension(TARGET_EXT_ID);
}

function findClaudeExtensionDirs() {
  const ext = getClaudeExtension();
  if (!ext) return [];

  const extensionsRoot = path.dirname(ext.extensionPath);
  const prefix = TARGET_EXT_ID.toLowerCase() + '-';
  let entries;
  try {
    entries = fs.readdirSync(extensionsRoot, { withFileTypes: true });
  } catch {
    return [ext.extensionPath];
  }

  const dirs = entries
    .filter((e) => e.isDirectory() && e.name.toLowerCase().startsWith(prefix))
    .map((e) => path.join(extensionsRoot, e.name));

  return dirs.length ? dirs : [ext.extensionPath];
}

async function applyPatch(channel, { interactive = false } = {}) {
  const dirs = findClaudeExtensionDirs();
  if (dirs.length === 0) {
    channel.appendLine('[no-auto-attach] Claude Code extension not installed; nothing to patch.');
    if (interactive) {
      vscode.window.showWarningMessage('Claude Code extension not found.');
    }
    return;
  }

  let anyApplied = false;
  const skipMessages = [];

  for (const dir of dirs) {
    for (const site of PATCH_SITES) {
      const filePath = path.join(dir, ...site.relativePath);
      const relLabel = `${path.basename(dir)}/${site.relativePath.join('/')}`;

      let content;
      try {
        content = fs.readFileSync(filePath, 'utf8');
      } catch (e) {
        channel.appendLine(`[no-auto-attach] Could not read ${filePath}: ${e.message}`);
        continue;
      }

      const reverted = site.revert(content);
      const baseContent = reverted.reverted ? reverted.content : content;

      const result = site.compute(baseContent);
      if (!result.patched) {
        channel.appendLine(`[no-auto-attach] Skipped ${relLabel} (${result.reason}).`);
        skipMessages.push(`${relLabel}: ${result.reason}`);
        continue;
      }

      if (result.content === content) {
        channel.appendLine(`[no-auto-attach] Skipped ${relLabel} (already at current version).`);
        continue;
      }

      try {
        fs.writeFileSync(filePath, result.content, 'utf8');
      } catch (e) {
        channel.appendLine(`[no-auto-attach] Failed to write ${filePath}: ${e.message}`);
        vscode.window.showErrorMessage(`Failed to patch ${relLabel}: ${e.message}`);
        continue;
      }

      channel.appendLine(`[no-auto-attach] Patched ${filePath} (${site.description}).`);
      anyApplied = true;
    }
  }

  if (anyApplied) {
    const action = await vscode.window.showInformationMessage(
      'Claude Code patches applied. Reload window to take effect.',
      'Reload Window',
      'Later'
    );
    if (action === 'Reload Window') {
      vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  } else if (interactive) {
    vscode.window.showInformationMessage(
      `No patches applied. ${skipMessages.join('; ') || 'See output channel for details.'}`
    );
  }
}

async function revertPatch(channel) {
  const dirs = findClaudeExtensionDirs();
  if (dirs.length === 0) {
    vscode.window.showWarningMessage('Claude Code extension not found.');
    return;
  }

  let anyReverted = false;
  const skipMessages = [];

  for (const dir of dirs) {
    for (const site of PATCH_SITES) {
      const filePath = path.join(dir, ...site.relativePath);
      const relLabel = `${path.basename(dir)}/${site.relativePath.join('/')}`;

      let content;
      try {
        content = fs.readFileSync(filePath, 'utf8');
      } catch (e) {
        channel.appendLine(`[no-auto-attach] Could not read ${filePath}: ${e.message}`);
        continue;
      }

      const result = site.revert(content);
      if (!result.reverted) {
        channel.appendLine(`[no-auto-attach] Skipped revert ${relLabel} (${result.reason}).`);
        skipMessages.push(`${relLabel}: ${result.reason}`);
        continue;
      }

      try {
        fs.writeFileSync(filePath, result.content, 'utf8');
      } catch (e) {
        channel.appendLine(`[no-auto-attach] Failed to write ${filePath}: ${e.message}`);
        vscode.window.showErrorMessage(`Failed to revert ${relLabel}: ${e.message}`);
        continue;
      }

      channel.appendLine(`[no-auto-attach] Reverted ${filePath}.`);
      anyReverted = true;
    }
  }

  if (anyReverted) {
    const action = await vscode.window.showInformationMessage(
      'Claude Code patches reverted. Reload window to take effect. Auto-reapply on next startup will re-patch — disable the extension first if you want a permanent revert.',
      'Reload Window',
      'Later'
    );
    if (action === 'Reload Window') {
      vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  } else {
    vscode.window.showInformationMessage(
      `Nothing to revert. ${skipMessages.join('; ') || 'No patched files found.'}`
    );
  }
}

function activate(context) {
  const channel = vscode.window.createOutputChannel('Claude Code: No Auto-Attach');
  context.subscriptions.push(channel);

  applyPatch(channel);

  context.subscriptions.push(
    vscode.extensions.onDidChange(() => {
      channel.appendLine('[no-auto-attach] Extensions changed; re-checking patch.');
      applyPatch(channel);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claude-code-no-auto-attach.apply', () =>
      applyPatch(channel, { interactive: true })
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claude-code-no-auto-attach.revert', () =>
      revertPatch(channel)
    )
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
