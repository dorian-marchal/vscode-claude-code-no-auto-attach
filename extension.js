const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const MARKER = '/*claude-code-no-auto-attach:v15*/';
const MARKER_RE = /^\/\*claude-code-no-auto-attach:v[^*]+\*\/\n/;
const TARGET_EXT_ID = 'Anthropic.claude-code';

function escapeRegex(s) {
  return s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
}

// Replace a single regex match at its exact index (avoids first-occurrence ambiguity
// and `$`-in-replacement pitfalls of String.prototype.replace).
function replaceMatch(content, match, replacement) {
  return content.slice(0, match.index) + replacement + content.slice(match.index + match[0].length);
}

function stripMarker(content) {
  const m = content.match(MARKER_RE);
  return m ? content.slice(m[0].length) : null;
}

// --- webview/index.js sub-patches ---

// Locate the useState init for the include-selection toggle. The [state,setter] pair name
// is reused by other components earlier in the bundle, so anchor on the declaration closest
// *before* the toggle prop (it lives in the same component) rather than the first match in
// the file — otherwise revert flips the wrong component's state.
function findIncludeSelectionUseState(content) {
  const ownerRe = /includeSelection:([A-Za-z_$][\w$]*),onToggleIncludeSelection:\(\)=>([A-Za-z_$][\w$]*)\(/g;
  const owners = [...content.matchAll(ownerRe)];
  if (owners.length === 0) {
    return { ok: false, reason: 'owner site not found (Claude Code internals may have changed)' };
  }
  if (owners.length > 1) {
    return { ok: false, reason: `ambiguous: ${owners.length} owner sites found` };
  }

  const [, stateVar, setterVar] = owners[0];
  const toggleIndex = owners[0].index;
  const declRe = new RegExp(
    `\\[${escapeRegex(stateVar)},${escapeRegex(setterVar)}\\]=[A-Za-z_$][\\w$]*\\.useState\\((!0|!1)\\)`,
    'g'
  );
  let best = null;
  for (const m of content.matchAll(declRe)) {
    if (m.index < toggleIndex) best = m;
    else break;
  }
  if (!best) {
    return { ok: false, reason: `useState init for [${stateVar},${setterVar}] not found` };
  }
  return { ok: true, match: best, init: best[1] };
}

function injectAttachToggleOff(content) {
  const found = findIncludeSelectionUseState(content);
  if (!found.ok) return found;
  if (found.init === '!1') return { ok: true, content }; // already detached
  return { ok: true, content: replaceMatch(content, found.match, found.match[0].replace(/\(!0\)$/, '(!1)')) };
}

function revertAttachToggleOff(content) {
  const found = findIncludeSelectionUseState(content);
  if (!found.ok || found.init === '!0') return content; // nothing to revert
  return replaceMatch(content, found.match, found.match[0].replace(/\(!1\)$/, '(!0)'));
}

const CONTEXT_TOGGLE_REVERT_RE =
  /onToggleIncludeSelection:\/\*__ccaaCtxToggle\*\/[\s\S]*?globalThis\.__ccaaToggleContext=\(\)=>([\w$]+)\([\s\S]*?\/\*__ccaaCtxToggleEnd\*\//;

// Expose the composer's include-selection toggle as a global and bind a capture-phase
// Ctrl+F keydown that flips it — so the current file/selection can be attached/detached
// from the keyboard while a Claude session is focused. The click toggle still works
// (the original setter is preserved and reconstructed byte-exact on revert).
function injectContextToggleShortcut(content) {
  const anchorRe =
    /includeSelection:([A-Za-z_$][\w$]*),onToggleIncludeSelection:\(\)=>([A-Za-z_$][\w$]*)\(\(([A-Za-z_$][\w$]*)\)=>!\3\)/g;
  const matches = [...content.matchAll(anchorRe)];
  if (matches.length === 0) {
    return { ok: false, reason: 'include-selection toggle site not found (Claude Code internals may have changed)' };
  }
  if (matches.length > 1) {
    return { ok: false, reason: `ambiguous: ${matches.length} include-selection toggle sites found` };
  }

  const [whole, stateVar, setterVar] = matches[0];
  const replacement =
    `includeSelection:${stateVar},onToggleIncludeSelection:/*__ccaaCtxToggle*/(()=>{` +
    `globalThis.__ccaaToggleContext=()=>${setterVar}((__ccaaT)=>!__ccaaT);` +
    `if(!globalThis.__ccaaContextKeyBound){globalThis.__ccaaContextKeyBound=!0;` +
    `window.addEventListener("keydown",(__ccaaE)=>{` +
    `if(__ccaaE.ctrlKey&&!__ccaaE.metaKey&&!__ccaaE.altKey&&!__ccaaE.shiftKey&&(__ccaaE.key==="f"||__ccaaE.key==="F")){` +
    `__ccaaE.preventDefault();__ccaaE.stopPropagation();globalThis.__ccaaToggleContext?.()}},!0)}` +
    `return globalThis.__ccaaToggleContext})()/*__ccaaCtxToggleEnd*/`;

  return { ok: true, content: content.replace(whole, () => replacement) };
}

function revertContextToggle(content) {
  return CONTEXT_TOGGLE_REVERT_RE.test(content)
    ? content.replace(CONTEXT_TOGGLE_REVERT_RE, (_, setterVar) => `onToggleIncludeSelection:()=>${setterVar}(($)=>!$)`)
    : content;
}

const MODEL_UI_SENTINEL_RE = /;\/\*__ccaaModelUi\*\/[\s\S]*?\/\*__ccaaModelUiEnd\*\//g;

// Inside the reactive effect that registers the "Switch model…" command action, append:
// - a per-session model badge (fixed top-right of the webview, click opens the picker,
//   warning colors when the session is on a Fable model)
// - a Ctrl+M keydown handler (capture phase) that cycles through available models for
//   the session rendered in this webview.
function injectModelUi(content) {
  // Match both the pre-2.1.177 inline label computation and the 2.1.177+ form, where it was
  // extracted into a helper (…,ze=GCe(q,t.lastServedModel.value,Te);n.commandRegistry.registerAction…).
  // We anchor on the stable bits — the modelSelection/claudeConfig reads and the
  // registerAction("model") call — and read the trailing-component label var straight off the
  // registerAction options instead of the (refactored) inline declaration.
  const anchorRe =
    /let ([\w$]+)=([\w$]+)\.modelSelection\.value,[\w$]+=[\w$]+\(\2\.claudeConfig\.value\),[\s\S]{0,400}?\.registerAction\(\{id:"model",label:"Switch model…",description:"Change the AI model",trailingComponent:([\w$]+)\?[\s\S]{0,200}?\},"Model",\(\)=>\{([\w$]+)\(!0\)\}\)/g;
  const matches = [...content.matchAll(anchorRe)];
  if (matches.length === 0) {
    return { ok: false, reason: 'model action site not found (Claude Code internals may have changed)' };
  }
  if (matches.length > 1) {
    return { ok: false, reason: `ambiguous: ${matches.length} model action sites found` };
  }

  const [anchor, , sessionVar, nameVar, openPickerVar] = matches[0];
  const insertion =
    `;/*__ccaaModelUi*/try{` +
    `var __ccaaBadge=document.getElementById("ccaa-model-badge");` +
    `if(!__ccaaBadge){__ccaaBadge=document.createElement("div");__ccaaBadge.id="ccaa-model-badge";` +
    `__ccaaBadge.style.cssText="position:fixed;top:36px;right:14px;z-index:99999;padding:1px 8px;border-radius:9px;font-size:11px;font-family:var(--vscode-font-family);line-height:16px;cursor:pointer;user-select:none;opacity:.95";` +
    `document.body.appendChild(__ccaaBadge)}` +
    `__ccaaBadge.onclick=()=>${openPickerVar}(!0);` +
    `var __ccaaModels=${sessionVar}.claudeConfig.value?.models??[];` +
    `var __ccaaSelected=${sessionVar}.modelSelection.value??"default";` +
    `var __ccaaLabel=${nameVar}??__ccaaModels.find((__ccaaM)=>__ccaaM.value===__ccaaSelected)?.displayName??__ccaaSelected;` +
    `var __ccaaServed=${sessionVar}.currentMainLoopModel.value??"";` +
    `__ccaaBadge.textContent=String(__ccaaLabel);` +
    `__ccaaBadge.title="Claude model (click to switch, Ctrl+M to cycle)";` +
    `var __ccaaExpensive=/fable/i.test(String(__ccaaSelected))||/fable/i.test(String(__ccaaLabel))||/fable/i.test(String(__ccaaServed));` +
    `__ccaaBadge.style.background=__ccaaExpensive?"var(--vscode-statusBarItem-warningBackground,#915e00)":"var(--vscode-badge-background,#4d4d4d)";` +
    `__ccaaBadge.style.color=__ccaaExpensive?"var(--vscode-statusBarItem-warningForeground,#fff)":"var(--vscode-badge-foreground,#fff)";` +
    `globalThis.__ccaaCycleModel=()=>{` +
    `var __ccaaList=${sessionVar}.claudeConfig.value?.models??[];if(__ccaaList.length<2)return;` +
    `var __ccaaCurrent=${sessionVar}.modelSelection.value??"default";` +
    `var __ccaaIndex=__ccaaList.findIndex((__ccaaM)=>__ccaaM.value===__ccaaCurrent);` +
    `${sessionVar}.setModel(__ccaaList[(__ccaaIndex+1)%__ccaaList.length])};` +
    `if(!globalThis.__ccaaModelKeyBound){globalThis.__ccaaModelKeyBound=!0;` +
    `window.addEventListener("keydown",(__ccaaE)=>{` +
    `if(__ccaaE.ctrlKey&&!__ccaaE.metaKey&&!__ccaaE.altKey&&!__ccaaE.shiftKey&&(__ccaaE.key==="m"||__ccaaE.key==="M")){` +
    `__ccaaE.preventDefault();__ccaaE.stopPropagation();globalThis.__ccaaCycleModel?.()}},!0)}` +
    `}catch(__ccaaErr2){}/*__ccaaModelUiEnd*/`;

  return { ok: true, content: content.replace(anchor, anchor + insertion) };
}

const SEND_MODEL_BUTTONS_SENTINEL_RE = /\/\*__ccaaSendBtns\*\/[\s\S]*?\/\*__ccaaSendBtnsEnd\*\//g;

// Add two extra send buttons next to the composer's send button — one switches the session
// to Sonnet, one to Haiku — then submit the prompt. They reuse the session's setModel
// (session-scoped via the extension.js patch) and the form's native submit path, so the
// only new behavior is "switch model on the fly, then send". Each button hides itself when
// its model isn't available for the session. The original send button (and its send/stop
// animation) is left untouched; the new ones sit to its right as plain shortcuts.
function injectSendModelButtons(content) {
  const anchorRe =
    /([\w$]+(?:\.[\w$]+)*)\.createElement\("button",\{type:"submit",disabled:!([\w$]+)\.busy\.value&&!([\w$]+),className:([\w$]+)\.sendButton,"data-permission-mode":([\w$]+),onClick:\(([\w$]+)\)=>\{if\(\2\.busy\.value&&!\3\)\6\.preventDefault\(\),\2\.interrupt\(\)\}\},([\w$]+)\)/g;
  const matches = [...content.matchAll(anchorRe)];
  if (matches.length === 0) {
    return { ok: false, reason: 'send button site not found (Claude Code internals may have changed)' };
  }
  if (matches.length > 1) {
    return { ok: false, reason: `ambiguous: ${matches.length} send button sites found` };
  }

  const [anchor, ce, sess, canSubmit, clsObj, , , icon] = matches[0];

  const button = (modelRe, background, color) =>
    `(()=>{` +
    `var __ccaaModels=${sess}.claudeConfig.value?.models??[];` +
    `var __ccaaTarget=__ccaaModels.find((__ccaaM)=>${modelRe}.test(__ccaaM.value)||${modelRe}.test(__ccaaM.displayName));` +
    `if(!__ccaaTarget)return null;` +
    `var __ccaaDisabled=${sess}.busy.value||!${canSubmit};` +
    `return ${ce}.createElement("button",{type:"button",className:${clsObj}.sendButton,` +
    `disabled:__ccaaDisabled,` +
    `title:"Send with "+__ccaaTarget.displayName,` +
    `style:{background:${JSON.stringify(background)},color:${JSON.stringify(color)},opacity:__ccaaDisabled?.45:1},` +
    `onClick:(__ccaaEv)=>{__ccaaEv.preventDefault();` +
    `var __ccaaForm=__ccaaEv.currentTarget.closest("form");` +
    `Promise.resolve(${sess}.modelSelection.value===__ccaaTarget.value?null:${sess}.setModel(__ccaaTarget))` +
    `.then(()=>{if(__ccaaForm)__ccaaForm.requestSubmit()})}` +
    `},${icon})})()`;

  const sonnet = button('/sonnet/i', '#e0b341', '#1a1a1a');
  const haiku = button('/haiku/i', '#2ea043', '#ffffff');
  const insertion = `/*__ccaaSendBtns*/,${sonnet},${haiku}/*__ccaaSendBtnsEnd*/`;

  return { ok: true, content: content.replace(anchor, () => anchor + insertion) };
}

// --- extension.js sub-patches ---

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
    `if(__ccaaCfg.get("autoApproveProtectedPathWrites",false)&&(globalThis.__ccaaPermissionMode===undefined||globalThis.__ccaaPermissionMode==="bypassPermissions")&&["Write","Edit","MultiEdit","NotebookEdit","Bash"].includes(${varName}.request.tool_name))` +
    `return{behavior:"allow",updatedInput:${varName}.request.input,toolUseID:${varName}.request.tool_use_id};}catch(__ccaaErr){}`;

  return { ok: true, content: content.replace(anchor, anchor + insertion) };
}

function revertCanUseToolGuard(content) {
  const guardRe = /try\{var __ccaaCfg=require\("vscode"\)\.workspace\.getConfiguration\("claude-code-no-auto-attach"\);[\s\S]*?\}catch\(__ccaaErr\)\{\}/;
  return guardRe.test(content) ? content.replace(guardRe, '') : content;
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

function revertPermissionModeCapture(content) {
  const captureRe = /(setPermissionMode\((\w+)\)\{)globalThis\.__ccaaPermissionMode=\2;/;
  return captureRe.test(content) ? content.replace(captureRe, '$1') : content;
}

const SESSION_MODEL_SENTINEL_RE = /\/\*__ccaaSessionModel\*\/[\s\S]*?\/\*__ccaaSessionModelEnd\*\//g;

// Upstream persists every model switch to ~/.claude/settings.json (it becomes the new
// global default). Reroute it to the SDK's session-scoped set_model control request so
// switching only affects the current session.
function injectSessionScopedModel(content) {
  const anchorRe =
    /async setModel\((\w+),(\w+)\)\{return await this\.writeUserSettingsAndPush\(\1,\{model:\2\.value==="default"\?null:\2\.value\}\),\{type:"set_model_response"\}\}/g;
  const matches = [...content.matchAll(anchorRe)];
  if (matches.length === 0) {
    return { ok: false, reason: 'setModel anchor not found (Claude Code internals may have changed)' };
  }
  if (matches.length > 1) {
    return { ok: false, reason: `ambiguous: ${matches.length} setModel anchors found` };
  }

  const [anchor, channelVar, modelVar] = matches[0];
  const insertion =
    `/*__ccaaSessionModel*/var __ccaaScoped=true;` +
    `try{__ccaaScoped=require("vscode").workspace.getConfiguration("claude-code-no-auto-attach").get("sessionScopedModelSwitch",true)}catch(__ccaaErr2){}` +
    `if(__ccaaScoped)return await this.withChannel(${channelVar},async(__ccaaChannel)=>(await __ccaaChannel.query.setModel(${modelVar}.value==="default"?void 0:${modelVar}.value),{type:"set_model_response"}));` +
    `/*__ccaaSessionModelEnd*/`;
  const replacement = anchor.replace(`async setModel(${channelVar},${modelVar}){`, `async setModel(${channelVar},${modelVar}){${insertion}`);
  return { ok: true, content: content.replace(anchor, replacement) };
}

// --- per-file compute/revert ---

function runSubPatches(content, subPatches) {
  const warnings = [];
  let next = content;
  let appliedCount = 0;

  for (const sub of subPatches) {
    const result = sub.inject(next);
    if (result.ok) {
      next = result.content;
      appliedCount += 1;
    } else {
      warnings.push(`${sub.name}: ${result.reason}`);
    }
  }

  if (appliedCount === 0) {
    return { patched: false, reason: warnings.join('; ') };
  }
  return { patched: true, content: MARKER + '\n' + next, warnings };
}

function computeWebviewPatch(content, { detachContextByDefault = true } = {}) {
  if (content.startsWith(MARKER)) {
    return { patched: false, reason: 'already patched' };
  }
  const subPatches = [];
  // Default the include-selection toggle to OFF only when the setting allows it; when off,
  // the upstream "attached by default" behavior is kept (the Ctrl+F toggle still works).
  if (detachContextByDefault) {
    subPatches.push({ name: 'attach-toggle-off', inject: injectAttachToggleOff });
  }
  subPatches.push(
    { name: 'model-badge-and-shortcut', inject: injectModelUi },
    { name: 'context-toggle-shortcut', inject: injectContextToggleShortcut },
    { name: 'send-model-buttons', inject: injectSendModelButtons }
  );
  return runSubPatches(content, subPatches);
}

function revertWebviewPatch(content) {
  const stripped = stripMarker(content);
  if (stripped === null) return { reverted: false, reason: 'not patched' };

  // Revert the context toggle first so the attach-toggle anchor (which reads the clean
  // onToggleIncludeSelection prop) resolves again.
  let next = revertContextToggle(stripped);
  next = revertAttachToggleOff(next);
  next = next.replace(MODEL_UI_SENTINEL_RE, '');
  next = next.replace(SEND_MODEL_BUTTONS_SENTINEL_RE, '');
  return { reverted: true, content: next };
}

const PROMPT_HEIGHT_SENTINEL_RE = /\n?\/\*__ccaaPromptHeight\*\/[\s\S]*?\/\*__ccaaPromptHeightEnd\*\//g;

// Cap the height of rendered user prompts so a huge pasted prompt (e.g. a long
// error log) no longer fills the whole webview — the bubble scrolls instead.
// Short prompts are unaffected (max-height only caps, never grows). The bubble is
// matched by a hash-independent attribute selector so it keeps working when Claude
// Code's CSS-module hash (userMessage_XXXXXX) changes. The rule is appended last so
// its (equal-specificity) overflow-y wins over upstream's overflow-y:hidden.
function computePromptHeightPatch(content) {
  if (content.startsWith(MARKER)) {
    return { patched: false, reason: 'already patched' };
  }
  if (!/userMessage_/.test(content)) {
    return { patched: false, reason: 'userMessage_ class not found (Claude Code internals may have changed)' };
  }
  const css =
    `\n/*__ccaaPromptHeight*/` +
    `[class*="userMessage_"]{max-height:40vh;overflow-y:auto;scrollbar-width:thin}` +
    `/*__ccaaPromptHeightEnd*/`;
  return { patched: true, content: MARKER + '\n' + content + css };
}

function revertPromptHeightPatch(content) {
  const stripped = stripMarker(content);
  if (stripped === null) return { reverted: false, reason: 'not patched' };
  return { reverted: true, content: stripped.replace(PROMPT_HEIGHT_SENTINEL_RE, '') };
}

function computeExtensionPatch(content) {
  if (content.startsWith(MARKER)) {
    return { patched: false, reason: 'already patched' };
  }
  return runSubPatches(content, [
    { name: 'auto-approve-guard', inject: injectCanUseToolGuard },
    { name: 'permission-mode-capture', inject: injectPermissionModeCapture },
    { name: 'session-scoped-model', inject: injectSessionScopedModel },
  ]);
}

function revertExtensionPatch(content) {
  const stripped = stripMarker(content);
  if (stripped === null) return { reverted: false, reason: 'not patched' };

  let next = revertCanUseToolGuard(stripped);
  next = revertPermissionModeCapture(next);
  next = next.replace(SESSION_MODEL_SENTINEL_RE, '');
  return { reverted: true, content: next };
}

const PATCH_SITES = [
  {
    relativePath: ['webview', 'index.js'],
    description: 'attach toggle OFF + per-session model badge + Ctrl+M model cycle + Ctrl+F context toggle',
    compute: computeWebviewPatch,
    revert: revertWebviewPatch,
  },
  {
    relativePath: ['webview', 'index.css'],
    description: 'cap user prompt bubble height + make it scrollable',
    compute: computePromptHeightPatch,
    revert: revertPromptHeightPatch,
  },
  {
    relativePath: ['extension.js'],
    description: 'auto-allow gitignored Write/Edit prompts (bypass mode only) + capture permission mode + session-scoped model switch',
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

  const config = vscode.workspace.getConfiguration('claude-code-no-auto-attach');
  const computeOptions = {
    detachContextByDefault: config.get('detachContextByDefault', true),
  };

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

      const result = site.compute(baseContent, computeOptions);
      if (!result.patched) {
        channel.appendLine(`[no-auto-attach] Skipped ${relLabel} (${result.reason}).`);
        skipMessages.push(`${relLabel}: ${result.reason}`);
        continue;
      }

      for (const warning of result.warnings || []) {
        channel.appendLine(`[no-auto-attach] Partial patch ${relLabel}: ${warning}.`);
        skipMessages.push(`${relLabel}: ${warning}`);
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

  // detachContextByDefault is baked in at patch time (the webview can't read VS Code
  // settings), so re-apply when it changes instead of waiting for the next startup.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claude-code-no-auto-attach.detachContextByDefault')) {
        channel.appendLine('[no-auto-attach] detachContextByDefault changed; re-applying patch.');
        applyPatch(channel);
      }
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

module.exports = {
  activate,
  deactivate,
  // exported for tests
  computeWebviewPatch,
  revertWebviewPatch,
  computePromptHeightPatch,
  revertPromptHeightPatch,
  computeExtensionPatch,
  revertExtensionPatch,
};
