// What each sub-patch must *mean* once it lands.
//
// scripts/check.js already proves that an anchor matched exactly once, that the patched
// bundle parses, and that reverting restores the clean one byte-for-byte. None of that
// says the injection does the right thing: a patch that defaulted the context off by
// suppressing the session's applySelectionUpdate passed all three, and silently removed
// the composer's file chip. These assertions are the missing half — they are written
// against README.md's "How it works" bullets, deliberately not against extension.js's
// own regexes, so a patch and its spec have to agree.
//
// Each entry is { name, rel, applies?(clean, ctx), check(patched, clean, ctx) } and
// returns null to pass or a message to fail. `ctx` carries { version, semver, rel,
// compute } — `applies` is how an assertion opts out on an older bundle that legitimately
// predates the upstream affordance it is about.
//
// Anchors here follow the same rule as extension.js: `[\w$]+`, never `\w+`, because the
// minifier uses a bare `$` as a variable name. Any replace() whose replacement embeds a
// captured name must use the function form.

// --- small helpers ---

const need = (content, parts) => {
  const missing = parts.filter(([, needle]) => !content.includes(needle)).map(([label]) => label);
  return missing.length ? `missing ${missing.join(', ')}` : null;
};

// Pull out a /*__ccaaX*/ … /*__ccaaXEnd*/ block by its sentinel name.
const block = (content, name) => {
  const start = content.indexOf(`/*__ccaa${name}*/`);
  const end = content.indexOf(`/*__ccaa${name}End*/`);
  return start === -1 || end === -1 || end < start ? null : content.slice(start, end);
};

// Every `needle` occurrence with its surrounding bytes, sorted — two bundles whose windows
// compare equal contain that code verbatim, wherever other patches shifted it to.
const windows = (content, needle, before, after) => {
  const out = [];
  for (let i = content.indexOf(needle); i !== -1; i = content.indexOf(needle, i + 1)) {
    out.push(content.slice(Math.max(0, i - before), i + after));
  }
  return out.sort();
};

const sameWindows = (a, b) => a.length === b.length && a.every((w, i) => w === b[i]);

const atLeast = (semver, min) =>
  semver[0] !== min[0] ? semver[0] > min[0] : semver[1] !== min[1] ? semver[1] > min[1] : semver[2] >= min[2];

// The appended VSCode system prompt as the model actually receives it: every
// /*__ccaaPromptEdit*/(0?`original`:`replacement`) splice collapsed to its live branch,
// then the `# VSCode Extension Context` template literal read to its closing backtick
// (the one that is not escaped — the prompt itself mentions a `\`` in its own text).
const appendedPrompt = (content) => {
  const live = content.replace(
    /`\+\/\*__ccaaPromptEdit\*\/\(0\?`[\s\S]*?`:`([\s\S]*?)`\)\+\/\*__ccaaPromptEditEnd\*\/`/g,
    (_, replacement) => replacement
  );
  const start = live.indexOf('# VSCode Extension Context');
  if (start === -1) return null;
  for (let i = start; i < live.length; i += 1) {
    if (live[i] === '`' && live[i - 1] !== '\\') return live.slice(start, i);
  }
  return null;
};

// --- webview/index.js ---

const WEBVIEW = [
  {
    // The send-time flag, and the guard for the bug that shipped green: holding the
    // selection back at the session instead removes the composer's file chip.
    name: 'context-send-flag',
    rel: 'webview/index.js',
    check(patched, clean, ctx) {
      const gate = /\(globalThis\.__ccaaContextOn\?\?!1\)\/\*__ccaaSlashSel:(?:[\w$]+&&)?![\w$]+\*\/;[\w$]+\([\w$]+\.selection\.value,/;
      if (!gate.test(patched)) {
        return 'the include-selection flag is not `(globalThis.__ccaaContextOn??!1)` feeding the `.selection.value,` call';
      }
      // The same edit with the setting off has to default the other way, or turning
      // detachContextByDefault off would silently keep detaching.
      const attached = ctx.compute(clean, { detachContextByDefault: false });
      if (!attached.patched) return `re-patching with detachContextByDefault off fails (${attached.reason})`;
      if (!/\(globalThis\.__ccaaContextOn\?\?!0\)\/\*__ccaaSlashSel:/.test(attached.content)) {
        return 'with detachContextByDefault off the flag does not fall back to `??!0`';
      }
      // The chip renders off `selection.value`, which applySelectionUpdate is the only
      // writer of. Touching it is what made the chip disappear, so it must stay verbatim.
      const before = windows(clean, 'applySelectionUpdate', 80, 320);
      if (!before.length) return 'no applySelectionUpdate in the clean bundle to compare against';
      if (!sameWindows(before, windows(patched, 'applySelectionUpdate', 80, 320))) {
        return 'applySelectionUpdate is not byte-identical to clean (the composer file chip renders off selection.value)';
      }
      return null;
    },
  },
  {
    name: 'context-toggle-key',
    rel: 'webview/index.js',
    check: (patched) =>
      need(patched, [
        ['the __ccaaToggleContext global', 'globalThis.__ccaaToggleContext='],
        ['the Ctrl+F binding', '__ccaaE.key==="f"||__ccaaE.key==="F"'],
        ['the body marker the CSS chip rules key off', 'document.body.dataset.ccaaContext'],
      ]),
  },
  {
    // Clicking the chip must flip the same global Ctrl+F flips, on the chip itself and not
    // on the X — whose dismiss stays upstream's.
    name: 'chip-click-toggle',
    rel: 'webview/index.js',
    applies: (clean) => clean.includes('footerButtonStatic'),
    check(patched, clean) {
      const injected = block(patched, 'ChipClick');
      if (!injected) return 'no /*__ccaaChipClick*/ block';
      if (!/onClick:\(\)=>globalThis\.__ccaaToggleContext\?\.\(\)/.test(injected)) {
        return 'the chip click does not call globalThis.__ccaaToggleContext';
      }
      if (!/onMouseDown:\([\w$]+\)=>[\w$]+\.preventDefault\(\)/.test(injected)) {
        return 'the chip click does not cancel mousedown (it would blur the composer)';
      }
      if (!/\/\*__ccaaChipClickEnd\*\/title:`Showing Claude your current file selection/.test(patched)) {
        return 'the click handler does not sit on the file chip itself';
      }
      // The X is upstream's dismiss, untouched — the toggle rides on the label only.
      const before = windows(clean, 'Remove from message', 80, 40);
      if (!before.length) return 'no chip dismiss button in the clean bundle to compare against';
      if (!sameWindows(before, windows(patched, 'Remove from message', 80, 40))) {
        return "the chip's dismiss button is not byte-identical to clean";
      }
      return null;
    },
  },
  {
    name: 'model-badge-and-shortcut',
    rel: 'webview/index.js',
    check: (patched) =>
      need(patched, [
        ['the badge element', 'ccaa-model-badge-main'],
        ['the Ctrl+M binding', '__ccaaE.key==="m"||__ccaaE.key==="M"'],
        ['the Ctrl+0 binding', '__ccaaE.key==="0"'],
        ['the Ctrl+1 binding', '__ccaaE.key==="1"'],
        ['the Ctrl+2 binding', '__ccaaE.key==="2"'],
        ['the Ctrl+3 binding', '__ccaaE.key==="3"'],
        ['__ccaaNeedsSwitch', 'globalThis.__ccaaNeedsSwitch='],
        ['__ccaaEffortFor', 'globalThis.__ccaaEffortFor='],
        ['__ccaaApplyEffort', 'globalThis.__ccaaApplyEffort='],
      ]),
  },
  {
    name: 'send-model-buttons',
    rel: 'webview/index.js',
    check(patched) {
      const injected = block(patched, 'SendBtns');
      if (!injected) return 'no /*__ccaaSendBtns*/ block';
      const count = (injected.match(/type:"button"/g) || []).length;
      if (count !== 3) return `expected 3 injected send buttons, found ${count}`;
      const missing = [
        ['Sonnet', '/sonnet/i', '#bc8e26'],
        ['Haiku', '/haiku/i', '#269473'],
        ['Fable', '/fable/i', '#8052d2'],
      ]
        .filter(([, modelRe, color]) => !injected.includes(modelRe) || !injected.includes(color))
        .map(([label]) => label);
      return missing.length ? `send buttons missing their model regex or colour: ${missing.join(', ')}` : null;
    },
  },
  {
    name: 'hide-rate-limit-warning',
    rel: 'webview/index.js',
    check: (patched) =>
      /\/\*__ccaaRateLimit\*\/[\w$]+\.status==="rejected"\?/.test(patched)
        ? null
        : 'the banner construction is not gated on `status==="rejected"`',
  },
  {
    // The injection has to sit inside the argument list. 2.1.270 wrapped the call in an
    // assignment inside an `if(…)`, where a leading comma parses fine but steals the value.
    name: 'uri-open-listener',
    rel: 'webview/index.js',
    check(patched) {
      if (!patched.includes('listSessions("panel_boot"/*__ccaaUriOpenWv*/,')) {
        return 'the listener is not injected as an extra argument of listSessions("panel_boot")';
      }
      const stray = patched.match(/[;,{}]\/\*__ccaaUriOpenWv\*\//);
      return stray ? `the listener is injected as a statement or comma prefix (${stray[0]})` : null;
    },
  },
  {
    name: 'session-mount-focus',
    rel: 'webview/index.js',
    check(patched) {
      const match = patched.match(/\/\*__ccaaMountFocus:([^*]*)\*\/([\w$]+\.current\?\.focus\(\))/);
      if (!match) return 'the gated focus wrapper is not replaced by the bare `.focus()` call';
      return match[1].includes('ambientFocusAllowed()')
        ? null
        : 'the parked original is not the ambientFocusAllowed() wrapper';
    },
  },
  {
    name: 'question-keeps-focus',
    rel: 'webview/index.js',
    check: (patched) =>
      /\/\*__ccaaAskFocus\*\/document\.hasFocus\(\)&&[\w$]+\.querySelector\('\[role="radio"\], \[role="checkbox"\]'\)\?\.focus\(\)/.test(
        patched
      )
        ? null
        : 'the question-option auto-focus is not prefixed with `document.hasFocus()&&`',
  },
  {
    // Both edits or neither: a notes box that never reaches the model is worse than none.
    name: 'question-notes-input',
    rel: 'webview/index.js',
    check(patched) {
      const hasBox = patched.includes('/*__ccaaAskNotes*/');
      const hasData = patched.includes('/*__ccaaAskNotesOut*/');
      if (hasBox !== hasData) {
        return hasBox
          ? 'the notes box is injected but the answers effect does not report its text'
          : 'the answers effect reports notes but the notes box is not injected';
      }
      if (!hasBox) return 'neither the notes box nor the answers edit is present';
      const out = block(patched, 'AskNotesOut');
      return need(out, [
        ['the annotations payload', '.annotations'],
        ['the notes field', '{notes:'],
        ['the "(notes only)" answer sentinel', '"(notes only)"'],
      ]);
    },
  },
  {
    name: 'question-no-auto-advance',
    rel: 'webview/index.js',
    check(patched) {
      const parked = patched.match(/\/\*__ccaaNoAdvance:([^*]*)\*\//);
      if (!parked) return 'the auto-advance clause is not parked in a /*__ccaaNoAdvance:…*/ sentinel';
      if (!parked[1].includes(',300)')) return 'the parked clause is not the 300ms setTimeout advance';
      const live = patched.replace(/\/\*__ccaaNoAdvance:[^*]*\*\//g, '');
      return /else if\([\w$]+===null&&[\w$]+\.questions&&[\w$]+<[\w$]+\.questions\.length-1\)/.test(live)
        ? 'a live auto-advance clause survives outside the sentinel'
        : null;
    },
  },
  {
    // Upstream drift canary: the affordances the patches above anchor on. When Anthropic
    // renames or removes one, this fails loudly instead of a patch becoming a quiet no-op.
    name: 'upstream-affordances',
    rel: 'webview/index.js',
    check: (_patched, clean) =>
      need(clean, [
        ['the file-chip title', 'Showing Claude your current file selection'],
        ['the composer send button', 'type:"submit"'],
        ['the permission-mode pill tooltip', 'Shift+Tab to cycle'],
        ['the model picker action', 'Switch model…'],
        ['the panel bootstrap', 'listSessions("panel_boot")'],
        ['the session selection writer', 'applySelectionUpdate'],
      ]),
  },
  {
    // The dismiss memory the Ctrl+F toggle clears before re-publishing a selection. It
    // arrived with the 2.1.269 chip; older bundles have no such memory to clear.
    name: 'upstream-affordances-chip',
    rel: 'webview/index.js',
    applies: (_clean, ctx) => atLeast(ctx.semver, [2, 1, 269]),
    check: (_patched, clean) =>
      need(clean, [
        ['the chip dismiss memory', 'dismissedSelection'],
        ['the static chip class', 'footerButtonStatic'],
        ['the chip dismiss button', 'Remove from message'],
      ]),
  },
];

// --- webview/index.css ---

const CSS = [
  {
    name: 'css-rules',
    rel: 'webview/index.css',
    check: (patched) =>
      need(patched, [
        ['the prompt-bubble cap', '[class*="userMessage_"]{max-height:40vh'],
        ['the chip "context on" rule', 'body[data-ccaa-context="on"] [title^="Showing Claude your current file selection"]'],
        ['the chip "context off" rule', 'body[data-ccaa-context="off"] [title^="Showing Claude your current file selection"]'],
        ['the permission-mode pill hide rule', '[title*="Shift+Tab to cycle"]{display:none!important}'],
        ['the send-button size rule', '[class*="sendButton_"]{width:22px'],
        ['the footer-label max-width', '[class*="footerButton_"]>span{max-width:min(200px,14vw)}'],
      ]),
  },
  {
    name: 'upstream-affordances',
    rel: 'webview/index.css',
    check: (_patched, clean) =>
      need(clean, [
        ['the prompt bubble class', 'userMessage_'],
        ['the send button class', 'sendButton_'],
        ['the footer button class', 'footerButton_'],
      ]),
  },
];

// --- extension.js (host) ---

const EXTENSION = [
  {
    name: 'auto-approve-guard',
    rel: 'extension.js',
    check(patched) {
      if (
        !/subtype==="can_use_tool"\)\{if\(!this\.canUseTool\)throw Error\("canUseTool callback is not provided\."\);try\{var __ccaaCfg=/.test(
          patched
        )
      ) {
        return 'the early return is not injected at the head of the can_use_tool branch';
      }
      return need(patched, [
        ['the setting read', 'autoApproveProtectedPathWrites'],
        ['the allow decision', 'behavior:"allow"'],
      ]);
    },
  },
  {
    name: 'permission-mode-capture',
    rel: 'extension.js',
    check: (patched) =>
      /setPermissionMode\(([\w$]+)\)\{globalThis\.__ccaaPermissionMode=\1;/.test(patched)
        ? null
        : 'setPermissionMode does not capture its mode into globalThis.__ccaaPermissionMode',
  },
  {
    // 2.1.270 put a malformed-request guard in front of the write; the early return has to
    // land after it, and still ahead of the settings write it replaces.
    name: 'session-scoped-model',
    rel: 'extension.js',
    check(patched, clean) {
      const start = patched.indexOf('/*__ccaaSessionModel*/');
      const end = patched.indexOf('/*__ccaaSessionModelEnd*/');
      if (start === -1 || end === -1) return 'no /*__ccaaSessionModel*/ block';
      const block = patched.slice(start, end);
      if (!block.includes('query.setModel(')) {
        return 'the block does not route the switch through the session-scoped query.setModel';
      }
      // The applied-settings read-back must never hold the response open for longer than its
      // timeout: the quick-send shortcuts submit only once the switch resolves.
      if (block.includes('query.getSettings(') && !/Promise\.race\(\[[^\]]*setTimeout/.test(block)) {
        return 'the getSettings read-back is awaited without a timeout, so a slow CLI delays every switch';
      }
      const guard = 'set_model: malformed request';
      if (clean.includes(guard) && start < patched.indexOf(guard)) {
        return 'the block sits before the `set_model: malformed request` guard';
      }
      const write = patched.slice(end).search(/this\.writeUserSettingsAndPush\([\w$]+,\{model:/);
      return write === -1 ? 'the writeUserSettingsAndPush({model:…}) it guards no longer follows the block' : null;
    },
  },
  {
    // 2.1.270 derives the target settings layer from the flags argument and throws on a
    // mismatch. effortLevel is declared `userSettings`, so flipping the flag before that
    // loop makes every effort change throw — silently, at runtime.
    name: 'session-scoped-effort',
    rel: 'extension.js',
    check(patched, clean) {
      const start = patched.indexOf('/*__ccaaSessionEffort*/');
      const end = patched.indexOf('/*__ccaaSessionEffortEnd*/');
      if (start === -1 || end === -1) return 'no /*__ccaaSessionEffort*/ block';
      if (!patched.slice(start, end).includes('"effortLevel"')) {
        return 'the block does not test for an effort-only settings object';
      }
      const validation = 'apply_settings: unexpected value or target';
      if (clean.includes(validation) && start < patched.indexOf(validation)) {
        return 'the flag flip sits before the layer-validation loop, which makes every effort change throw';
      }
      return /^\/\*__ccaaSessionEffortEnd\*\/(?:return |if\()await this\.writeUserSettingsAndPush\(/.test(
        patched.slice(end)
      )
        ? null
        : 'the flag flip is not immediately followed by the writeUserSettingsAndPush it applies to';
    },
  },
  {
    name: 'uri-open-in-editor',
    rel: 'extension.js',
    check(patched) {
      const injected = block(patched, 'UriOpenExt');
      if (!injected) return 'no /*__ccaaUriOpenExt*/ block';
      const problem = need(injected, [
        ['the editor.open command', '"claude-vscode.editor.open"'],
        ['the resolved Claude group column', '__ccaaUriCol'],
        ['the ccaa-open message', '"ccaa-open"'],
      ]);
      if (problem) return problem;
      const tail = patched.slice(patched.indexOf('/*__ccaaUriOpenExtEnd*/'));
      return /^\/\*__ccaaUriOpenExtEnd\*\/[\w$]+\.commands\.executeCommand\("claude-vscode\.primaryEditor\.open"/.test(tail)
        ? null
        : 'the original primaryEditor.open call is not kept as the fallback right after the block';
    },
  },
  {
    // All three insertions, in order: the tab listeners are registered eagerly (before the
    // active-editor subscription), then the last-active-editor tracker and the resolver
    // inside the handler. Registering the listeners from inside the handler left the
    // feature dead in a window that never visits a text editor.
    name: 'markdown-preview-context',
    rel: 'extension.js',
    check(patched) {
      const at = {
        listeners: patched.indexOf('/*__ccaaMdPreview3*/'),
        handler: patched.indexOf('onDidChangeActiveTextEditor('),
        tracker: patched.indexOf('/*__ccaaMdPreview*/'),
        resolver: patched.indexOf('/*__ccaaMdPreview2*/'),
      };
      const missing = Object.entries(at)
        .filter(([, index]) => index === -1)
        .map(([label]) => label);
      if (missing.length) return `missing markdown-preview insertions: ${missing.join(', ')}`;
      if (!(at.listeners < at.handler)) return 'the tab listeners are not registered eagerly, ahead of the active-editor subscription';
      if (!(at.handler < at.tracker && at.tracker < at.resolver)) {
        return 'the last-active-editor tracker and the resolver are not both inside the active-editor handler, in that order';
      }
      return patched.includes('onDidChangeTabs(') && patched.includes('onDidChangeTabGroups(')
        ? null
        : 'the tab listeners do not subscribe to both onDidChangeTabs and onDidChangeTabGroups';
    },
  },
  {
    // The prompt the model receives must ask for absolute links and keep the three
    // sections that earn their place — clickable paths, the IDE selection, and the Focus
    // view rules, which override the terminal Focus-mode ones that also reach the prompt.
    name: 'system-prompt-trim',
    rel: 'extension.js',
    check(patched) {
      const prompt = appendedPrompt(patched);
      if (prompt === null) return 'the appended VSCode prompt literal is not readable after patching';
      if (prompt.includes('relative paths from the root of')) {
        return 'the prompt still asks for links relative to the workspace root';
      }
      return need(prompt, [
        ['the absolute-path rule', 'The URL links should be absolute paths'],
        ['the code-reference section', '## Code References in Text'],
        ['the IDE selection section', '## User Selection Context'],
        ['the Focus view section', '## Focus view in this editor'],
      ]);
    },
  },
  {
    // The audience preamble is what makes ordinary replies open with "Written for: …".
    // It arrived in 2.1.270; older bundles have nothing to drop.
    name: 'system-prompt-trim-audience',
    rel: 'extension.js',
    applies: (clean) => clean.includes('## Who you are writing for'),
    check(patched) {
      const prompt = appendedPrompt(patched);
      if (prompt === null) return 'the appended VSCode prompt literal is not readable after patching';
      if (prompt.includes('## Who you are writing for')) return 'the audience section is still in the prompt';
      return prompt.includes('Written for:') ? 'the "Written for: …" instruction survives the trim' : null;
    },
  },
  {
    // Upstream drift canary for the section the trim above removes: a rename would make
    // that edit a silent no-op, since the other edit alone still counts as applied.
    name: 'upstream-affordances-prompt',
    rel: 'extension.js',
    applies: (_clean, ctx) => atLeast(ctx.semver, [2, 1, 270]),
    check: (_patched, clean) =>
      need(clean, [
        ['the audience section', '\n\n## Who you are writing for\n'],
        ['the audience "Written for" line', 'Written for:'],
      ]),
  },
  {
    name: 'upstream-affordances',
    rel: 'extension.js',
    check: (_patched, clean) =>
      need(clean, [
        ['the tool-permission request', 'can_use_tool'],
        ['the permission-mode setter', 'setPermissionMode'],
        ['the settings write', 'writeUserSettingsAndPush'],
        ['the uri /open fallback', 'primaryEditor.open'],
        ['the editor-open command', 'claude-vscode.editor.open'],
        ['the active-editor subscription', 'onDidChangeActiveTextEditor'],
        ['the appended VSCode prompt', '# VSCode Extension Context'],
        ['the workspace-relative link rule', 'The URL links should be relative paths'],
      ]),
  },
];

module.exports = { assertions: [...WEBVIEW, ...CSS, ...EXTENSION] };
