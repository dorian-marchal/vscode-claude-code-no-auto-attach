const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const MARKER = '/*claude-code-no-auto-attach:v33*/';
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
  // The hook may be written as `X.useState(!0)` (older bundles) or, once the minifier
  // aliases React's hooks to bare locals, `ne(!0)`. Match either, still pinned to the exact
  // [state,setter] pair and a boolean init so it can only resolve to the toggle's useState.
  const declRe = new RegExp(
    `\\[${escapeRegex(stateVar)},${escapeRegex(setterVar)}\\]=[A-Za-z_$][\\w$]*(?:\\.useState)?\\((!0|!1)\\)`,
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

const SLASH_SEL_REVERT_RE = /\/\*__ccaaSlashSel:(&&![\w$]+)\*\//;

// On submit, upstream computes the include-selection flag as `gt=v&&!De` where v is the
// toggle state and De is "the message starts with /". So the current file/selection is
// silently dropped for *every* slash command — including skills — even when the toggle is
// on. Drop the `&&!De` guard so the toggle alone decides; the original suffix is parked in
// a sentinel comment for a byte-exact revert. (Explicitly attached files are passed
// separately and were never affected; this is only the IDE current-file/selection path.)
function injectSlashKeepsSelection(content) {
  // Anchor on the stable shape — `let flag=toggle&&!startsWithSlash;helper(x.selection.value,flag,`
  // — rather than the minified helper name (it churns between releases, e.g. YXe→rZe). The
  // `.selection.value` read and the backreference to the just-declared flag keep it unique.
  const anchorRe = /let ([\w$]+)=([\w$]+)(&&![\w$]+);([\w$]+\([\w$]+\.selection\.value,\1,)/g;
  const matches = [...content.matchAll(anchorRe)];
  if (matches.length === 0) {
    return { ok: false, reason: 'selection-gate site not found (Claude Code internals may have changed)' };
  }
  if (matches.length > 1) {
    return { ok: false, reason: `ambiguous: ${matches.length} selection-gate sites found` };
  }

  const [whole, stateVar, toggleVar, suffix, tail] = matches[0];
  const replacement = `let ${stateVar}=${toggleVar}/*__ccaaSlashSel:${suffix}*/;${tail}`;
  return { ok: true, content: content.replace(whole, () => replacement) };
}

function revertSlashKeepsSelection(content) {
  return SLASH_SEL_REVERT_RE.test(content)
    ? content.replace(SLASH_SEL_REVERT_RE, (_, suffix) => suffix)
    : content;
}

const RATE_LIMIT_REVERT_RE =
  /\/\*__ccaaRateLimit\*\/[\w$]+\.status==="rejected"\?([\s\S]*?):null\/\*__ccaaRateLimitEnd\*\//;

// Drop the "You've used N% of your session limit" / "Approaching weekly limit" banner: the
// session sets rateLimitWarning from every rate_limit_event, and each one costs a dismiss
// click. Only the "rejected" status is kept — that one means the limit is actually hit, so
// it stays worth showing. The original expression is parked inside the sentinel for a
// byte-exact revert.
function injectHideRateLimitWarning(content) {
  const anchorRe =
    /else if\(([\w$]+)!==this\.dismissedRateLimitKey\)this\.rateLimitWarning\.value=([\w$]+\(([\w$]+)\));/g;
  const matches = [...content.matchAll(anchorRe)];
  if (matches.length === 0) {
    return { ok: false, reason: 'rate-limit warning site not found (Claude Code internals may have changed)' };
  }
  if (matches.length > 1) {
    return { ok: false, reason: `ambiguous: ${matches.length} rate-limit warning sites found` };
  }

  const [whole, keyVar, call, infoVar] = matches[0];
  const replacement =
    `else if(${keyVar}!==this.dismissedRateLimitKey)this.rateLimitWarning.value=` +
    `/*__ccaaRateLimit*/${infoVar}.status==="rejected"?${call}:null/*__ccaaRateLimitEnd*/;`;
  return { ok: true, content: content.replace(whole, () => replacement) };
}

function revertHideRateLimitWarning(content) {
  return RATE_LIMIT_REVERT_RE.test(content)
    ? content.replace(RATE_LIMIT_REVERT_RE, (_, call) => call)
    : content;
}

const MODEL_UI_SENTINEL_RE = /;\/\*__ccaaModelUi\*\/[\s\S]*?\/\*__ccaaModelUiEnd\*\//g;

// Inside the reactive effect that registers the "Switch model…" command action, append:
// - a per-session model badge (fixed top-right of the webview, click opens the picker,
//   warning colors when the session is on a Fable model). When the current model supports
//   effort, the badge also shows the current effort level ("Model · xhigh", or "· ultra"
//   under ultracode); it stays live because reading the effort signals re-runs this effect.
// - two effort helpers: __ccaaEffortFor(model) maps a model family to its preferred effort
//   (Opus->xhigh, Sonnet/Haiku->medium) when the model supports it, else null;
//   __ccaaApplyEffort(session,model) sets that effort (session-scoped via the extension.js
//   patch). Both are used by every model-switch action below so switching model also bumps
//   effort to match the family.
// - a Ctrl+M keydown handler (capture phase) that cycles through available models for
//   the session rendered in this webview (and applies the family's effort).
// - Ctrl+0 / Ctrl+1 / Ctrl+2 / Ctrl+3 keydown handlers (same listener) that switch the
//   session to Fable / Opus / Sonnet / Haiku and submit the composer in one go — the
//   keyboard equivalent of the quick-send buttons (Opus has no button).
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
    // The badge is a flex row of three spans: the served-model pill, an arrow, and the
    // selected-model pill. Only the last one shows unless the two disagree (see drift below).
    `var __ccaaBadge=document.getElementById("ccaa-model-badge");` +
    `if(__ccaaBadge&&!document.getElementById("ccaa-model-badge-main")){__ccaaBadge.remove();__ccaaBadge=null}` +
    `if(!__ccaaBadge){__ccaaBadge=document.createElement("div");__ccaaBadge.id="ccaa-model-badge";` +
    `__ccaaBadge.style.cssText="position:fixed;top:36px;right:14px;z-index:99999;display:flex;align-items:center;gap:4px;font-size:11px;font-family:var(--vscode-font-family);line-height:16px;cursor:pointer;user-select:none;opacity:.95";` +
    `["ccaa-model-badge-served","ccaa-model-badge-arrow","ccaa-model-badge-main"].forEach((__ccaaId)=>{` +
    `var __ccaaSpan=document.createElement("span");__ccaaSpan.id=__ccaaId;` +
    `__ccaaSpan.style.cssText=__ccaaId==="ccaa-model-badge-arrow"?"color:var(--vscode-descriptionForeground,#999)":"padding:1px 8px;border-radius:9px";` +
    `__ccaaBadge.appendChild(__ccaaSpan)});` +
    `document.body.appendChild(__ccaaBadge)}` +
    `__ccaaBadge.onclick=()=>${openPickerVar}(!0);` +
    `var __ccaaServedEl=document.getElementById("ccaa-model-badge-served");` +
    `var __ccaaArrowEl=document.getElementById("ccaa-model-badge-arrow");` +
    `var __ccaaMainEl=document.getElementById("ccaa-model-badge-main");` +
    `var __ccaaModels=${sessionVar}.claudeConfig.value?.models??[];` +
    `var __ccaaSelected=${sessionVar}.modelSelection.value??"default";` +
    `var __ccaaSelModel=__ccaaModels.find((__ccaaM)=>__ccaaM.value===__ccaaSelected);` +
    // lastServedModel is the model that actually answered, and upstream clears it inside
    // setModel — so right after a switch there is no known mismatch, only once an answer
    // comes back. currentMainLoopModel keeps the pre-switch value instead, which is why it
    // must not feed the drift check (it made every switch look like a mismatch); it only
    // serves as a color hint when the selection carries no family (e.g. "default").
    `var __ccaaServed=String(${sessionVar}.lastServedModel?.value??"");` +
    `var __ccaaRunning=String(${sessionVar}.currentMainLoopModel?.value??"");` +
    `var __ccaaFamOf=(__ccaaS)=>(String(__ccaaS??"").toLowerCase().match(/fable|opus|sonnet|haiku/)??[null])[0];` +
    `var __ccaaSelFam=__ccaaFamOf(__ccaaSelected+" "+(__ccaaSelModel?.displayName??""));` +
    `var __ccaaServedFam=__ccaaFamOf(__ccaaServed);` +
    // Drift: the last answer came from another family than the selected model, and no switch
    // has been requested since. Upstream's label (nameVar) then reads the *served* model, so a
    // single badge would mix that text with the selected model's color; show both pills
    // instead — served first and dimmed, then the selected one.
    `var __ccaaDrift=!!(__ccaaSelFam&&__ccaaServedFam&&__ccaaSelFam!==__ccaaServedFam);` +
    `var __ccaaLabel=(__ccaaDrift?null:${nameVar})??__ccaaSelModel?.displayName??__ccaaSelected;` +
    // Name each pill from its own model, never from nameVar, which names the selected model
    // or the served one depending on upstream's own drift rule.
    `var __ccaaServedLabel=__ccaaModels.find((__ccaaM)=>__ccaaM.value===__ccaaServedFam)?.displayName??__ccaaServedFam;` +
    // Append the current effort to the badge when the model supports it (reading these
    // reactive signals also re-runs this effect on effort changes, keeping the badge live).
    // Ultracode is xhigh + workflows, so show "ultra" rather than the bare "xhigh".
    `var __ccaaEffort=(${sessionVar}.currentModelSupportsEffort?.value&&${sessionVar}.effortLevel?.value)?String(${sessionVar}.effortLevel.value):"";` +
    `if(__ccaaEffort&&${sessionVar}.ultracodeEnabled?.value)__ccaaEffort="ultra";` +
    `var __ccaaColorOf=(__ccaaF)=>__ccaaF==="fable"?"#8052d2":__ccaaF==="opus"?"#c63e3e":__ccaaF==="sonnet"?"#bc8e26":__ccaaF==="haiku"?"#269473":null;` +
    `var __ccaaPaint=(__ccaaEl,__ccaaC)=>{__ccaaEl.style.background=__ccaaC??"var(--vscode-badge-background,#4d4d4d)";` +
    `__ccaaEl.style.color=__ccaaC?"#fff":"var(--vscode-badge-foreground,#fff)"};` +
    `__ccaaMainEl.textContent=__ccaaEffort?String(__ccaaLabel)+" \xB7 "+__ccaaEffort:String(__ccaaLabel);` +
    `__ccaaPaint(__ccaaMainEl,__ccaaColorOf(__ccaaSelFam??__ccaaServedFam??__ccaaFamOf(__ccaaRunning)));` +
    `__ccaaServedEl.style.display=__ccaaArrowEl.style.display=__ccaaDrift?"":"none";` +
    `if(__ccaaDrift){__ccaaArrowEl.textContent="\u2192";__ccaaServedEl.style.opacity=".6";` +
    `__ccaaServedEl.textContent=String(__ccaaServedLabel);__ccaaPaint(__ccaaServedEl,__ccaaColorOf(__ccaaServedFam))}` +
    `__ccaaBadge.title=(__ccaaDrift` +
    `?"Last answered by "+String(__ccaaServedLabel)+", while "+String(__ccaaLabel)+(__ccaaEffort?" \xB7 "+__ccaaEffort:"")+" is selected \u2014 pick it again to apply it"` +
    `:__ccaaEffort?"Claude model + effort ("+String(__ccaaLabel)+" \xB7 "+__ccaaEffort+")":"Claude model")` +
    `+" (click to switch, Ctrl+M to cycle)";` +
    // Map a model to the effort we want for its family (Fable->high, Opus->xhigh,
    // Sonnet/Haiku->medium), but only if the model reports it supports that level — else
    // null (leave effort as-is).
    `globalThis.__ccaaEffortFor=(__ccaaM)=>{` +
    `if(!__ccaaM||!__ccaaM.supportsEffort)return null;` +
    `var __ccaaS=(String(__ccaaM.value??"")+" "+String(__ccaaM.displayName??"")).toLowerCase();` +
    `var __ccaaWant=/fable/.test(__ccaaS)?"high":/opus/.test(__ccaaS)?"xhigh":/sonnet/.test(__ccaaS)?"medium":/haiku/.test(__ccaaS)?"medium":null;` +
    `if(!__ccaaWant)return null;var __ccaaLv=__ccaaM.supportedEffortLevels;` +
    `return(!__ccaaLv||__ccaaLv.includes(__ccaaWant))?__ccaaWant:null};` +
    // Set the family's effort for the given session. setEffortLevel no-ops internally when the
    // level already matches, and the extension.js patch keeps the write session-scoped.
    `globalThis.__ccaaApplyEffort=(__ccaaSess,__ccaaM)=>{` +
    `try{var __ccaaW=globalThis.__ccaaEffortFor(__ccaaM);` +
    `if(__ccaaW)return Promise.resolve(__ccaaSess.setEffortLevel(__ccaaW))}catch(__ccaaEfE){}` +
    `return Promise.resolve()};` +
    // Instant custom tooltip for the quick-send buttons (the native `title` attribute has a
    // ~1s hover delay). A single reused #ccaa-tip node is positioned above the hovered
    // element, flipped below and clamped horizontally when it would leave the viewport. All
    // best-effort: wrapped in try/catch and called via optional chaining, so a failure or a
    // skipped patch just means no tooltip, never a broken button.
    `globalThis.__ccaaShowTip=(__ccaaEl,__ccaaText)=>{try{` +
    `var __ccaaTip=document.getElementById("ccaa-tip");` +
    `if(!__ccaaTip){__ccaaTip=document.createElement("div");__ccaaTip.id="ccaa-tip";` +
    `__ccaaTip.style.cssText="position:fixed;z-index:99999;padding:3px 8px;border-radius:6px;font-size:11px;font-family:var(--vscode-font-family);line-height:16px;pointer-events:none;white-space:nowrap;background:var(--vscode-editorHoverWidget-background,#252526);color:var(--vscode-editorHoverWidget-foreground,#cccccc);border:1px solid var(--vscode-editorHoverWidget-border,#454545);box-shadow:0 2px 8px rgba(0,0,0,.4)";` +
    `document.body.appendChild(__ccaaTip)}` +
    `__ccaaTip.textContent=__ccaaText;__ccaaTip.style.display="block";` +
    `var __ccaaR=__ccaaEl.getBoundingClientRect();var __ccaaHalf=__ccaaTip.offsetWidth/2;` +
    `var __ccaaCx=Math.max(__ccaaHalf+4,Math.min(__ccaaR.left+__ccaaR.width/2,window.innerWidth-__ccaaHalf-4));` +
    `var __ccaaTop=__ccaaR.top-__ccaaTip.offsetHeight-6;` +
    `__ccaaTip.style.left=__ccaaCx+"px";__ccaaTip.style.top=(__ccaaTop<4?__ccaaR.bottom+6:__ccaaTop)+"px";` +
    `__ccaaTip.style.transform="translateX(-50%)"}catch(__ccaaTe){}};` +
    `globalThis.__ccaaHideTip=()=>{try{var __ccaaTip=document.getElementById("ccaa-tip");if(__ccaaTip)__ccaaTip.style.display="none"}catch(__ccaaTe){}};` +
    `globalThis.__ccaaCycleModel=()=>{` +
    `var __ccaaList=${sessionVar}.claudeConfig.value?.models??[];if(__ccaaList.length<2)return;` +
    `var __ccaaCurrent=${sessionVar}.modelSelection.value??"default";` +
    `var __ccaaIndex=__ccaaList.findIndex((__ccaaM)=>__ccaaM.value===__ccaaCurrent);` +
    `var __ccaaNext=__ccaaList[(__ccaaIndex+1)%__ccaaList.length];` +
    `Promise.resolve(${sessionVar}.setModel(__ccaaNext)).then(()=>globalThis.__ccaaApplyEffort(${sessionVar},__ccaaNext))};` +
    // True when the session must be told to switch to the target model. modelSelection alone
    // can't answer that: it is seeded from the *global* default model setting on launch, which
    // the session-scoped setModel patch never writes — so a resumed session reads
    // "opus[1m]" while the CLI is really serving Fable. Treat a served model outside the
    // requested family as drift and switch anyway; without it a send would keep the old model
    // yet still apply the target's effort (e.g. Fable answering at Opus' xhigh).
    `var __ccaaNeedsSwitch=(__ccaaSess,__ccaaT,__ccaaRe)=>{` +
    `if(__ccaaSess.modelSelection.value!==__ccaaT.value)return!0;` +
    `var __ccaaCur=String(__ccaaSess.lastServedModel?.value??__ccaaSess.currentMainLoopModel?.value??"");` +
    `return __ccaaCur?!__ccaaRe.test(__ccaaCur):!1};` +
    `globalThis.__ccaaNeedsSwitch=__ccaaNeedsSwitch;` +
    // Switch the session to the first model whose value/displayName matches the regex, then
    // submit the composer — the keyboard equivalent of the quick-send buttons (Ctrl+0 Fable,
    // Ctrl+1 Opus, Ctrl+2 Sonnet, Ctrl+3 Haiku). No-op while busy, when the composer can't
    // submit (its send button is disabled), or when no model matches (e.g. unavailable).
    `globalThis.__ccaaSendWithModel=(__ccaaRe)=>{` +
    `var __ccaaBtn=document.querySelector('button[type="submit"][data-permission-mode]');` +
    `if(!__ccaaBtn||__ccaaBtn.disabled||${sessionVar}.busy.value)return;` +
    `var __ccaaList=${sessionVar}.claudeConfig.value?.models??[];` +
    `var __ccaaTarget=__ccaaList.find((__ccaaM)=>__ccaaRe.test(__ccaaM.value)||__ccaaRe.test(__ccaaM.displayName));` +
    `if(!__ccaaTarget)return;var __ccaaForm=__ccaaBtn.form;` +
    `Promise.resolve(__ccaaNeedsSwitch(${sessionVar},__ccaaTarget,__ccaaRe)?${sessionVar}.setModel(__ccaaTarget):null)` +
    `.then(()=>globalThis.__ccaaApplyEffort(${sessionVar},__ccaaTarget))` +
    `.then(()=>{if(__ccaaForm)__ccaaForm.requestSubmit()})};` +
    `if(!globalThis.__ccaaModelKeyBound){globalThis.__ccaaModelKeyBound=!0;` +
    `window.addEventListener("keydown",(__ccaaE)=>{` +
    `if(!(__ccaaE.ctrlKey&&!__ccaaE.metaKey&&!__ccaaE.altKey&&!__ccaaE.shiftKey))return;` +
    `if(__ccaaE.key==="m"||__ccaaE.key==="M"){__ccaaE.preventDefault();__ccaaE.stopPropagation();globalThis.__ccaaCycleModel?.()}` +
    `else if(__ccaaE.key==="1"){__ccaaE.preventDefault();__ccaaE.stopPropagation();globalThis.__ccaaSendWithModel?.(/opus/i)}` +
    `else if(__ccaaE.key==="2"){__ccaaE.preventDefault();__ccaaE.stopPropagation();globalThis.__ccaaSendWithModel?.(/sonnet/i)}` +
    `else if(__ccaaE.key==="3"){__ccaaE.preventDefault();__ccaaE.stopPropagation();globalThis.__ccaaSendWithModel?.(/haiku/i)}` +
    `else if(__ccaaE.key==="0"){__ccaaE.preventDefault();__ccaaE.stopPropagation();globalThis.__ccaaSendWithModel?.(/fable/i)}` +
    `},!0)}` +
    `}catch(__ccaaErr2){}/*__ccaaModelUiEnd*/`;

  return { ok: true, content: content.replace(anchor, anchor + insertion) };
}

const SEND_MODEL_BUTTONS_SENTINEL_RE = /\/\*__ccaaSendBtns\*\/[\s\S]*?\/\*__ccaaSendBtnsEnd\*\//g;

// Add three extra send buttons next to the composer's send button — switching the session
// to Sonnet, Haiku, or Fable — then submit the prompt. They reuse the session's setModel
// (session-scoped via the extension.js patch), skip it only when __ccaaNeedsSwitch (defined by
// injectModelUi) says the session already runs that model, bump the effort to match the model
// family via __ccaaApplyEffort, and the form's native submit path, so the
// only new behavior is "switch model + effort on the fly, then send". Each button hides itself
// when its model isn't available for the session. The original send button (and its send/stop
// animation) is left untouched; the new ones sit to its right as plain shortcuts.
function injectSendModelButtons(content) {
  // Two JSX-call shapes must be matched: the classic `X.createElement("button",{…},ICON)`
  // (positional child) and the newer runtime `b("button",{…,children:ICON})` (child as a
  // prop). The factory is captured generically (bare `b` or dotted `X.createElement`) and the
  // trailing child via an alternation, so a future switch between the two degrades to a skip,
  // not a mismatch. Everything in between (the submit/interrupt handler) is the stable anchor.
  const anchorRe =
    /([\w$]+(?:\.[\w$]+)*)\("button",\{type:"submit",disabled:!([\w$]+)\.busy\.value&&!([\w$]+),className:([\w$]+)\.sendButton,"data-permission-mode":[\w$]+,onClick:\(([\w$]+)\)=>\{if\(\2\.busy\.value&&!\3\)\5\.preventDefault\(\),\2\.interrupt\(\)\}(?:\},([\w$]+)\)|,children:([\w$]+)\}\))/g;
  const matches = [...content.matchAll(anchorRe)];
  if (matches.length === 0) {
    return { ok: false, reason: 'send button site not found (Claude Code internals may have changed)' };
  }
  if (matches.length > 1) {
    return { ok: false, reason: `ambiguous: ${matches.length} send button sites found` };
  }

  const [anchor, factory, sess, canSubmit, clsObj, , positionalChild, childProp] = matches[0];
  const childAsProp = childProp !== undefined;
  const child = childProp ?? positionalChild;
  // Close the created element the same way the matched form did: child as a prop
  // (`,children:X})`) or positional (`},X)`), so the injected buttons stay valid JSX calls.
  const close = childAsProp ? `,children:${child}})` : `},${child})`;

  // shortcut is the Ctrl chord shown in the tooltip (e.g. "Ctrl + 2"), matching the
  // keyboard handler injected by injectModelUi. The tooltip text also appends the effort the
  // button will apply (via __ccaaEffortFor), so it reads "Send to Sonnet · medium [Ctrl + 2]".
  // It's shown via the instant custom tooltip (__ccaaShowTip/__ccaaHideTip from injectModelUi,
  // called with ?. so the button still works if that patch skips) to avoid the native
  // `title` hover delay; the same text stays on `aria-label` for screen readers.
  const button = (modelRe, background, color, shortcut) =>
    `(()=>{` +
    `var __ccaaModels=${sess}.claudeConfig.value?.models??[];` +
    `var __ccaaTarget=__ccaaModels.find((__ccaaM)=>${modelRe}.test(__ccaaM.value)||${modelRe}.test(__ccaaM.displayName));` +
    `if(!__ccaaTarget)return null;` +
    `var __ccaaDisabled=${sess}.busy.value||!${canSubmit};` +
    `var __ccaaEff=globalThis.__ccaaEffortFor?.(__ccaaTarget);` +
    `var __ccaaTip="Send to "+__ccaaTarget.displayName+(__ccaaEff?" · "+__ccaaEff:"")+" [${shortcut}]";` +
    `return ${factory}("button",{type:"button",className:${clsObj}.sendButton,` +
    `disabled:__ccaaDisabled,` +
    `"aria-label":__ccaaTip,` +
    `onMouseEnter:(__ccaaEv)=>globalThis.__ccaaShowTip?.(__ccaaEv.currentTarget,__ccaaTip),` +
    `onMouseLeave:()=>globalThis.__ccaaHideTip?.(),` +
    `style:{background:${JSON.stringify(background)},color:${JSON.stringify(color)},opacity:__ccaaDisabled?.45:1},` +
    `onClick:(__ccaaEv)=>{__ccaaEv.preventDefault();globalThis.__ccaaHideTip?.();` +
    `var __ccaaForm=__ccaaEv.currentTarget.closest("form");` +
    `Promise.resolve((globalThis.__ccaaNeedsSwitch?globalThis.__ccaaNeedsSwitch(${sess},__ccaaTarget,${modelRe}):${sess}.modelSelection.value!==__ccaaTarget.value)?${sess}.setModel(__ccaaTarget):null)` +
    `.then(()=>globalThis.__ccaaApplyEffort?.(${sess},__ccaaTarget))` +
    `.then(()=>{if(__ccaaForm)__ccaaForm.requestSubmit()})}` +
    `${close}})()`;

  const sonnet = button('/sonnet/i', '#bc8e26', '#ffffff', 'Ctrl + 2');
  const haiku = button('/haiku/i', '#269473', '#ffffff', 'Ctrl + 3');
  const fable = button('/fable/i', '#8052d2', '#ffffff', 'Ctrl + 0');
  const insertion = `/*__ccaaSendBtns*/,${sonnet},${haiku},${fable}/*__ccaaSendBtnsEnd*/`;

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

const SESSION_EFFORT_SENTINEL_RE = /\/\*__ccaaSessionEffort\*\/[\s\S]*?\/\*__ccaaSessionEffortEnd\*\//g;

// Effort switches (the native picker and our model buttons/shortcuts) go through
// apply_settings, which persists effortLevel to ~/.claude/settings.json — the new global
// default — before pushing it to the session. Force effort-only applies to flagsOnly so they
// only push to the current session, matching the session-scoped model switch. writeUserSettings
// -AndPush always pushes the flags to the running session (the disk write is the only thing
// guarded by flagsOnly), so the current session still gets the new effort. Effort-only means
// the settings object's single key is "effortLevel" — the native effort picker and our
// setEffortLevel both send exactly that; other apply_settings calls are left untouched.
function injectSessionScopedEffort(content) {
  const anchorRe =
    /async applySettings\((\w+),(\w+),(\w+)\)\{return await this\.writeUserSettingsAndPush\(\1,\2,\3\),\{type:"apply_settings_response"\}\}/g;
  const matches = [...content.matchAll(anchorRe)];
  if (matches.length === 0) {
    return { ok: false, reason: 'applySettings anchor not found (Claude Code internals may have changed)' };
  }
  if (matches.length > 1) {
    return { ok: false, reason: `ambiguous: ${matches.length} applySettings anchors found` };
  }

  const [anchor, channelVar, settingsVar, flagsVar] = matches[0];
  const insertion =
    `/*__ccaaSessionEffort*/try{if(!${flagsVar}&&${settingsVar}&&typeof ${settingsVar}==="object"){` +
    `var __ccaaEffKeys=Object.keys(${settingsVar});` +
    `if(__ccaaEffKeys.length===1&&__ccaaEffKeys[0]==="effortLevel"&&` +
    `require("vscode").workspace.getConfiguration("claude-code-no-auto-attach").get("sessionScopedEffortSwitch",true))` +
    `${flagsVar}=!0}}catch(__ccaaEffErr){}/*__ccaaSessionEffortEnd*/`;
  const replacement = anchor.replace(
    `async applySettings(${channelVar},${settingsVar},${flagsVar}){`,
    `async applySettings(${channelVar},${settingsVar},${flagsVar}){${insertion}`
  );
  return { ok: true, content: content.replace(anchor, () => replacement) };
}

const MD_PREVIEW_SENTINEL_RE = /\/\*__ccaaMdPreview\*\/[\s\S]*?\/\*__ccaaMdPreviewEnd\*\//g;
const MD_PREVIEW2_SENTINEL_RE = /\/\*__ccaaMdPreview2\*\/[\s\S]*?\/\*__ccaaMdPreview2End\*\//g;
const MD_PREVIEW3_SENTINEL_RE = /\/\*__ccaaMdPreview3\*\/[\s\S]*?\/\*__ccaaMdPreview3End\*\//g;

// A markdown *preview* is not a TextEditor, so focusing it makes activeTextEditor
// undefined and Claude Code drops the current-file context (you'd have to switch back
// to the raw .md). VS Code has TWO preview implementations and we handle both:
//   1. the classic "Open Preview" — a webview panel (viewType markdown.preview), whose
//      tab input is a TabInputWebview that does NOT expose the source uri. We resolve
//      it from the tab label's basename ("Preview README.md" / "[Preview] README.md"):
//      prefer the last active markdown editor, then a uniquely-matching open markdown
//      document, then a unique workspace file.
//   2. the custom-editor preview (viewType vscode.markdown.editor), whose tab input is
//      a TabInputCustom that DOES expose `.uri` — we read the source path directly.
// On a hit we set the same context object shape the upstream E4 helper produces for an
// unselected file ({filePath,startLine,endLine}), which the webview renders as just the
// basename. Three insertions, all reverted by stripping their sentinel blocks: a tracker
// (records the last markdown editor), the resolver (runs in the `!r` branch before
// upstream's clear/retain logic), and a tab-group listener (onDidChangeActiveTextEditor
// only fires on text-editor changes, so preview->preview switches keep activeTextEditor
// undefined and never re-run the resolver — the listener fires on active-tab changes
// too, registered once, running the same resolver). A filePath dedup keeps the paths
// from double-firing. Opt-in debug log (touch ~/.ccaa-debug) writes the active tab's
// input type / viewType / uri / label to <tmpdir>/ccaa-md-debug.log on each event.
function injectMarkdownPreviewContext(content) {
  // The clear branch resets one-or-more module state vars before firing (2.1.197 cleared
  // just the context var; 2.1.198+ also clears a URI-string tracker: `Nd=void 0,G_=void 0,`).
  // Capture the whole `X=void 0,` run so we can preserve it verbatim and stay tolerant of
  // future additions; the context var (whose `.filePath` the resolver sets) is the first one.
  const anchorRe =
    /onDidChangeActiveTextEditor\(async\((\w+)\)=>\{if\(!\1\)\{if\((\w+)\(([\w$]+)\.window\.visibleTextEditors\.length\)==="retain"\)return;([\w$]+)\.bump\(\),((?:[\w$]+=void 0,)+)([\w$]+)\.fire\(void 0\);return\}/g;
  const matches = [...content.matchAll(anchorRe)];
  if (matches.length === 0) {
    return { ok: false, reason: 'active-editor handler not found (Claude Code internals may have changed)' };
  }
  if (matches.length > 1) {
    return { ok: false, reason: `ambiguous: ${matches.length} active-editor handlers found` };
  }

  const [whole, editorVar, retainFn, vscodeNs, staleGuard, clearBody, emitter] = matches[0];
  const contextVar = clearBody.match(/^([\w$]+)=/)[1];

  const tracker =
    `/*__ccaaMdPreview*/try{` +
    `if(${editorVar}&&${editorVar}.document&&${editorVar}.document.languageId==="markdown")` +
    `globalThis.__ccaaLastMd=${editorVar}.document.uri.fsPath` +
    `}catch(__ccaaMd0){}/*__ccaaMdPreviewEnd*/`;

  // Shared resolver body (no try/catch, no sentinels) — reused by the active-editor
  // handler and the tab-group listener. The leading filePath dedup in __ccaaPush (and
  // the findFiles path) makes re-runs against the same preview a no-op.
  const resolverBody = String.raw`var __ccaaBaseOf=function(__p){return String(__p).split(/[\\/]/).pop()};if(globalThis.__ccaaDbg===void 0){try{globalThis.__ccaaDbg=require("fs").existsSync(require("os").homedir()+"/.ccaa-debug")?require("os").tmpdir()+"/ccaa-md-debug.log":null}catch(__ccaaDbgE){globalThis.__ccaaDbg=null}}var __ccaaLog=function(__m){try{if(globalThis.__ccaaDbg)require("fs").appendFileSync(globalThis.__ccaaDbg,__m+"\n")}catch(__ccaaLogE){}};var __ccaaTab=${vscodeNs}.window.tabGroups&&${vscodeNs}.window.tabGroups.activeTabGroup&&${vscodeNs}.window.tabGroups.activeTabGroup.activeTab;var __ccaaIn=__ccaaTab&&__ccaaTab.input;var __ccaaVt=__ccaaIn&&__ccaaIn.viewType;__ccaaLog("evt in="+(__ccaaIn?__ccaaIn.constructor&&__ccaaIn.constructor.name:"none")+" vt="+(__ccaaVt||"-")+" uri="+((__ccaaIn&&__ccaaIn.uri&&__ccaaIn.uri.fsPath)||"-")+" label="+((__ccaaTab&&__ccaaTab.label)||"-"));var __ccaaPush=function(__fp){if(${contextVar}&&${contextVar}.filePath===__fp)return;${staleGuard}.bump();${contextVar}={filePath:__fp,startLine:1,endLine:1};${emitter}.fire(${contextVar});__ccaaLog("push "+__fp)};if(__ccaaIn&&__ccaaIn.uri&&__ccaaVt&&/\.(md|markdown|mdx)$/i.test(__ccaaIn.uri.fsPath||"")){__ccaaPush(__ccaaIn.uri.fsPath);return}if(__ccaaIn&&${vscodeNs}.TabInputWebview&&__ccaaIn instanceof ${vscodeNs}.TabInputWebview&&/markdown\.preview/.test(__ccaaVt||"")){var __ccaaLabel=__ccaaTab.label||"";var __ccaaLast=globalThis.__ccaaLastMd;if(__ccaaLast&&__ccaaLabel.endsWith(__ccaaBaseOf(__ccaaLast))){__ccaaPush(__ccaaLast);return}var __ccaaDocs=(${vscodeNs}.workspace.textDocuments||[]).filter(function(__d){return __d.languageId==="markdown"&&__ccaaLabel.endsWith(__ccaaBaseOf(__d.uri.fsPath))});if(__ccaaDocs.length===1){__ccaaPush(__ccaaDocs[0].uri.fsPath);return}var __ccaaBase=__ccaaLabel.replace(/^\[?[^\]\s]*\]?\s+/,"");if(/\.(md|markdown|mdx)$/i.test(__ccaaBase)&&!/[*?{}\[\]]/.test(__ccaaBase)){var __ccaaG=${staleGuard}.bump();${vscodeNs}.workspace.findFiles("**/"+__ccaaBase,"**/node_modules/**",2).then(function(__h){if(__h&&__h.length===1&&!${staleGuard}.isStale(__ccaaG)&&!(${contextVar}&&${contextVar}.filePath===__h[0].fsPath)){${contextVar}={filePath:__h[0].fsPath,startLine:1,endLine:1};${emitter}.fire(${contextVar});__ccaaLog("pushAsync "+__h[0].fsPath)}},function(){});return}}`;

  const resolver = `/*__ccaaMdPreview2*/try{` + resolverBody + `}catch(__ccaaMd1){}/*__ccaaMdPreview2End*/`;

  // Registered once (global flag): active-tab listeners so preview<->preview switches
  // re-resolve the source. onDidChangeTabs fires when a tab's isActive flips (switching
  // tabs within a group); onDidChangeTabGroups fires on group-level changes (e.g. the
  // active split group). Both run the same resolver; the filePath dedup keeps repeats
  // from double-firing. Closes over the module vars.
  const tabListener =
    `/*__ccaaMdPreview3*/try{if(!globalThis.__ccaaTabSub){globalThis.__ccaaTabSub=1;` +
    `var __ccaaOnTab=function(){try{` + resolverBody + `}catch(__ccaaMd2){}};` +
    `${vscodeNs}.window.tabGroups.onDidChangeTabs(__ccaaOnTab);` +
    `${vscodeNs}.window.tabGroups.onDidChangeTabGroups(__ccaaOnTab);` +
    `}}catch(__ccaaMd3){}/*__ccaaMdPreview3End*/`;

  const replacement =
    `onDidChangeActiveTextEditor(async(${editorVar})=>{` + tracker + tabListener +
    `if(!${editorVar}){` + resolver +
    `if(${retainFn}(${vscodeNs}.window.visibleTextEditors.length)==="retain")return;` +
    `${staleGuard}.bump(),${clearBody}${emitter}.fire(void 0);return}`;

  return { ok: true, content: content.replace(whole, () => replacement) };
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
    { name: 'slash-keeps-selection', inject: injectSlashKeepsSelection },
    { name: 'send-model-buttons', inject: injectSendModelButtons },
    { name: 'hide-rate-limit-warning', inject: injectHideRateLimitWarning }
  );
  return runSubPatches(content, subPatches);
}

function revertWebviewPatch(content) {
  const stripped = stripMarker(content);
  if (stripped === null) return { reverted: false, reason: 'not patched' };

  // Revert the context toggle first so the attach-toggle anchor (which reads the clean
  // onToggleIncludeSelection prop) resolves again.
  let next = revertContextToggle(stripped);
  next = revertSlashKeepsSelection(next);
  next = revertHideRateLimitWarning(next);
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
    `button[title^="Showing Claude your current file selection"]{color:#d97757}` +
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
    { name: 'session-scoped-effort', inject: injectSessionScopedEffort },
    { name: 'markdown-preview-context', inject: injectMarkdownPreviewContext },
  ]);
}

function revertExtensionPatch(content) {
  const stripped = stripMarker(content);
  if (stripped === null) return { reverted: false, reason: 'not patched' };

  let next = revertCanUseToolGuard(stripped);
  next = revertPermissionModeCapture(next);
  next = next.replace(SESSION_MODEL_SENTINEL_RE, '');
  next = next.replace(SESSION_EFFORT_SENTINEL_RE, '');
  next = next.replace(MD_PREVIEW_SENTINEL_RE, '');
  next = next.replace(MD_PREVIEW2_SENTINEL_RE, '');
  next = next.replace(MD_PREVIEW3_SENTINEL_RE, '');
  return { reverted: true, content: next };
}

const PATCH_SITES = [
  {
    relativePath: ['webview', 'index.js'],
    description:
      'attach toggle OFF + per-session model badge + Ctrl+M model cycle + Ctrl+F context toggle + hide rate-limit warnings',
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
    description: 'auto-allow gitignored Write/Edit prompts (bypass mode only) + capture permission mode + session-scoped model + session-scoped effort switch',
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
