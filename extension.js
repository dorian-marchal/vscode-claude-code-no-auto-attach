const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const MARKER = '/*claude-code-no-auto-attach:v1*/';
const TARGET_EXT_ID = 'Anthropic.claude-code';

function escapeRegex(s) {
  return s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
}

function computePatch(content) {
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

function getClaudeExtension() {
  return vscode.extensions.getExtension(TARGET_EXT_ID);
}

async function applyPatch(channel, { interactive = false } = {}) {
  const ext = getClaudeExtension();
  if (!ext) {
    channel.appendLine('[no-auto-attach] Claude Code extension not installed; nothing to patch.');
    if (interactive) {
      vscode.window.showWarningMessage('Claude Code extension not found.');
    }
    return;
  }

  const webviewPath = path.join(ext.extensionPath, 'webview', 'index.js');
  let content;
  try {
    content = fs.readFileSync(webviewPath, 'utf8');
  } catch (e) {
    channel.appendLine(`[no-auto-attach] Could not read ${webviewPath}: ${e.message}`);
    if (interactive) {
      vscode.window.showErrorMessage(`Failed to read Claude Code webview bundle: ${e.message}`);
    }
    return;
  }

  const result = computePatch(content);
  if (!result.patched) {
    channel.appendLine(`[no-auto-attach] Skipped (${result.reason}).`);
    if (interactive) {
      vscode.window.showInformationMessage(`Patch not applied: ${result.reason}`);
    }
    return;
  }

  try {
    fs.writeFileSync(webviewPath, result.content, 'utf8');
  } catch (e) {
    channel.appendLine(`[no-auto-attach] Failed to write ${webviewPath}: ${e.message}`);
    vscode.window.showErrorMessage(`Failed to patch Claude Code: ${e.message}`);
    return;
  }

  channel.appendLine(`[no-auto-attach] Patched ${webviewPath}`);
  const action = await vscode.window.showInformationMessage(
    'Claude Code file-attach will now default to OFF. Reload window to apply.',
    'Reload Window',
    'Later'
  );
  if (action === 'Reload Window') {
    vscode.commands.executeCommand('workbench.action.reloadWindow');
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
    vscode.commands.registerCommand('claude-code-no-auto-attach.revert', async () => {
      const ext = getClaudeExtension();
      if (!ext) {
        vscode.window.showWarningMessage('Claude Code extension not found.');
        return;
      }
      vscode.window.showInformationMessage(
        'To revert, reinstall Claude Code: "Extensions: Show Installed Extensions" → Claude Code → gear icon → Reinstall. The marker will be gone and the patch will not re-apply until you run Reapply.'
      );
    })
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
