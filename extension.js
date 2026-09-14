const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');
const vscode = require('vscode');

const MARKER = '/*claude-code-no-auto-attach:v52*/';
const MARKER_RE = /^\/\*claude-code-no-auto-attach:v[^*]+\*\/\n/;
const TARGET_EXT_ID = 'Anthropic.claude-code';

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

// Matches both shapes this patch has produced: the v49 global read, and v48's plain `!0`
// (which forced the context on for every message). The pre-v48 shape, where the flag kept
// the composer's own toggle variable, is reverted by revertLegacySelectionPatches.
const SLASH_SEL_REVERT_RE =
  /(?:!0|\(globalThis\.__ccaaContextOn\?\?!\d\))\/\*__ccaaSlashSel:((?:[\w$]+&&)?![\w$]+)\*\//;

// The composer computes one flag that decides whether the current file/selection rides
// along with the message — `session.send(text,files,includeSelection,…)` only attaches
// `selection.value` when it is set. Upstream derives it as `!startsWithSlash` (before
// 2.1.270, `includeSelection && !startsWithSlash`), which means two things at once: the
// context is attached to everything by default, and it is silently dropped for *any*
// message starting with `/` — so a skill or slash command never saw your open file.
//
// Both are replaced by a single global the Ctrl+F toggle owns, defaulting to detached (or
// to attached, when `detachContextByDefault` is off). The slash check is gone either way:
// the toggle alone decides. The original expression is parked in a sentinel comment for a
// byte-exact revert.
//
// This is deliberately the *send-time* flag and not the selection itself: holding the
// selection back at the session (`applySelectionUpdate`) would also remove the composer's
// file chip, which is the only way to see which file is current and is what the X button
// acts on. Attached or not, the chip stays — the CSS patch dims it while context is off.
function injectContextSendFlag(content, { contextOnByDefault = false } = {}) {
  // Anchor on the stable shape — `let flag=!startsWithSlash;helper(x.selection.value,flag,`
  // — rather than the minified helper name (it churns between releases, e.g. YXe→jX0). The
  // `.selection.value` read and the backreference to the just-declared flag keep it unique.
  const anchorRe = /let ([\w$]+)=((?:[\w$]+&&)?![\w$]+);([\w$]+\([\w$]+\.selection\.value,\1,)/g;
  const matches = [...content.matchAll(anchorRe)];
  if (matches.length === 0) {
    return { ok: false, reason: 'selection-gate site not found (Claude Code internals may have changed)' };
  }
  if (matches.length > 1) {
    return { ok: false, reason: `ambiguous: ${matches.length} selection-gate sites found` };
  }

  const [whole, stateVar, expr, tail] = matches[0];
  // `??` and not `!!`, so the default still holds if the Ctrl+F patch (which seeds the
  // global) was skipped — the feature degrades to a fixed default, never to "never attach".
  const fallback = contextOnByDefault ? '!0' : '!1';
  const replacement =
    `let ${stateVar}=(globalThis.__ccaaContextOn??${fallback})/*__ccaaSlashSel:${expr}*/;${tail}`;
  return { ok: true, content: content.replace(whole, () => replacement) };
}

function revertContextSendFlag(content) {
  return SLASH_SEL_REVERT_RE.test(content)
    ? content.replace(SLASH_SEL_REVERT_RE, (_, expr) => expr)
    : content;
}

const CHIP_CLICK_SENTINEL_RE = /\/\*__ccaaChipClick\*\/[\s\S]*?\/\*__ccaaChipClickEnd\*\//g;

// Give the composer's file chip its click back. Up to 2.1.263 the chip was a button that
// toggled the attachment; 2.1.269 turned it into a static span with a dismiss X next to it,
// leaving Ctrl+F as the only way to detach. Clicking the chip now flips the same global the
// send-time flag reads, so click and Ctrl+F do the same thing (the X keeps upstream's
// dismiss). The pointer cursor rides with the injection rather than with the CSS file, so it
// can never promise a click this patch did not add, and mousedown is cancelled to keep the
// caret in the composer — clicking a non-focusable element otherwise blurs the textarea.
function injectChipClickToggle(content) {
  // Anchored on the static chip only: the `footerButtonStatic` class is what tells the
  // 2.1.269+ chip from the button it replaced, which carries an `onClick` of its own an
  // injected one would silently override. Older bundles match nothing and are skipped.
  const anchorRe =
    /className:`\$\{([\w$]+)\.footerButton\} \$\{\1\.footerButtonStatic\}`,(title:`Showing Claude your current file selection \(\$\{[\w$]+\}\)`)/g;
  const matches = [...content.matchAll(anchorRe)];
  if (matches.length === 0) {
    return { ok: false, reason: 'static file chip not found (Claude Code internals may have changed)' };
  }
  if (matches.length > 1) {
    return { ok: false, reason: `ambiguous: ${matches.length} file chips found` };
  }

  const injection =
    `/*__ccaaChipClick*/` +
    `onClick:()=>globalThis.__ccaaToggleContext?.(),` +
    `onMouseDown:(__ccaaE)=>__ccaaE.preventDefault(),` +
    `style:{cursor:"pointer"},` +
    `/*__ccaaChipClickEnd*/`;
  const [whole, , titleProp] = matches[0];
  const replacement = whole.replace(titleProp, () => injection + titleProp);
  return { ok: true, content: replaceMatch(content, matches[0], replacement) };
}

// Revert helpers for shapes this extension no longer produces, kept so the marker rollover
// stays byte-exact on an already-patched install: v47-and-earlier's `includeSelection`
// useState flipped to !1 and its toggle prop rewritten into an IIFE, and v48's short-lived
// attempt at defaulting the context off inside the session's applySelectionUpdate — which
// also hid the composer's file chip, and which v49 replaced with the send-time flag.
const LEGACY_CTX_TOGGLE_RE =
  /onToggleIncludeSelection:\/\*__ccaaCtxToggle\*\/[\s\S]*?globalThis\.__ccaaToggleContext=\(\)=>([\w$]+)\([\s\S]*?\/\*__ccaaCtxToggleEnd\*\//;
const LEGACY_SLASH_SEL_RE = /([\w$]+)\/\*__ccaaSlashSel:(&&![\w$]+)\*\//;
const LEGACY_DETACH_RE = /\/\*__ccaaDetach\*\/[\s\S]*?\/\*__ccaaDetachEnd\*\//g;

function revertLegacySelectionPatches(content) {
  let next = content.replace(LEGACY_DETACH_RE, '');
  next = next.replace(
    LEGACY_CTX_TOGGLE_RE,
    (_, setterVar) => `onToggleIncludeSelection:()=>${setterVar}(($)=>!$)`
  );
  next = next.replace(LEGACY_SLASH_SEL_RE, (_, toggleVar, suffix) => toggleVar + suffix);
  // The detach default was a one-character edit with no sentinel, so it is found the way it
  // was made: the useState closest before the (now reverted) toggle prop, in that component.
  const owner = /includeSelection:([A-Za-z_$][\w$]*),onToggleIncludeSelection:\(\)=>([A-Za-z_$][\w$]*)\(/.exec(next);
  if (!owner) return next;
  const declRe = new RegExp(`\\[${owner[1]},${owner[2]}\\]=[A-Za-z_$][\\w$]*(?:\\.useState)?\\(!1\\)`, 'g');
  let best = null;
  for (const m of next.matchAll(declRe)) {
    if (m.index < owner.index) best = m;
    else break;
  }
  return best ? replaceMatch(next, best, best[0].replace(/\(!1\)$/, '(!0)')) : next;
}

const RATE_LIMIT_REVERT_RE =
  /\/\*__ccaaRateLimit\*\/[\w$]+\.status==="rejected"\?([\s\S]*?):null\/\*__ccaaRateLimitEnd\*\//;

// Drop the "You've used N% of your session limit" / "Approaching weekly limit" banner: the
// session sets rateLimitWarning from every rate_limit_event, and each one costs a dismiss
// click. Only the "rejected" status is kept — that one means the limit is actually hit, so
// it stays worth showing. The original expression is parked inside the sentinel for a
// byte-exact revert. Three bundle generations are handled: 2.1.251+ routes the event through
// a decision helper ("clear"/"show"/"keep-hidden") and builds the banner in the "show"
// branch — assigned directly to rateLimitWarning/shownRateLimitKey in 2.1.251, and since
// 2.1.257 to frameRateLimitWarning/shownRateLimit inside a signal batch (`$H(()=>{…})`);
// older bundles assigned it directly behind a dismissedRateLimitKey check. Either way the
// builder call is wrapped in the same sentinel conditional, so one revert regex covers all.
function injectHideRateLimitWarning(content) {
  const showBranchRe =
    /else if\(([\w$]+)==="show"\)\{let ([\w$]+)=([\w$]+\(([\w$]+)\));(?:[\w$]+\(\(\)=>\{)?this\.(?:frame)?[rR]ateLimitWarning\.value=\2,this\.shownRateLimit(?:Key)?(?:\.value)?=\2===null\?null:/g;
  const showMatches = [...content.matchAll(showBranchRe)];
  if (showMatches.length === 1) {
    const [whole, , resultVar, call, infoVar] = showMatches[0];
    const replacement = whole.replace(
      `let ${resultVar}=${call};`,
      () => `let ${resultVar}=/*__ccaaRateLimit*/${infoVar}.status==="rejected"?${call}:null/*__ccaaRateLimitEnd*/;`
    );
    return { ok: true, content: replaceMatch(content, showMatches[0], replacement) };
  }
  if (showMatches.length > 1) {
    return { ok: false, reason: `ambiguous: ${showMatches.length} rate-limit show branches found` };
  }

  const legacyRe =
    /else if\(([\w$]+)!==this\.dismissedRateLimitKey\)this\.rateLimitWarning\.value=([\w$]+\(([\w$]+)\));/g;
  const matches = [...content.matchAll(legacyRe)];
  if (matches.length === 0) {
    return { ok: false, reason: 'rate-limit warning site not found (Claude Code internals may have changed)' };
  }
  if (matches.length > 1) {
    return { ok: false, reason: `ambiguous: ${matches.length} rate-limit warning sites found` };
  }

  const [, keyVar, call, infoVar] = matches[0];
  const replacement =
    `else if(${keyVar}!==this.dismissedRateLimitKey)this.rateLimitWarning.value=` +
    `/*__ccaaRateLimit*/${infoVar}.status==="rejected"?${call}:null/*__ccaaRateLimitEnd*/;`;
  return { ok: true, content: replaceMatch(content, matches[0], replacement) };
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
//   the session rendered in this webview (and applies the family's effort). Alias entries
//   (older spellings, present since 2.1.261) are skipped; __ccaaPickable orders the real
//   models first so the family lookups below and in the quick-send buttons prefer them.
// - Ctrl+0 / Ctrl+1 / Ctrl+2 / Ctrl+3 keydown handlers (same listener) that switch the
//   session to Fable / Opus / Sonnet / Haiku and submit the composer in one go — the
//   keyboard equivalent of the quick-send buttons (Opus has no button).
function injectModelUi(content, { contextOnByDefault = false } = {}) {
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
    // A single pill. Older builds rendered three spans (served → selected); rebuild those.
    `var __ccaaBadge=document.getElementById("ccaa-model-badge");` +
    `if(__ccaaBadge&&(!document.getElementById("ccaa-model-badge-main")||document.getElementById("ccaa-model-badge-served"))){__ccaaBadge.remove();__ccaaBadge=null}` +
    `if(!__ccaaBadge){__ccaaBadge=document.createElement("div");__ccaaBadge.id="ccaa-model-badge";` +
    `__ccaaBadge.style.cssText="position:fixed;top:36px;right:14px;z-index:99999;display:flex;align-items:center;font-size:11px;font-family:var(--vscode-font-family);line-height:16px;cursor:pointer;user-select:none;opacity:.95";` +
    `var __ccaaSpan=document.createElement("span");__ccaaSpan.id="ccaa-model-badge-main";` +
    `__ccaaSpan.style.cssText="padding:1px 8px;border-radius:9px";__ccaaBadge.appendChild(__ccaaSpan);` +
    `document.body.appendChild(__ccaaBadge)}` +
    `__ccaaBadge.onclick=()=>${openPickerVar}(!0);` +
    `var __ccaaMainEl=document.getElementById("ccaa-model-badge-main");` +
    `var __ccaaModels=${sessionVar}.claudeConfig.value?.models??[];` +
    `var __ccaaSelected=${sessionVar}.modelSelection.value??"default";` +
    `var __ccaaSelModel=__ccaaModels.find((__ccaaM)=>__ccaaM.value===__ccaaSelected);` +
    // What the session runs is the model that last answered (lastServedModel): upstream
    // clears it inside setModel, so while it is set no switch has been requested since and
    // the next answer comes from that same model. modelSelection cannot be trusted for
    // that: it is seeded from the *global* default on launch, which the session-scoped
    // switch never writes, so a resumed Fable session reads "opus" while the CLI keeps
    // serving Fable. When the two families disagree the badge therefore shows the served
    // model (as upstream's own footer label does) and only mentions the picker's value in
    // the tooltip. currentMainLoopModel keeps the pre-switch value, so it is only a color
    // hint when neither carries a family (e.g. "default").
    `var __ccaaServed=String(${sessionVar}.lastServedModel?.value??"");` +
    `var __ccaaRunning=String(${sessionVar}.currentMainLoopModel?.value??"");` +
    `var __ccaaFamOf=(__ccaaS)=>(String(__ccaaS??"").toLowerCase().match(/fable|opus|sonnet|haiku/)??[null])[0];` +
    `var __ccaaSelFam=__ccaaFamOf(__ccaaSelected+" "+(__ccaaSelModel?.displayName??""));` +
    `var __ccaaServedFam=__ccaaFamOf(__ccaaServed);` +
    `var __ccaaDrift=!!(__ccaaSelFam&&__ccaaServedFam&&__ccaaSelFam!==__ccaaServedFam);` +
    `var __ccaaServedModel=__ccaaModels.find((__ccaaM)=>__ccaaM.resolvedModel===__ccaaServed)??__ccaaModels.find((__ccaaM)=>__ccaaM.value===__ccaaServedFam);` +
    `var __ccaaShownModel=__ccaaDrift?__ccaaServedModel:__ccaaSelModel;` +
    `var __ccaaLabel=__ccaaDrift?(__ccaaServedModel?.displayName??__ccaaServedFam):(${nameVar}??__ccaaSelModel?.displayName??__ccaaSelected);` +
    `var __ccaaSelLabel=__ccaaSelModel?.displayName??__ccaaSelected;` +
    // Append the current effort to the badge when the shown model supports it (reading these
    // reactive signals also re-runs this effect on effort changes, keeping the badge live).
    // Ultracode is xhigh + workflows, so show "ultra" rather than the bare "xhigh".
    `var __ccaaSupportsEffort=__ccaaShownModel?__ccaaShownModel.supportsEffort:${sessionVar}.currentModelSupportsEffort?.value;` +
    `var __ccaaEffort=(__ccaaSupportsEffort&&${sessionVar}.effortLevel?.value)?String(${sessionVar}.effortLevel.value):"";` +
    `if(__ccaaEffort&&${sessionVar}.ultracodeEnabled?.value)__ccaaEffort="ultra";` +
    `var __ccaaColorOf=(__ccaaF)=>__ccaaF==="fable"?"#8052d2":__ccaaF==="opus"?"#c63e3e":__ccaaF==="sonnet"?"#bc8e26":__ccaaF==="haiku"?"#269473":null;` +
    `var __ccaaColor=__ccaaColorOf(__ccaaServedFam??__ccaaSelFam??__ccaaFamOf(__ccaaRunning));` +
    `__ccaaMainEl.style.background=__ccaaColor??"var(--vscode-badge-background,#4d4d4d)";` +
    `__ccaaMainEl.style.color=__ccaaColor?"#fff":"var(--vscode-badge-foreground,#fff)";` +
    `__ccaaMainEl.textContent=__ccaaEffort?String(__ccaaLabel)+" \xB7 "+__ccaaEffort:String(__ccaaLabel);` +
    `__ccaaBadge.title=(__ccaaEffort?"Claude model + effort ("+String(__ccaaLabel)+" \xB7 "+__ccaaEffort+")":"Claude model ("+String(__ccaaLabel)+")")` +
    `+(__ccaaDrift?" — the picker shows "+String(__ccaaSelLabel)+", your default, which was never applied to this session":"")` +
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
    // Since 2.1.261 the model list also carries alias entries (older spellings of a model,
    // flagged by "alias" in their name/description — the same test upstream's picker uses to
    // list them last). Order the real models first so a family lookup lands on the current
    // spelling, and leave the aliases out of the cycle unless they are all there is.
    `globalThis.__ccaaIsAlias=(__ccaaM)=>/\\balias(?:es)?\\b/i.test(String(__ccaaM.displayName??"")+" "+String(__ccaaM.description??""));` +
    `globalThis.__ccaaPickable=(__ccaaL)=>__ccaaL.filter((__ccaaM)=>!globalThis.__ccaaIsAlias(__ccaaM)).concat(__ccaaL.filter(globalThis.__ccaaIsAlias));` +
    `globalThis.__ccaaCycleModel=()=>{` +
    `var __ccaaAll=${sessionVar}.claudeConfig.value?.models??[];` +
    `var __ccaaList=__ccaaAll.filter((__ccaaM)=>!globalThis.__ccaaIsAlias(__ccaaM));` +
    `if(__ccaaList.length<2)__ccaaList=__ccaaAll;if(__ccaaList.length<2)return;` +
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
    `var __ccaaList=globalThis.__ccaaPickable(${sessionVar}.claudeConfig.value?.models??[]);` +
    `var __ccaaTarget=__ccaaList.find((__ccaaM)=>__ccaaRe.test(__ccaaM.value)||__ccaaRe.test(__ccaaM.displayName));` +
    `if(!__ccaaTarget)return;var __ccaaForm=__ccaaBtn.form;` +
    `Promise.resolve(__ccaaNeedsSwitch(${sessionVar},__ccaaTarget,__ccaaRe)?${sessionVar}.setModel(__ccaaTarget):null)` +
    `.then(()=>globalThis.__ccaaApplyEffort(${sessionVar},__ccaaTarget))` +
    `.then(()=>{if(__ccaaForm)__ccaaForm.requestSubmit()})};` +
    // Attach/detach the current file/selection: flip the global the composer's send-time
    // include flag reads, and mirror it onto <body> so the CSS patch can dim the file chip
    // while context is off (the chip itself stays — it is what shows which file is current,
    // and what the X button removes). Turning context back on also re-publishes the current
    // selection when the chip was dismissed, clearing upstream's `dismissedSelection` memory
    // first — otherwise the next update for that same file is swallowed.
    `if(globalThis.__ccaaContextOn===void 0)globalThis.__ccaaContextOn=${contextOnByDefault ? '!0' : '!1'};` +
    `var __ccaaMarkCtx=()=>{try{document.body.dataset.ccaaContext=globalThis.__ccaaContextOn?"on":"off"}catch(__ccaaMe){}};` +
    `__ccaaMarkCtx();` +
    `globalThis.__ccaaToggleContext=()=>{try{` +
    `globalThis.__ccaaContextOn=!globalThis.__ccaaContextOn;__ccaaMarkCtx();` +
    `if(globalThis.__ccaaContextOn&&${sessionVar}.selection.value===void 0){` +
    `${sessionVar}.dismissedSelection=void 0;` +
    `var __ccaaSel=${sessionVar}.context?.currentSelection?.value;` +
    `if(__ccaaSel!==void 0)${sessionVar}.selection.value=__ccaaSel}` +
    `}catch(__ccaaCtxE){}};` +
    `if(!globalThis.__ccaaModelKeyBound){globalThis.__ccaaModelKeyBound=!0;` +
    `window.addEventListener("keydown",(__ccaaE)=>{` +
    `if(!(__ccaaE.ctrlKey&&!__ccaaE.metaKey&&!__ccaaE.altKey&&!__ccaaE.shiftKey))return;` +
    `if(__ccaaE.key==="m"||__ccaaE.key==="M"){__ccaaE.preventDefault();__ccaaE.stopPropagation();globalThis.__ccaaCycleModel?.()}` +
    `else if(__ccaaE.key==="1"){__ccaaE.preventDefault();__ccaaE.stopPropagation();globalThis.__ccaaSendWithModel?.(/opus/i)}` +
    `else if(__ccaaE.key==="2"){__ccaaE.preventDefault();__ccaaE.stopPropagation();globalThis.__ccaaSendWithModel?.(/sonnet/i)}` +
    `else if(__ccaaE.key==="3"){__ccaaE.preventDefault();__ccaaE.stopPropagation();globalThis.__ccaaSendWithModel?.(/haiku/i)}` +
    `else if(__ccaaE.key==="0"){__ccaaE.preventDefault();__ccaaE.stopPropagation();globalThis.__ccaaSendWithModel?.(/fable/i)}` +
    `else if(__ccaaE.key==="f"||__ccaaE.key==="F"){__ccaaE.preventDefault();__ccaaE.stopPropagation();globalThis.__ccaaToggleContext?.()}` +
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
    /([\w$]+(?:\.[\w$]+)*)\("button",\{type:"submit",disabled:!([\w$]+)\.busy\.value&&!([\w$]+),className:([\w$]+)\.sendButton,"data-permission-mode":[\w$]+,(?:"aria-label":[\w$]+,)?onClick:\(([\w$]+)\)=>\{if\(\2\.busy\.value&&!\3\)\5\.preventDefault\(\),\2\.interrupt\(\)\}(?:\},([\w$]+)\)|,children:([\w$]+)\}\))/g;
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
    `__ccaaModels=globalThis.__ccaaPickable?.(__ccaaModels)??__ccaaModels;` +
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

const URI_OPEN_WV_SENTINEL_RE = /\/\*__ccaaUriOpenWv\*\/[\s\S]*?\/\*__ccaaUriOpenWvEnd\*\//g;

// Companion of the extension.js uri-open-in-editor patch. Chat panels (never the side bar)
// listen for the custom top-level "ccaa-open" window message the extension posts when a
// vscode://anthropic.claude-code/open URI arrives. The extension has already opened/revealed
// the panel with the right session, so this listener only finishes the job: it types the
// prompt when the extension could not hand it to the stock panel (session was already open),
// and — when autoSend is set — submits the composer once the prompt has been typed and the
// session is idle. `match` is the URI's session id: the message is ignored until the panel
// actually shows that session, which is how a broadcast (used when the panel already existed)
// still lands in exactly one panel. `strict` marks that broadcast: the match then has 5s to
// happen, otherwise this panel is not the target. A nonce set dedupes the delivery retries.
// Injected at the app bootstrap, the one spot where the session store is in scope. That call
// keeps changing shape around it — a plain statement up to 2.1.257, an `if(…)` operand in
// 2.1.261, an assignment inside one since 2.1.270 — and each shape wants a different join
// (a leading comma would have silently stolen the assignment's value). So the IIFE rides
// along as a second argument to listSessions instead, which ignores it: an argument list is
// an expression position no matter what surrounds the call.
function injectUriOpenListener(content) {
  const anchorRe = /([\w$]+)\.listSessions\("panel_boot"\)\.then/g;
  const matches = [...content.matchAll(anchorRe)];
  if (matches.length === 0) {
    return { ok: false, reason: 'panel_boot bootstrap not found (Claude Code internals may have changed)' };
  }
  if (matches.length > 1) {
    return { ok: false, reason: `ambiguous: ${matches.length} panel_boot bootstraps found` };
  }

  const [, storeVar] = matches[0];
  const insertion =
    `/*__ccaaUriOpenWv*/,(()=>{try{if(!window.IS_SIDEBAR&&!globalThis.__ccaaUriOpenBound){globalThis.__ccaaUriOpenBound=!0;` +
    `var __ccaaUriSeen=new Set;` +
    `window.addEventListener("message",(__ccaaUriEv)=>{try{` +
    `var __ccaaUriMsg=__ccaaUriEv.data;` +
    `if(!__ccaaUriMsg||__ccaaUriMsg.type!=="ccaa-open")return;` +
    `var __ccaaUriPrompt=typeof __ccaaUriMsg.prompt==="string"&&__ccaaUriMsg.prompt?__ccaaUriMsg.prompt:void 0;` +
    `if(!__ccaaUriPrompt)return;` +
    `if(__ccaaUriMsg.nonce){if(__ccaaUriSeen.has(__ccaaUriMsg.nonce))return;__ccaaUriSeen.add(__ccaaUriMsg.nonce)}` +
    `var __ccaaUriT0=Date.now(),__ccaaUriSess,__ccaaUriTyped=!1;` +
    `var __ccaaUriTimer=setInterval(()=>{try{` +
    `if(Date.now()-__ccaaUriT0>30000){clearInterval(__ccaaUriTimer);return}` +
    `var __ccaaUriCur=${storeVar}.activeSession.value;` +
    // Not our panel (or not ready yet): a broadcast only waits 5s for the session to show up.
    `if(!__ccaaUriCur||__ccaaUriMsg.match&&__ccaaUriCur.sessionId.value!==String(__ccaaUriMsg.match)){` +
    `if(__ccaaUriMsg.strict&&Date.now()-__ccaaUriT0>5000)clearInterval(__ccaaUriTimer);return}` +
    `if(__ccaaUriSess&&__ccaaUriCur!==__ccaaUriSess){clearInterval(__ccaaUriTimer);return}` +
    `__ccaaUriSess=__ccaaUriCur;` +
    `if(__ccaaUriMsg.typePrompt&&!__ccaaUriTyped){__ccaaUriTyped=!0;__ccaaUriSess.initialPrompt.value=__ccaaUriPrompt;return}` +
    `if(!__ccaaUriMsg.autoSend){clearInterval(__ccaaUriTimer);return}` +
    // Wait for the prompt to reach the composer (initialPrompt consumed) and the session to idle.
    `if(__ccaaUriSess.initialPrompt.value!==void 0||__ccaaUriSess.busy.value)return;` +
    `var __ccaaUriBtn=document.querySelector('button[type="submit"][data-permission-mode]');` +
    `if(!__ccaaUriBtn||__ccaaUriBtn.disabled||!__ccaaUriBtn.form)return;` +
    `clearInterval(__ccaaUriTimer);__ccaaUriBtn.form.requestSubmit()` +
    `}catch(__ccaaUriE1){clearInterval(__ccaaUriTimer)}},250)` +
    `}catch(__ccaaUriE2){}})}}catch(__ccaaUriE3){}})()/*__ccaaUriOpenWvEnd*/`;

  return {
    ok: true,
    content: replaceMatch(content, matches[0], `${storeVar}.listSessions("panel_boot"${insertion}).then`),
  };
}

const MOUNT_FOCUS_REVERT_RE = /\/\*__ccaaMountFocus:([^*]*)\*\/[\w$]+\.current\?\.focus\(\)/;

// Since 2.1.257 the effect that focuses the composer when a session mounts (new panel, session
// switch) is gated on `ambientFocusAllowed()`, i.e. `document.hasFocus()`. A freshly opened
// Claude tab never satisfies it: VS Code's focus lands on the webview shell before the app's
// iframe exists, so the document never reports focus and the one-shot attempt is dropped —
// the composer stays unfocused. Up to 2.1.233 the effect called the composer's focus directly
// (still through `safeFocus`, which only checks the connection's `isVisible`), and a plain
// `element.focus()` pulls focus into the webview by itself. Restore that call: the gate wrapper
// is parked in a sentinel comment for a byte-exact revert. Nothing else about the effect
// changes — it still bails when an input already has focus.
function injectSessionMountFocus(content) {
  const anchorRe =
    /if\(([\w$]+)\(document\.activeElement\)\)return;([\w$]+\(\(\)=>([\w$]+\.current\?\.focus\(\)),\(\)=>([\w$]+)\.ambientFocusAllowed\(\)\))\},\[\4,[\w$]+\.sessionId\.value\]\)/g;
  const matches = [...content.matchAll(anchorRe)];
  if (matches.length === 0) {
    return { ok: false, reason: 'session-mount focus effect not found (Claude Code internals may have changed)' };
  }
  if (matches.length > 1) {
    return { ok: false, reason: `ambiguous: ${matches.length} session-mount focus effects found` };
  }

  const [whole, , gatedCall, focusCall] = matches[0];
  const replaced = whole.replace(gatedCall, () => `/*__ccaaMountFocus:${gatedCall}*/${focusCall}`);
  return { ok: true, content: replaceMatch(content, matches[0], replaced) };
}

function revertSessionMountFocus(content) {
  return MOUNT_FOCUS_REVERT_RE.test(content) ? content.replace(MOUNT_FOCUS_REVERT_RE, (_, original) => original) : content;
}

const ASK_FOCUS_REVERT_RE = /\/\*__ccaaAskFocus\*\/document\.hasFocus\(\)&&/g;

// The AskUserQuestion widget focuses its first option as soon as it renders, with a bare
// `.focus()` — no visibility or focus gate, unlike every other permission request (those go
// through `safeFocus` and, for the option list, `document.hasFocus()`). Inside a webview
// iframe that call pulls window focus into the panel, so a question asked while you type in
// an editor or terminal steals the keystrokes. Gate it on `document.hasFocus()`: the panel
// only grabs focus when focus is already inside it, and moving between questions (the effect
// re-runs on the question index) still focuses the first option.
function injectAskQuestionFocus(content) {
  const anchorRe = /[\w$]+\.querySelector\('\[role="radio"\], \[role="checkbox"\]'\)\?\.focus\(\)/g;
  const matches = [...content.matchAll(anchorRe)];
  if (matches.length === 0) {
    return { ok: false, reason: 'question option auto-focus not found (Claude Code internals may have changed)' };
  }
  if (matches.length > 1) {
    return { ok: false, reason: `ambiguous: ${matches.length} question option auto-focus sites found` };
  }

  const [whole] = matches[0];
  return { ok: true, content: replaceMatch(content, matches[0], `/*__ccaaAskFocus*/document.hasFocus()&&${whole}`) };
}

function revertAskQuestionFocus(content) {
  return content.replace(ASK_FOCUS_REVERT_RE, '');
}

const ASK_NOTES_JSX_SENTINEL_RE = /,\/\*__ccaaAskNotes\*\/[\s\S]*?\/\*__ccaaAskNotesEnd\*\//g;
const ASK_NOTES_OUT_REVERT_RE =
  /\/\*__ccaaAskNotesOut\*\/\(\(__ccaaP\)=>\{[\s\S]*?\}\)\(([\s\S]*?)\)\/\*__ccaaAskNotesOutEnd\*\//g;

// AskUserQuestion only takes free text through the "Other" option, i.e. instead of a choice —
// picking an option and adding a caveat is impossible in the webview. The CLI side already
// supports it: the tool input carries `annotations[question].notes`, which the CLI renders into
// the tool result as `notes: …` next to the answer (and, when notes are present, tells the model
// to read the answer carefully rather than treating it as a plain pick). Its "(notes only)"
// answer sentinel covers notes without a selection. So this only adds the missing input.
//
// Two edits, both required (a notes box that never reaches the model is worse than none):
//   1. a free-text box at the end of every question's option list, hidden while "Other" is
//      selected — "Other" already shows the same box inline, and both write the same state,
//      so no new hook is added and nothing is lost when switching between the two;
//   2. the effect that reports the answers back also reports the notes, and fills in the
//      "(notes only)" answer for a question that got notes but no pick (the submit button is
//      gated on every question having a non-empty answer).
// Enter in the box submits (it bubbles to the dialog, which owns Enter), Shift+Enter breaks a
// line, and every other key is stopped so the option list's arrow/digit handling stays out.
function injectAskQuestionNotes(content) {
  const jsxRe =
    /([\w$]+)\("Other"\)&&([\w$]+)\("div",\{onFocus:\(\)=>([\w$]+)\(!0\),onBlur:\(\)=>\3\(!1\),onClick:\(([\w$]+)\)=>\4\.stopPropagation\(\),children:\2\(([\w$]+),\{ref:[\w$]+,className:([\w$]+)\.otherInput,placeholder:"[^"]*",value:([\w$]+)\[([\w$]+)\.question\]\|\|"",onChange:\([\w$]+\)=>([\w$]+)\([\w$]+\.question,[\w$]+\),onKeyDown:[\s\S]{0,400}?\}\}\}\)\}\)\]\}\)\]\}\)(\]\}\))/g;
  const jsxMatches = [...content.matchAll(jsxRe)];
  if (jsxMatches.length === 0) {
    return { ok: false, reason: 'question "Other" input not found (Claude Code internals may have changed)' };
  }
  if (jsxMatches.length > 1) {
    return { ok: false, reason: `ambiguous: ${jsxMatches.length} question "Other" inputs found` };
  }

  const outRe =
    /([\w$]+)\(\{questions:([\w$]+)\.questions,answers:([\w$]+)\}\)\},\[([\w$]+),([\w$]+),\2\.questions,\1\]\)/g;
  const outMatches = [...content.matchAll(outRe)];
  if (outMatches.length === 0) {
    return { ok: false, reason: 'question answers effect not found (Claude Code internals may have changed)' };
  }
  if (outMatches.length > 1) {
    return { ok: false, reason: `ambiguous: ${outMatches.length} question answers effects found` };
  }

  const [jsxWhole, isChecked, jsx, setTextFocused, , input, styles, textMap, question, setText, tail] = jsxMatches[0];
  const notesBox =
    `,/*__ccaaAskNotes*/!${isChecked}("Other")&&${jsx}("div",{` +
    `onFocus:()=>${setTextFocused}(!0),onBlur:()=>${setTextFocused}(!1),` +
    `onClick:(__ccaaE)=>__ccaaE.stopPropagation(),` +
    `children:${jsx}(${input},{className:${styles}.otherInput,placeholder:"Add notes (optional)…",` +
    `value:${textMap}[${question}.question]||"",onChange:(__ccaaV)=>${setText}(${question}.question,__ccaaV),` +
    `onKeyDown:(__ccaaE)=>{` +
    `if(__ccaaE.key==="Enter"&&!__ccaaE.shiftKey&&!__ccaaE.metaKey&&!__ccaaE.ctrlKey){` +
    `if(__ccaaE.nativeEvent.isComposing)return;__ccaaE.preventDefault();return}` +
    `if(!__ccaaE.metaKey&&!__ccaaE.ctrlKey)__ccaaE.stopPropagation()}})})/*__ccaaAskNotesEnd*/`;
  const withBox = replaceMatch(
    content,
    jsxMatches[0],
    jsxWhole.slice(0, jsxWhole.length - tail.length) + notesBox + tail
  );

  const [, report, props, answers, selections, texts] = outMatches[0];
  const original = `{questions:${props}.questions,answers:${answers}}`;
  const reportWithNotes =
    `${report}(/*__ccaaAskNotesOut*/((__ccaaP)=>{try{` +
    `for(var __ccaaQ of __ccaaP.questions||[]){` +
    `var __ccaaSel=${selections}[__ccaaQ.question];` +
    `if(__ccaaSel&&__ccaaSel.has("Other"))continue;` +
    `var __ccaaN=(${texts}[__ccaaQ.question]||"").trim();if(!__ccaaN)continue;` +
    `(__ccaaP.annotations||(__ccaaP.annotations={}))[__ccaaQ.question]={notes:__ccaaN};` +
    `if(!__ccaaP.answers[__ccaaQ.question])__ccaaP.answers[__ccaaQ.question]="(notes only)"}` +
    `}catch(__ccaaE){}return __ccaaP})(${original})/*__ccaaAskNotesOutEnd*/)},` +
    `[${selections},${texts},${props}.questions,${report}])`;

  return { ok: true, content: replaceMatch(withBox, outMatches[0], reportWithNotes) };
}

function revertAskQuestionNotes(content) {
  return content
    .replace(ASK_NOTES_JSX_SENTINEL_RE, '')
    .replace(ASK_NOTES_OUT_REVERT_RE, (_, original) => original);
}

const NO_ADVANCE_REVERT_RE = /\/\*__ccaaNoAdvance:([^*]*)\*\//g;

// Picking an option in a multi-question dialog jumps to the next question 300ms later, which
// makes the notes box above unreachable right when you want it: the question you just answered
// is gone before you can annotate it. Drop the clause — the nav tabs (which mark answered
// questions) and ArrowLeft/ArrowRight still move between questions, and submit is unaffected:
// it stays gated on every question having an answer. The clause is parked in a sentinel
// comment for a byte-exact revert.
function injectNoQuestionAutoAdvance(content) {
  const anchorRe =
    /else if\(([\w$]+)===null&&([\w$]+)\.questions&&([\w$]+)<\2\.questions\.length-1\)([\w$]+)\([\w$]+\),setTimeout\(\(\)=>\{\4\(null\),[\w$]+\(\3\+1\)\},300\);/g;
  const matches = [...content.matchAll(anchorRe)];
  if (matches.length === 0) {
    return { ok: false, reason: 'question auto-advance not found (Claude Code internals may have changed)' };
  }
  if (matches.length > 1) {
    return { ok: false, reason: `ambiguous: ${matches.length} question auto-advance sites found` };
  }

  const [whole] = matches[0];
  return { ok: true, content: replaceMatch(content, matches[0], `/*__ccaaNoAdvance:${whole}*/`) };
}

function revertQuestionAutoAdvance(content) {
  return content.replace(NO_ADVANCE_REVERT_RE, (_, original) => original);
}

// --- extension.js sub-patches ---

const URI_OPEN_EXT_SENTINEL_RE = /\/\*__ccaaUriOpenExt\*\/[\s\S]*?\/\*__ccaaUriOpenExtEnd\*\//g;

// vscode://anthropic.claude-code/open?prompt=…&session=… normally opens the session with
// claude-vscode.primaryEditor.open, i.e. in the *active* editor group (ViewColumn.Active
// up to 2.1.257; since 2.1.261 it falls back to Active only when no group holds *solely*
// Claude panels) — so a URI hijacks whatever group you were working in. Route it through
// claude-vscode.editor.open instead — the command behind "open Claude in an editor" — with
// the target column resolved here (stock's own "a group whose tabs are all Claude panels"
// rule loses the group as soon as a file is dropped in it) and a lock afterwards, so a
// session always lands in the locked Claude group. It also only types the prompt, so a
// "ccaa-open" message is posted to the target panel's webview, whose injected listener (see
// injectUriOpenListener) submits it. Delivery is retried for ~15s because the panel may still
// be booting; the listener's nonce set makes retries idempotent.
//
// The target is the webview added by the open call (diffing the manager's webview set), which
// pins the message to exactly one panel. When the session already had a panel, none is added:
// the panel is only revealed, and the stock command drops the prompt ("Session is already
// open…"), so the prompt is withheld from it (no warning), the message carries typePrompt and
// is broadcast to the chat webviews, and the session id in `match` picks the single panel
// showing it. The original primaryEditor.open call is kept as the fallback when the setting is
// off or anything throws.
function injectUriOpenInEditor(content) {
  // Anchor spans the tail of the /install-plugin case (to capture the webview-manager var
  // off its notifyOpenPluginsDialog call — the only manager reference in the handler) and
  // the whole /open case. 2.1.257 added a session-id validation between the parameter reads
  // and the open call (`if(x!==void 0&&!SH(x))return;`); it is matched optionally and kept
  // in place, so the injected code still runs after it.
  const anchorRe =
    /([\w$]+)\.notifyOpenPluginsDialog\([\w$]+,[\w$]+\)\}\);return\}case"\/open":\{let ([\w$]+)=([\w$]+)\.get\("session"\)\?\?void 0,([\w$]+)=\3\.get\("prompt"\)\?\?void 0;(?:if\(\2!==void 0&&![\w$]+\(\2\)\)return;)?([\w$]+)\.commands\.executeCommand\("claude-vscode\.primaryEditor\.open",\2,\4\);return\}/g;
  const matches = [...content.matchAll(anchorRe)];
  if (matches.length === 0) {
    return { ok: false, reason: 'uri /open handler not found (Claude Code internals may have changed)' };
  }
  if (matches.length > 1) {
    return { ok: false, reason: `ambiguous: ${matches.length} uri /open handlers found` };
  }

  const [whole, managerVar, sessionVar, , promptVar, vscodeNs] = matches[0];
  const originalTail = `${vscodeNs}.commands.executeCommand("claude-vscode.primaryEditor.open",${sessionVar},${promptVar});return}`;
  const insertion =
    `/*__ccaaUriOpenExt*/try{` +
    `var __ccaaUriCfg=require("vscode").workspace.getConfiguration("claude-code-no-auto-attach");` +
    `if(__ccaaUriCfg.get("uriOpensInEditor",true)){` +
    `var __ccaaUriViews=${managerVar}.webviews,__ccaaUriBefore=new Set(__ccaaUriViews),__ccaaUriReopen=!1;` +
    `try{__ccaaUriReopen=!!${sessionVar}&&${managerVar}.sessionPanels.has(${sessionVar})}catch(__ccaaUriE1){}` +
    `var __ccaaUriIsCC=(__ccaaUriTab)=>__ccaaUriTab.input instanceof ${vscodeNs}.TabInputWebview&&` +
    `__ccaaUriTab.input.viewType.includes("claudeVSCodePanel");` +
    // Pick the Claude group ourselves: stock only reuses a group whose tabs are *all* Claude
    // panels, so one dropped file sends the session to a brand-new column. A group holding a
    // session is the Claude group whatever else sits in it (most sessions wins, then
    // rightmost); failing that, a group that is open but empty — VS Code only keeps those
    // around when they are locked, which is the empty Claude group waiting for a session.
    // Nothing found: leave the column undefined and let stock create and lock one.
    `var __ccaaUriCol=void 0;try{var __ccaaUriGroups=${vscodeNs}.window.tabGroups.all,__ccaaUriBest=0;` +
    `for(var __ccaaUriG of __ccaaUriGroups){var __ccaaUriN=__ccaaUriG.tabs.filter(__ccaaUriIsCC).length;` +
    `if(__ccaaUriN>0&&__ccaaUriN>=__ccaaUriBest){__ccaaUriBest=__ccaaUriN;__ccaaUriCol=__ccaaUriG.viewColumn}}` +
    `if(__ccaaUriCol===void 0&&__ccaaUriGroups.length>1)for(var __ccaaUriG2 of __ccaaUriGroups)` +
    `if(__ccaaUriG2.tabs.length===0)__ccaaUriCol=__ccaaUriG2.viewColumn}catch(__ccaaUriE5){}` +
    `var __ccaaUriPayload={type:"ccaa-open",prompt:${promptVar}??null,match:${sessionVar}??null,` +
    `typePrompt:__ccaaUriReopen,strict:!1,autoSend:!!__ccaaUriCfg.get("uriAutoSendsPrompt",true),` +
    `nonce:Date.now()+"-"+Math.random()};` +
    `Promise.resolve(${vscodeNs}.commands.executeCommand("claude-vscode.editor.open",${sessionVar},` +
    `__ccaaUriReopen?void 0:${promptVar},__ccaaUriCol)).then(()=>{try{` +
    // Claude groups are meant to stay locked; stock only locks a group it had to create. The
    // panel takes focus, so the group it landed in is the active one, and locking is a no-op
    // when it already is. Never the last remaining group — locking that one traps the editor.
    `try{var __ccaaUriGroup=${vscodeNs}.window.tabGroups.activeTabGroup;` +
    `if(${vscodeNs}.window.tabGroups.all.length>1&&__ccaaUriGroup&&__ccaaUriGroup.tabs.some(__ccaaUriIsCC))` +
    `${vscodeNs}.commands.executeCommand("workbench.action.lockEditorGroup")}catch(__ccaaUriE4){}` +
    `if(!${promptVar})return;` +
    `var __ccaaUriAll=[...__ccaaUriViews].filter((__ccaaUriV)=>__ccaaUriV.isChatSurface);` +
    `var __ccaaUriTargets=__ccaaUriAll.filter((__ccaaUriV)=>!__ccaaUriBefore.has(__ccaaUriV));` +
    `if(__ccaaUriTargets.length!==1){if(!__ccaaUriPayload.match)return;__ccaaUriTargets=__ccaaUriAll;__ccaaUriPayload.strict=!0}` +
    `var __ccaaUriTries=0;` +
    `var __ccaaUriTick=()=>{__ccaaUriTries++;` +
    `for(var __ccaaUriView of __ccaaUriTargets)try{__ccaaUriView.comms.webview.postMessage(__ccaaUriPayload)}catch(__ccaaUriE2){}` +
    `if(__ccaaUriTries<30)setTimeout(__ccaaUriTick,500)};` +
    `__ccaaUriTick()}catch(__ccaaUriE3){}},()=>{});` +
    `return}}catch(__ccaaUriE0){}/*__ccaaUriOpenExtEnd*/`;

  return { ok: true, content: replaceMatch(content, matches[0], whole.replace(originalTail, () => insertion + originalTail)) };
}

function injectCanUseToolGuard(content) {
  const anchorRe = /if\(([\w$]+)\.request\.subtype==="can_use_tool"\)\{if\(!this\.canUseTool\)throw Error\("canUseTool callback is not provided\."\);/g;
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

  return { ok: true, content: content.replace(anchor, () => anchor + insertion) };
}

function revertCanUseToolGuard(content) {
  const guardRe = /try\{var __ccaaCfg=require\("vscode"\)\.workspace\.getConfiguration\("claude-code-no-auto-attach"\);[\s\S]*?\}catch\(__ccaaErr\)\{\}/;
  return guardRe.test(content) ? content.replace(guardRe, '') : content;
}

function injectPermissionModeCapture(content) {
  const anchorRe = /setPermissionMode\(([\w$]+)\)\{await this\.request\(\{subtype:"set_permission_mode",mode:\1\}\)\}/g;
  const matches = [...content.matchAll(anchorRe)];
  if (matches.length === 0) {
    return { ok: false, reason: 'setPermissionMode anchor not found (Claude Code internals may have changed)' };
  }
  if (matches.length > 1) {
    return { ok: false, reason: `ambiguous: ${matches.length} setPermissionMode anchors found` };
  }

  const [anchor, varName] = matches[0];
  const replacement = anchor.replace(`${varName}){`, () => `${varName}){globalThis.__ccaaPermissionMode=${varName};`);
  return { ok: true, content: content.replace(anchor, () => replacement) };
}

function revertPermissionModeCapture(content) {
  const captureRe = /(setPermissionMode\(([\w$]+)\)\{)globalThis\.__ccaaPermissionMode=\2;/;
  return captureRe.test(content) ? content.replace(captureRe, '$1') : content;
}

const SESSION_MODEL_SENTINEL_RE = /\/\*__ccaaSessionModel\*\/[\s\S]*?\/\*__ccaaSessionModelEnd\*\//g;

// Upstream persists every model switch to ~/.claude/settings.json (it becomes the new
// global default). Reroute it to the SDK's session-scoped set_model control request so
// switching only affects the current session. Since 2.1.261 the response also carries the
// CLI's `applied` settings (the webview adopts `applied.effort` after a switch, e.g. a
// per-model effort from `modelSettings`), so the same is read back via getSettings — best
// effort, the switch itself never depends on it. That read-back sits in the latency of every
// switch, and the quick-send shortcuts wait for the whole switch before submitting, so it is
// raced against a 200ms timeout: a CLI that answers in time still feeds `applied`, a slow one
// costs 200ms instead of however long it takes.
function injectSessionScopedModel(content) {
  // Anchor on the writeUserSettingsAndPush(channel,{model:…}) statement itself rather than
  // the method signature: 2.1.270 put a malformed-request guard in front of it, so the
  // signature is no longer adjacent to the write — and the early return has to sit *after*
  // that guard anyway. The `{model:…}` argument shape is what keeps the match unique, and
  // the leading `let …=await`/`return await` pins it to a statement boundary.
  const anchorRe =
    /(?:return await |let [\w$]+=await )this\.writeUserSettingsAndPush\(([\w$]+),\{model:([\w$]+)\.value==="default"\?null:\2\.value\}\)/g;
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
    `if(__ccaaScoped)return await this.withChannel(${channelVar},async(__ccaaChannel)=>{` +
    `await __ccaaChannel.query.setModel(${modelVar}.value==="default"?void 0:${modelVar}.value);` +
    `var __ccaaApplied;try{` +
    `var __ccaaRead=__ccaaChannel.query.getSettings().catch(()=>void 0);` +
    `__ccaaApplied=(await Promise.race([__ccaaRead,new Promise((__ccaaRs)=>setTimeout(__ccaaRs,200))]))?.applied` +
    `}catch(__ccaaErr3){}` +
    `return{type:"set_model_response",...__ccaaApplied!==void 0&&{applied:__ccaaApplied}}});` +
    `/*__ccaaSessionModelEnd*/`;
  return { ok: true, content: replaceMatch(content, matches[0], insertion + anchor) };
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
// Since 2.1.257 applySettings takes a 4th `scope` argument ("localSettings" writes the
// project's settings.local.json and rejects flagsOnly), so the override only fires when no
// scope is given — the effort picker never passes one.
function injectSessionScopedEffort(content) {
  // Anchor on the writeUserSettingsAndPush(channel,settings,flags…) statement, not the
  // method signature. 2.1.270 added a validation prologue that derives the target layer
  // from the flags argument (`let Y=X?"flags":…`) and throws when it disagrees with the
  // setting's own layer — and effortLevel is declared as "userSettings". Flipping the flag
  // before that loop would make every effort change throw, so the flip has to land after
  // it, immediately before the write.
  const anchorRe =
    /(?:return |if\()await this\.writeUserSettingsAndPush\(([\w$]+),([\w$]+),([\w$]+)(?:,([\w$]+))?[,)]/g;
  const matches = [...content.matchAll(anchorRe)];
  if (matches.length === 0) {
    return { ok: false, reason: 'applySettings anchor not found (Claude Code internals may have changed)' };
  }
  if (matches.length > 1) {
    return { ok: false, reason: `ambiguous: ${matches.length} applySettings anchors found` };
  }

  const [anchor, , settingsVar, flagsVar, scopeVar] = matches[0];
  const noScope = scopeVar ? `${scopeVar}===void 0&&` : '';
  const insertion =
    `/*__ccaaSessionEffort*/try{if(!${flagsVar}&&${noScope}${settingsVar}&&typeof ${settingsVar}==="object"){` +
    `var __ccaaEffKeys=Object.keys(${settingsVar});` +
    `if(__ccaaEffKeys.length===1&&__ccaaEffKeys[0]==="effortLevel"&&` +
    `require("vscode").workspace.getConfiguration("claude-code-no-auto-attach").get("sessionScopedEffortSwitch",true))` +
    `${flagsVar}=!0}}catch(__ccaaEffErr){}/*__ccaaSessionEffortEnd*/`;
  return { ok: true, content: replaceMatch(content, matches[0], insertion + anchor) };
}

const MD_PREVIEW_SENTINEL_RE = /\/\*__ccaaMdPreview\*\/[\s\S]*?\/\*__ccaaMdPreviewEnd\*\//g;
const MD_PREVIEW2_SENTINEL_RE = /\/\*__ccaaMdPreview2\*\/[\s\S]*?\/\*__ccaaMdPreview2End\*\//g;
const MD_PREVIEW3_SENTINEL_RE = /\/\*__ccaaMdPreview3\*\/[\s\S]*?\/\*__ccaaMdPreview3End\*\//g;

// A markdown *preview* or *editor* tab is not a TextEditor, so focusing it makes
// activeTextEditor undefined and Claude Code drops the current-file context (you'd have
// to switch back to the raw .md). VS Code has two such implementations and we handle both:
//   1. the classic "Open Preview" — a webview panel (viewType markdown.preview), whose
//      tab input is a TabInputWebview that does NOT expose the source uri. We resolve
//      it from the tab label's basename ("Preview README.md" / "[Preview] README.md"):
//      prefer the last active markdown editor, then a uniquely-matching open markdown
//      document, then a unique workspace file.
//   2. the custom editors — vscode.markdown.preview.editor and vscode.markdown.editor
//      (the latter is what `workbench.editorAssociations` maps *.md to when you make the
//      rich editor the default) — whose tab input is a TabInputCustom that DOES expose
//      `.uri`, so we read the source path directly.
// On a hit we set the same context object shape the upstream E4 helper produces for an
// unselected file ({filePath,startLine,endLine}), which the webview renders as just the
// basename. Three insertions, all reverted by stripping their sentinel blocks:
//   - a tracker in the active-editor handler, recording the last markdown text editor;
//   - the resolver, inlined in that handler's `!editor` branch, ahead of upstream's
//     clear/retain logic;
//   - the tab listeners, registered eagerly as an extra disposable pushed next to the
//     active-editor subscription.
// The listeners have to be eager. onDidChangeActiveTextEditor only fires on text-editor
// changes, so a window that only ever shows markdown custom editors never runs that
// handler, and registering from inside it left the feature dead until you visited a text
// editor once. They also re-resolve on a macrotask: a tab that has just opened is not yet
// `activeTabGroup.activeTab` when the event fires, so the synchronous pass would read the
// tab you came from. One pass also runs at activation, for a window that starts on a
// markdown editor. The filePath dedup in the push makes every repeat a no-op.
// Opt-in debug log (touch ~/.ccaa-debug) writes the active tab's input type / viewType /
// uri / label to <tmpdir>/ccaa-md-debug.log on each event.
function injectMarkdownPreviewContext(content) {
  // The clear branch resets one-or-more module state vars before firing (2.1.197 cleared
  // just the context var; 2.1.198+ also clears a URI-string tracker: `Nd=void 0,G_=void 0,`).
  // Capture the whole `X=void 0,` run so we can preserve it verbatim and stay tolerant of
  // future additions; the context var (whose `.filePath` the resolver sets) is the first one.
  // The `<disposables>.push(` prefix is part of the anchor so the tab listeners can be
  // registered there, at activation, instead of on the first active-editor event.
  const anchorRe =
    /([\w$]+)\.push\(([\w$]+)\.window\.onDidChangeActiveTextEditor\(async\(([\w$]+)\)=>\{if\(!\3\)\{if\(([\w$]+)\(\2\.window\.visibleTextEditors\.length\)==="retain"\)return;([\w$]+)\.bump\(\),((?:[\w$]+=void 0,)+)([\w$]+)\.fire\(void 0\);return\}/g;
  const matches = [...content.matchAll(anchorRe)];
  if (matches.length === 0) {
    return { ok: false, reason: 'active-editor handler not found (Claude Code internals may have changed)' };
  }
  if (matches.length > 1) {
    return { ok: false, reason: `ambiguous: ${matches.length} active-editor handlers found` };
  }

  const [whole, disposables, vscodeNs, editorVar, retainFn, staleGuard, clearBody, emitter] = matches[0];
  const contextVar = clearBody.match(/^([\w$]+)=/)[1];

  const tracker =
    `/*__ccaaMdPreview*/try{` +
    `if(${editorVar}&&${editorVar}.document&&${editorVar}.document.languageId==="markdown")` +
    `globalThis.__ccaaLastMd=${editorVar}.document.uri.fsPath` +
    `}catch(__ccaaMd0){}/*__ccaaMdPreviewEnd*/`;

  // Shared resolver body (no try/catch, no sentinels) — reused by the active-editor
  // handler and the tab listeners. The leading filePath dedup in __ccaaPush (and the
  // findFiles path) makes re-runs against the same preview a no-op.
  const resolverBody = String.raw`var __ccaaBaseOf=function(__p){return String(__p).split(/[\\/]/).pop()};if(globalThis.__ccaaDbg===void 0){try{globalThis.__ccaaDbg=require("fs").existsSync(require("os").homedir()+"/.ccaa-debug")?require("os").tmpdir()+"/ccaa-md-debug.log":null}catch(__ccaaDbgE){globalThis.__ccaaDbg=null}}var __ccaaLog=function(__m){try{if(globalThis.__ccaaDbg)require("fs").appendFileSync(globalThis.__ccaaDbg,__m+"\n")}catch(__ccaaLogE){}};var __ccaaTab=${vscodeNs}.window.tabGroups&&${vscodeNs}.window.tabGroups.activeTabGroup&&${vscodeNs}.window.tabGroups.activeTabGroup.activeTab;var __ccaaIn=__ccaaTab&&__ccaaTab.input;var __ccaaVt=__ccaaIn&&__ccaaIn.viewType;__ccaaLog("evt in="+(__ccaaIn?__ccaaIn.constructor&&__ccaaIn.constructor.name:"none")+" vt="+(__ccaaVt||"-")+" uri="+((__ccaaIn&&__ccaaIn.uri&&__ccaaIn.uri.fsPath)||"-")+" label="+((__ccaaTab&&__ccaaTab.label)||"-"));var __ccaaPush=function(__fp){if(${contextVar}&&${contextVar}.filePath===__fp)return;${staleGuard}.bump();${contextVar}={filePath:__fp,startLine:1,endLine:1};${emitter}.fire(${contextVar});__ccaaLog("push "+__fp)};if(__ccaaIn&&__ccaaIn.uri&&__ccaaVt&&/\.(md|markdown|mdx)$/i.test(__ccaaIn.uri.fsPath||"")){__ccaaPush(__ccaaIn.uri.fsPath);return}if(__ccaaIn&&${vscodeNs}.TabInputWebview&&__ccaaIn instanceof ${vscodeNs}.TabInputWebview&&/markdown\.preview/.test(__ccaaVt||"")){var __ccaaLabel=__ccaaTab.label||"";var __ccaaLast=globalThis.__ccaaLastMd;if(__ccaaLast&&__ccaaLabel.endsWith(__ccaaBaseOf(__ccaaLast))){__ccaaPush(__ccaaLast);return}var __ccaaDocs=(${vscodeNs}.workspace.textDocuments||[]).filter(function(__d){return __d.languageId==="markdown"&&__ccaaLabel.endsWith(__ccaaBaseOf(__d.uri.fsPath))});if(__ccaaDocs.length===1){__ccaaPush(__ccaaDocs[0].uri.fsPath);return}var __ccaaBase=__ccaaLabel.replace(/^\[?[^\]\s]*\]?\s+/,"");if(/\.(md|markdown|mdx)$/i.test(__ccaaBase)&&!/[*?{}\[\]]/.test(__ccaaBase)){var __ccaaG=${staleGuard}.bump();${vscodeNs}.workspace.findFiles("**/"+__ccaaBase,"**/node_modules/**",2).then(function(__h){if(__h&&__h.length===1&&!${staleGuard}.isStale(__ccaaG)&&!(${contextVar}&&${contextVar}.filePath===__h[0].fsPath)){${contextVar}={filePath:__h[0].fsPath,startLine:1,endLine:1};${emitter}.fire(${contextVar});__ccaaLog("pushAsync "+__h[0].fsPath)}},function(){});return}}`;

  const resolver = `/*__ccaaMdPreview2*/try{` + resolverBody + `}catch(__ccaaMd1){}/*__ccaaMdPreview2End*/`;

  // Pushed as an extra disposable in front of the active-editor subscription, so it is
  // registered at activation and disposed with the extension. onDidChangeTabs fires when a
  // tab opens or its isActive flips; onDidChangeTabGroups covers group-level changes such
  // as the active split. Always returns a disposable (a no-op one on failure) so the
  // subscriptions array stays valid whatever happens here.
  const tabListener =
    `/*__ccaaMdPreview3*/(function(){` +
    `var __ccaaNoop={dispose:function(){}};try{` +
    `if(globalThis.__ccaaTabSub)return __ccaaNoop;globalThis.__ccaaTabSub=1;` +
    `var __ccaaResolve=function(){try{` + resolverBody + `}catch(__ccaaMd2){}};` +
    `var __ccaaOnTab=function(){__ccaaResolve();setTimeout(__ccaaResolve,0)};` +
    `var __ccaaSubs=[${vscodeNs}.window.tabGroups.onDidChangeTabs(__ccaaOnTab),` +
    `${vscodeNs}.window.tabGroups.onDidChangeTabGroups(__ccaaOnTab)];` +
    `setTimeout(__ccaaResolve,0);` +
    `return{dispose:function(){globalThis.__ccaaTabSub=0;__ccaaSubs.forEach(function(__s){try{__s.dispose()}catch(__ccaaMd4){}})}}` +
    `}catch(__ccaaMd3){return __ccaaNoop}})(),/*__ccaaMdPreview3End*/`;

  const replacement =
    `${disposables}.push(` + tabListener +
    `${vscodeNs}.window.onDidChangeActiveTextEditor(async(${editorVar})=>{` + tracker +
    `if(!${editorVar}){` + resolver +
    `if(${retainFn}(${vscodeNs}.window.visibleTextEditors.length)==="retain")return;` +
    `${staleGuard}.bump(),${clearBody}${emitter}.fire(void 0);return}`;

  return { ok: true, content: content.replace(whole, () => replacement) };
}

// --- per-file compute/revert ---

// Apply the sub-patches one by one. Each result is parsed before it is kept: an anchor can
// still match after the code around it changed shape, and one such injection must only
// cost its own feature, not the whole bundle (the file-level check in applyPatch is the
// last resort). The check is skipped when the input itself does not parse as a script.
function runSubPatches(content, subPatches) {
  const warnings = [];
  let next = content;
  let appliedCount = 0;
  const checkSyntax = !compileError(content);

  for (const sub of subPatches) {
    const result = sub.inject(next);
    if (!result.ok) {
      warnings.push(`${sub.name}: ${result.reason}`);
      continue;
    }
    const syntaxError = checkSyntax ? compileError(result.content) : null;
    if (syntaxError) {
      warnings.push(`${sub.name}: produces unparsable code, skipped (${syntaxError})`);
      continue;
    }
    next = result.content;
    appliedCount += 1;
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
  const contextOnByDefault = !detachContextByDefault;
  subPatches.push(
    { name: 'model-badge-and-shortcut', inject: (c) => injectModelUi(c, { contextOnByDefault }) },
    { name: 'context-send-flag', inject: (c) => injectContextSendFlag(c, { contextOnByDefault }) },
    { name: 'chip-click-toggle', inject: injectChipClickToggle },
    { name: 'send-model-buttons', inject: injectSendModelButtons },
    { name: 'hide-rate-limit-warning', inject: injectHideRateLimitWarning },
    { name: 'uri-open-listener', inject: injectUriOpenListener },
    { name: 'session-mount-focus', inject: injectSessionMountFocus },
    { name: 'question-keeps-focus', inject: injectAskQuestionFocus },
    { name: 'question-notes-input', inject: injectAskQuestionNotes },
    { name: 'question-no-auto-advance', inject: injectNoQuestionAutoAdvance }
  );
  return runSubPatches(content, subPatches);
}

function revertWebviewPatch(content) {
  const stripped = stripMarker(content);
  if (stripped === null) return { reverted: false, reason: 'not patched' };

  let next = revertLegacySelectionPatches(stripped);
  next = revertContextSendFlag(next);
  next = revertHideRateLimitWarning(next);
  next = revertSessionMountFocus(next);
  next = revertAskQuestionFocus(next);
  next = revertAskQuestionNotes(next);
  next = revertQuestionAutoAdvance(next);
  next = next.replace(CHIP_CLICK_SENTINEL_RE, '');
  next = next.replace(MODEL_UI_SENTINEL_RE, '');
  next = next.replace(SEND_MODEL_BUTTONS_SENTINEL_RE, '');
  next = next.replace(URI_OPEN_WV_SENTINEL_RE, '');
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
    // 2.1.270 turned the selection toggle into a dismissible chip (a span, not a button).
    // The chip now always shows the current file; whether that file is actually sent is the
    // Ctrl+F flag, which the model-UI patch mirrors onto <body>. Colour the chip orange when
    // context is on and dim it when off, so the state is visible again. Without that patch
    // no marker is set and the chip keeps its stock appearance.
    `body[data-ccaa-context="on"] [title^="Showing Claude your current file selection"]{color:#d97757}` +
    `body[data-ccaa-context="off"] [title^="Showing Claude your current file selection"]{opacity:.45}` +
    // Hide the permission-mode pill. The composer footer got crowded (agent map, cache
    // window, selection chip, model pill) and the mode is still reachable with Shift+Tab,
    // which the pill's own tooltip is the only stable way to recognise it by. The wrapper
    // goes too, so the footer's flex gap does not leave a hole; both rules are no-ops if
    // the markup or the tooltip text changes.
    `[title*="Shift+Tab to cycle"]{display:none!important}` +
    `div:has(>[title*="Shift+Tab to cycle"]){display:none!important}` +
    // Trim the send buttons (upstream's, plus the three model buttons injected next to it)
    // from 26px to 22px — same reason, the row has to fit more than it used to.
    `[class*="sendButton_"]{width:22px!important;height:22px!important}` +
    // Keep the model picker on the composer footer row. The footer measures its
    // children and, once they no longer fit, moves the model pill to a row of its
    // own. Upstream caps the file-selection label at 200px, which — with the extra
    // send buttons this extension injects — is enough to overflow a narrow panel on
    // a long file name. A viewport-relative cap makes the label give way first: the
    // name is elided (the full path stays in the button tooltip) instead of the
    // whole picker wrapping. Pure CSS, so it is a no-op if the footer changes.
    `[class*="footerButton_"]>span{max-width:min(200px,14vw)}` +
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
    { name: 'uri-open-in-editor', inject: injectUriOpenInEditor },
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
  next = next.replace(URI_OPEN_EXT_SENTINEL_RE, '');
  return { reverted: true, content: next };
}

const PATCH_SITES = [
  {
    relativePath: ['webview', 'index.js'],
    description:
      'context detached by default + per-session model badge + Ctrl+M model cycle + Ctrl+F context toggle + hide rate-limit warnings + uri-open panel listener + questions keep your focus',
    compute: computeWebviewPatch,
    revert: revertWebviewPatch,
    syntaxCheck: true,
  },
  {
    relativePath: ['webview', 'index.css'],
    description: 'cap user prompt bubble height + make it scrollable + keep the model picker on the footer row',
    compute: computePromptHeightPatch,
    revert: revertPromptHeightPatch,
  },
  {
    relativePath: ['extension.js'],
    description: 'auto-allow gitignored Write/Edit prompts (bypass mode only) + capture permission mode + session-scoped model + session-scoped effort switch + uri /open in the Claude editor group',
    compute: computeExtensionPatch,
    revert: revertExtensionPatch,
    syntaxCheck: true,
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

// Hash of each target file as it stood the first time this window looked at it — i.e.
// what the Claude Code extension host running in this window actually loaded. Patches
// written afterwards (by another window, or by a new build of this extension) change
// the file but not the running code, so any divergence from this snapshot means the
// window is running stale Claude Code code and must be reloaded.
const loadedBundleHashes = new Map();
let reloadPromptShown = false;

function hashContent(content) {
  return crypto.createHash('sha1').update(content).digest('hex');
}

// Parse (without running) a script bundle; returns the error message, or null when it
// compiles. Both Claude Code bundles are classic scripts, so vm.Script is the right parser.
function compileError(content) {
  try {
    new vm.Script(content);
    return null;
  } catch (e) {
    return e.message;
  }
}

async function promptReload(message) {
  if (reloadPromptShown) return;
  reloadPromptShown = true;
  const action = await vscode.window.showInformationMessage(message, 'Reload Window', 'Later');
  if (action === 'Reload Window') {
    vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
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
  let anyStale = false;
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

      if (!loadedBundleHashes.has(filePath)) {
        loadedBundleHashes.set(filePath, hashContent(content));
      }
      const loadedHash = loadedBundleHashes.get(filePath);
      const markStale = (finalContent) => {
        if (hashContent(finalContent) !== loadedHash) anyStale = true;
      };

      const reverted = site.revert(content);
      const baseContent = reverted.reverted ? reverted.content : content;

      const result = site.compute(baseContent, computeOptions);
      if (!result.patched) {
        channel.appendLine(`[no-auto-attach] Skipped ${relLabel} (${result.reason}).`);
        skipMessages.push(`${relLabel}: ${result.reason}`);
        markStale(content);
        continue;
      }

      for (const warning of result.warnings || []) {
        channel.appendLine(`[no-auto-attach] Partial patch ${relLabel}: ${warning}.`);
        skipMessages.push(`${relLabel}: ${warning}`);
      }

      if (result.content === content) {
        channel.appendLine(`[no-auto-attach] Skipped ${relLabel} (already at current version).`);
        markStale(content);
        continue;
      }

      // A textually successful injection can still leave the bundle unparsable when the
      // code around an anchor changed shape (2.1.261 turned a statement into an `if`
      // operand). Never write such a file: an unparsable bundle takes the whole Claude
      // Code UI down. Fall back to the clean upstream code instead, so the editor keeps
      // working with the patches simply missing.
      let output = result.content;
      const syntaxError = site.syntaxCheck ? compileError(output) : null;
      if (syntaxError && !compileError(baseContent)) {
        channel.appendLine(`[no-auto-attach] Patched ${relLabel} does not parse (${syntaxError}); writing the unpatched bundle instead.`);
        skipMessages.push(`${relLabel}: patched bundle does not parse (${syntaxError})`);
        vscode.window.showErrorMessage(`Claude Code patch for ${relLabel} produced invalid code and was not applied: ${syntaxError}`);
        if (baseContent === content) {
          markStale(content);
          continue;
        }
        output = baseContent;
      }

      try {
        fs.writeFileSync(filePath, output, 'utf8');
      } catch (e) {
        channel.appendLine(`[no-auto-attach] Failed to write ${filePath}: ${e.message}`);
        vscode.window.showErrorMessage(`Failed to patch ${relLabel}: ${e.message}`);
        continue;
      }

      if (output === baseContent) {
        channel.appendLine(`[no-auto-attach] Restored unpatched ${filePath}.`);
      } else {
        channel.appendLine(`[no-auto-attach] Patched ${filePath} (${site.description}).`);
      }
      anyApplied = true;
      markStale(output);
    }
  }

  if (anyApplied) {
    // A fresh write is worth re-asking about even if an earlier prompt was dismissed.
    reloadPromptShown = false;
    await promptReload('Claude Code patches applied. Reload window to take effect.');
  } else if (anyStale) {
    // Someone else (another window, or a new build of this extension) rewrote the bundle
    // after this window's Claude Code extension host loaded it.
    channel.appendLine('[no-auto-attach] Patched files changed since this window loaded them.');
    await promptReload('Claude Code patches changed on disk. Reload window to run them.');
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
