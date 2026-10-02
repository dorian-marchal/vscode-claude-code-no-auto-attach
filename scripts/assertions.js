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

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const pkg = require('../package.json');

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
    // Ctrl+M and a badge click apply the next slot; Ctrl+digit applies the slot bound to that
    // digit and sends. The badge takes the color of the slot the session is on.
    name: 'model-badge-and-shortcut',
    rel: 'webview/index.js',
    check(patched) {
      const injected = block(patched, 'ModelUi');
      if (!injected) return 'no /*__ccaaModelUi*/ block';
      return need(injected, [
        ['the badge element', 'ccaa-model-badge-main'],
        ['the badge click applying the next slot', '__ccaaBadge.onclick=()=>globalThis.__ccaaCycleSlot?globalThis.__ccaaCycleSlot('],
        ['the badge color from the current slot', '__ccaaColor=__ccaaSlotNow?__ccaaSlotNow.color:'],
        ['the Ctrl+M binding', '__ccaaE.key==="m"||__ccaaE.key==="M"'],
        ['Ctrl+M applying the next slot', 'globalThis.__ccaaCycleSlot?.(__ccaaSess,'],
        ['the Ctrl+digit lookup by slot key', '__ccaaS.key===__ccaaE.key'],
        ['Ctrl+digit applying the slot and sending', 'globalThis.__ccaaSendWithSlot?.(__ccaaSess,__ccaaKeySlot.id)'],
      ]);
    },
  },
  {
    // Every slot is read from the quickSend.* settings (defaults matching package.json), set
    // with setModel + setEffortLevel, and bound to one of Ctrl+0..3.
    name: 'quick-send-lib',
    rel: 'webview/index.js',
    check(patched) {
      if (!/^\/\*claude-code-no-auto-attach:v[^*]+\*\/\n\/\*__ccaaQuickSendLib\*\//.test(patched)) {
        return 'the slot helpers do not open the bundle, right after the marker';
      }
      const injected = block(patched, 'QuickSendLib');
      const problem = need(injected, [
        ['the settings read from the webview state', '.config?.value?.ccaaQuickSend'],
        ['the model switch', '.setModel(__ccaaT)'],
        ['the effort set', '.setEffortLevel(__ccaaE)'],
        ['the "unchanged" effort', '__ccaaE==="unchanged"'],
        ['the unsupported-level guard', '__ccaaLv.includes(__ccaaE)'],
        ['__ccaaNeedsSwitch', 'globalThis.__ccaaNeedsSwitch='],
        ['the composer submit', '__ccaaForm.requestSubmit()'],
      ]);
      if (problem) return problem;
      const defaults = JSON.parse(injected.match(/var __ccaaDefaults=(\[.*?\]);/)[1]);
      const keys = defaults.map((slot) => slot.key).join('');
      if (keys !== '0123') return `slot shortcuts are Ctrl+${keys.split('').join('/')}, expected Ctrl+0/1/2/3`;
      const settings = pkg.contributes.configuration.properties;
      for (const slot of defaults) {
        for (const field of ['model', 'effort']) {
          const setting = settings[`claude-code-no-auto-attach.quickSend.${slot.id}.${field}`];
          if (!setting) return `no quickSend.${slot.id}.${field} setting in package.json`;
          if (setting.default !== slot[field]) {
            return `quickSend.${slot.id}.${field} defaults to ${setting.default} in package.json but ${slot[field]} in the patch`;
          }
          if (!setting.enum.includes(slot[field])) return `quickSend.${slot.id}.${field} default is not in its enum`;
        }
      }
      return null;
    },
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
        ['yellow', '#bc8e26'],
        ['teal', '#269473'],
        ['purple', '#8052d2'],
      ]
        .filter(([id, color]) => !injected.includes(`"data-ccaa-slot":"${id}"`) || !injected.includes(color))
        .map(([id]) => id);
      if (missing.length) return `send buttons missing their slot or colour: ${missing.join(', ')}`;
      return need(injected, [
        ['the slot applied on click', 'globalThis.__ccaaApplySlot('],
        ['the slot effort in the tooltip', 'globalThis.__ccaaSlotEffort('],
      ]);
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
    // All edits or none: a notes box that never reaches the model is worse than none.
    name: 'question-notes-input',
    rel: 'webview/index.js',
    check(patched) {
      const edits = {
        'the notes box': patched.includes('/*__ccaaAskNotes*/'),
        'the answers effect edit': patched.includes('/*__ccaaAskNotesOut*/'),
        'the replayed question edit': patched.includes('/*__ccaaAskNotesReplay*/'),
      };
      const present = Object.keys(edits).filter((edit) => edits[edit]);
      if (present.length === 0) return 'none of the notes edits is present';
      if (present.length < 3) {
        return `only ${present.join(', ')} present: ${Object.keys(edits).filter((edit) => !edits[edit]).join(', ')} missing`;
      }
      const missing = need(block(patched, 'AskNotesOut'), [
        ['the annotations payload', '.annotations'],
        ['the notes field', '{notes:'],
        ['the "(notes only)" answer sentinel', '"(notes only)"'],
        ['the draft save', '__ccaaAskDrafts'],
      ]);
      if (missing) return missing;
      // The replayed answers are read by the function that sends them as a prompt.
      const replay = patched.match(
        /function [\w$]+\(([\w$]+)\)\{\/\*__ccaaAskNotesReplay\*\/\1=[\s\S]*?\/\*__ccaaAskNotesReplayEnd\*\/let [\w$]+=\1\.answers\?\?\{\}/
      );
      if (!replay) return 'the replay edit does not reassign the answers reader input before it reads answers';
      return need(replay[0], [
        ['the annotations read', '.annotations'],
        ['the notes merged into the answer', '" — notes: "'],
        ['the "(notes only)" answer rewrite', '"(no option selected)"'],
      ]);
    },
  },
  {
    // The question dialog unmounts while the composer is busy; picks and notes must come back.
    name: 'question-draft-restore',
    rel: 'webview/index.js',
    check(patched) {
      const selections = block(patched, 'AskDraftSel');
      const texts = block(patched, 'AskDraftText');
      if (!selections || !texts) return 'the picks or the notes state is not seeded from the saved draft';
      if (!/return __ccaaD\.selections;$/.test(selections)) return 'the picks state does not return the saved picks';
      return /\?\.texts\|\|$/.test(texts) ? null : 'the notes state does not fall back to `{}` after the saved text';
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
    // Since 2.1.270 the launch-time read-back skips the effort (`{effort:!1}`); older
    // bundles adopt it on every read, so there is nothing to open up. Since 2.1.284 the
    // read always calls the adopter and the skip moved into its `level:` flag.
    name: 'session-effort-adopt',
    rel: 'webview/index.js',
    applies: (clean) =>
      /if\([\w$]+\.effort!==!1&&this\.effortChangeCount===/.test(clean) ||
      /\{level:[\w$]+\.effort===!1\|\|this\.effortChangeCount!==/.test(clean),
    check(patched) {
      const guard = patched.match(
        /if\(\/\*__ccaaEffortAdopt\*\/([\w$]+)\?\.ccaaEffortRestored===!0&&this\.effortChangeCount===([\w$]+)\|\|\/\*__ccaaEffortAdoptEnd\*\/[\w$]+\.effort!==!1&&this\.effortChangeCount===([\w$]+)\)this\.adoptAppliedEffort\(([\w$]+)\)/
      );
      const skip = patched.match(
        /this\.adoptAppliedEffort\(([\w$]+),\{level:\/\*__ccaaEffortAdopt\*\/([\w$]+)\?\.ccaaEffortRestored===!0&&this\.effortChangeCount===([\w$]+)\?!1:\/\*__ccaaEffortAdoptEnd\*\/[\w$]+\.effort===!1\|\|this\.effortChangeCount!==([\w$]+)[,}]/
      );
      if (!guard && !skip) return 'the read-back does not adopt the effort of an answer tagged ccaaEffortRestored';
      const [tagged, applied, count, upstreamCount] = guard
        ? [guard[1], guard[4], guard[2], guard[3]]
        : [skip[2], skip[1], skip[3], skip[4]];
      if (tagged !== applied) return 'the tag is read off another object than the applied settings it adopts';
      return count === upstreamCount ? null : 'the tagged branch drops the effort change counter guard';
    },
  },
  {
    // A prompt starting with "/" skips the bare box for the normal bubble (message actions,
    // "Show more"), and that bubble shows "/name args" instead of the raw command tags.
    name: 'slash-prompt-bubble',
    rel: 'webview/index.js',
    check(patched) {
      if (!/if\(\/\*__ccaaSlashBubble\*\/!1&&\/\*__ccaaSlashBubbleEnd\*\/[\w$]+\.isSlashCommand\)return /.test(patched)) {
        return 'the bare slash-command box is not disabled';
      }
      if (/[^\w$.]if\([\w$]+\.isSlashCommand\)return /.test(patched)) return 'a live bare slash-command branch survives';
      const wrap = patched.match(
        /\.map\(\(([\w$]+)\)=>\{if\(\1\.content\.type!=="text"\)return \1;let [\w$]+=\/\*__ccaaSlashText\*\/(\(\(__ccaaT\)=>\{[\s\S]*?\}\))\(\/\*__ccaaSlashTextEnd\*\/[\w$]+\(\1\.content\.text,[\w$]+\.origin,[\w$]+\)\/\*__ccaaSlashText\*\/\)\/\*__ccaaSlashTextEnd\*\/;return /
      );
      if (!wrap) return 'the bubble text memo does not pass the expanded text through the command-tag parser';
      const toCommand = new vm.Script(wrap[2]).runInNewContext({});
      const cases = [
        ['<command-message>x</command-message>\n<command-name>/commit</command-name>\n<command-args> fix it </command-args>', '/commit fix it'],
        ['<command-name>/clear</command-name>', '/clear'],
        ['/review typed as is', '/review typed as is'],
        ['a prompt about <command-name>tags</command-name>', 'a prompt about <command-name>tags</command-name>'],
      ];
      for (const [input, expected] of cases) {
        const got = toCommand(input);
        if (got !== expected) return `the command-tag parser turns ${JSON.stringify(input)} into ${JSON.stringify(got)}`;
      }
      return null;
    },
  },
  {
    // The dictation state is handed over *before* the reset helper wipes it, and it is the
    // helper's own argument that is handed over.
    name: 'voice-cleanup-snapshot',
    rel: 'webview/index.js',
    check: (patched) =>
      /function [\w$]+\(([\w$]+)\)\{\/\*__ccaaVoiceSnap\*\/try\{globalThis\.__ccaaVoiceSnapshot\?\.\(\1\)\}catch\([\w$]+\)\{\}\/\*__ccaaVoiceSnapEnd\*\/\1\.gen\+\+,\1\.prefix=null,/.test(
        patched
      )
        ? null
        : 'the dictation reset does not hand its state to __ccaaVoiceSnapshot before wiping it',
  },
  {
    // The cleaned text only lands when the composer still holds the dictated part unchanged
    // and no new recording runs, replaces that part only (typed text around it is kept), and stays undoable when the composer has focus.
    // The message type and the snapshot global are the ones the other halves use.
    name: 'voice-cleanup-lib',
    rel: 'webview/index.js',
    check(patched) {
      const injected = block(patched, 'VoiceLib');
      if (!injected) return 'no /*__ccaaVoiceLib*/ block';
      if (!/^\/\*claude-code-no-auto-attach:v[^*]+\*\/\n\/\*__ccaaQuickSendLib\*\/[\s\S]*?\/\*__ccaaQuickSendLibEnd\*\/\n\/\*__ccaaVoiceLib\*\//.test(patched)) {
        return 'the voice lib does not sit at the top of the bundle, right after the quick-send lib';
      }
      const host = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
      if (!host.includes("type: 'ccaa-voice'")) return 'the host no longer posts "ccaa-voice" messages';
      const problem = need(injected, [
        ['the snapshot global the reset helper calls', 'globalThis.__ccaaVoiceSnapshot='],
        ['the host message type', '__ccaaM.type!=="ccaa-voice"'],
        ['the composer lookup', `'[role="textbox"][aria-label="Message input"]'`],
        ['the no-new-recording guard', 'if(!__ccaaEl||__ccaaVoiceRecording())return;'],
        ['the dictated part found at its place, else as its only copy', '__ccaaAt=__ccaaInPlace?__ccaaP.length:__ccaaCur.indexOf(__ccaaMid);'],
        ['the ambiguous-copy guard', 'if(__ccaaAt<0||!__ccaaInPlace&&__ccaaCur.indexOf(__ccaaMid,__ccaaAt+1)>=0)return;'],
        ['only the dictated part replaced', '__ccaaCur.slice(0,__ccaaAt)+__ccaaLead+__ccaaCleaned+__ccaaTrail+__ccaaCur.slice(__ccaaAt+__ccaaMid.length)'],
        ['the undoable swap', 'document.execCommand("insertText",!1,__ccaaNext)'],
        ['the input event for the composer state', 'new Event("input",{bubbles:!0})'],
      ]);
      if (problem) return problem;
      // A stop click saves the state before "cleaning" arrives: clearing it there loses it.
      const cleaning = injected.match(/if\(__ccaaM\.state==="cleaning"\)\{([^}]*)\}/);
      if (!cleaning) return 'no "cleaning" branch';
      if (cleaning[1].includes('__ccaaVoiceSnap=')) return 'the "cleaning" message clears the saved dictation state';
      // A send made while recording or cleaning is held before the composer sees it, and
      // replayed after the cleaned text lands, on any other message than "cleaning".
      const heldProblem = need(injected, [
        ['the recording check', `'button[aria-label="Stop recording"]'`],
        ['the Enter hold in the capture phase', '__ccaaEv.preventDefault();__ccaaEv.stopImmediatePropagation();if(__ccaaVoiceHeld)return;'],
        ['the Enter replay on the composer', 'new KeyboardEvent("keydown",__ccaaInit)'],
        ['the send button replay', '__ccaaForm.requestSubmit()'],
        ['the 3s cap', 'setTimeout(__ccaaVoiceRelease,3e3)'],
        ['the recording stop through the dictation shortcut', '{key:"d",code:"KeyD",metaKey:!0,ctrlKey:!0,cancelable:!0}'],
      ]);
      if (heldProblem) return heldProblem;
      if ((injected.match(/addEventListener\("(?:keydown|submit)",[\s\S]*?\},!0\)/g) || []).length !== 2) {
        return 'the keydown and submit holds are not both capture listeners';
      }
      if (!/__ccaaVoiceApply\(__ccaaSnap,__ccaaM\.text\.trim\(\)\);__ccaaVoiceRelease\(\)/.test(injected)) {
        return 'the held send is not replayed right after the cleaned text is applied';
      }
      return host.includes("send({ state: 'skipped' });") ? null : 'the host does not post "skipped" when no cleanup runs';
    },
  },
  {
    // The mic button turns green only once the host has seen the recorder read the built-in
    // mic, and goes back to stock when the recording stops.
    name: 'dictation-builtin-mic-badge',
    rel: 'webview/index.js',
    check(patched) {
      const injected = block(patched, 'VoiceLib');
      if (!injected) return 'no /*__ccaaVoiceLib*/ block';
      if (!injected.includes('if(__ccaaM&&__ccaaM.type==="ccaa-mic"){if(__ccaaM.state==="builtin")document.body.dataset.ccaaMic="builtin";else delete document.body.dataset.ccaaMic;return}')) {
        return 'the webview does not set the mic flag on "builtin" only and clear it otherwise';
      }
      const host = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
      const helper = fs.readFileSync(path.join(__dirname, '..', 'mic-helper.c'), 'utf8');
      return need(host + helper, [
        ['the host message type', "post({ type: 'ccaa-mic', channelId, ...message })"],
        ['the check of what this process records from', "['inputs', String(process.pid)]"],
        ['"builtin" only when every input is the built-in mic', "if (devices.every((device) => device.id === check.builtin)) {\n      check.post?.({ state: 'builtin' });"],
        ['the flag cleared on stop', "micCheck.post?.({ state: 'off' });"],
        ['the helper process input lookup', 'address(kAudioProcessPropertyDevices, kAudioObjectPropertyScopeInput)'],
      ]);
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
        ['a setting read off the webview state', '.config.value?.spinnerVerbsConfig'],
        ['the session effort setter', 'setEffortLevel('],
        ['the applied-effort adopter', 'adoptAppliedEffort('],
        ['the composer input', '"aria-label":"Message input"'],
        ['the dictation state reset', '.prefix=null,$.suffix="",$.lastSetInput=null'],
        ['the recording mic label', '?"Stop recording":"Voice dictation"'],
        ['the dictation shortcut', '.key.toLowerCase()==="d"'],
        ['the replayed question prompt', 'Answering your earlier question'],
        ['the slash-command prompt flag', '.isSlashCommand)return'],
        ['the prompt fold button', 'children:"Show more"'],
        ['the message actions fork callback', 'onCreateNewSession:'],
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
        ['the green recording button once the built-in mic is confirmed', 'body[data-ccaa-mic="builtin"] button[aria-label="Stop recording"]{--app-recording-foreground:'],
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
        ['the recording button colors', 'background-color:var(--app-recording-background);color:var(--app-recording-foreground)'],
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
    // The restore has to run before upstream's own read, once per channel, from the main
    // chain only (a subagent's turns carry their own effort), and answer in the handler's
    // response shape with the tag the webview adopts on.
    name: 'session-effort-restore',
    rel: 'extension.js',
    check(patched) {
      const handler = patched.indexOf('case"get_applied_settings":');
      if (handler === -1) return 'no get_applied_settings handler';
      const restore = block(patched, 'EffortRestore');
      if (restore === null) return 'no /*__ccaaEffortRestore*/ block';
      const start = patched.indexOf('/*__ccaaEffortRestore*/');
      const upstreamRead = patched.indexOf('.query.getSettings()', patched.indexOf('/*__ccaaEffortRestoreEnd*/'));
      if (start < handler || upstreamRead === -1 || patched.slice(handler, start).includes('.query.getSettings()')) {
        return 'the block does not sit at the top of the get_applied_settings handler';
      }
      return need(restore, [
        ['a once-per-channel guard', 'WeakSet'],
        ['the sessionScopedEffortSwitch gate', '"sessionScopedEffortSwitch"'],
        ['the session transcript lookup', '.jsonl"'],
        ['the main-chain filter', '.isSidechain'],
        ['the session-scoped effort push', '.query.applyFlagSettings({effortLevel:'],
        ['the handler response type', 'type:"get_applied_settings_response"'],
        ['the tag the webview adopts on', 'ccaaEffortRestored:!0'],
      ]);
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
        ['the group lock', '"workbench.action.lockEditorGroup"'],
        ['the upstream lock opt-out', 'getConfiguration("claudeCode").get("lockEditorGroups")!==!1'],
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
    // The close API has to reach the panel through the manager's own session map: from
    // outside, every session tab is the same claudeVSCodePanel webview, so nothing else
    // can tell which tab holds which session. And it must answer false in a window that
    // does not hold it — that is what lets every window try the same id in turn.
    name: 'close-panel-api',
    rel: 'extension.js',
    check(patched) {
      const injected = block(patched, 'CloseApi');
      if (!injected) return 'no close-api block in the patched bundle';
      if (!patched.includes('sessionPanels=new Map;/*__ccaaCloseApi*/')) {
        return 'the close api is not declared beside the session map, so `this` may not be the manager';
      }
      return need(injected, [
        ['the global other extensions call', 'globalThis.__ccaaClosePanel='],
        ['the session lookup', 'this.sessionPanels.get('],
        ['the panel disposal', '__ccaaPanel.dispose()'],
        ['the "not in this window" answer', 'if(!__ccaaPanel)return!1'],
      ]);
    },
  },
  {
    // Every webview state the host builds carries the quickSend settings, read when it is built.
    name: 'quick-send-state',
    rel: 'extension.js',
    check(patched, clean) {
      const anchor = 'spinnerVerbsConfig:this.settings.getSpinnerVerbsConfig(),';
      const builders = windows(clean, anchor, 0, 0).length;
      const read =
        '/*__ccaaQuickSendState*/ccaaQuickSend:(()=>{try{return require("vscode").workspace.getConfiguration("claude-code-no-auto-attach").get("quickSend")';
      const carried = windows(patched, anchor + read, 0, 0).length;
      return carried === builders ? null : `${carried} of ${builders} webview state builders carry the quickSend settings`;
    },
  },
  {
    // A quickSend settings change re-posts the state, like upstream's own forwarded settings.
    name: 'quick-send-watch',
    rel: 'extension.js',
    check: (patched) =>
      /\.affectsConfiguration\("claudeCode\.spinnerVerbs"\)\/\*__ccaaQuickSendWatch\*\/\|\|[\w$]+\.affectsConfiguration\("claude-code-no-auto-attach\.quickSend"\)\/\*__ccaaQuickSendWatchEnd\*\/\)this\.pushStateUpdate\(\)/.test(
        patched
      )
        ? null
        : 'the quickSend settings are not in the listener that re-posts the webview state',
  },
  {
    // The recording start reaches this extension from the real VS Code handler, not from
    // the base class stub that only throws.
    name: 'voice-cleanup-start',
    rel: 'extension.js',
    check(patched) {
      const hooks = windows(patched, '/*__ccaaVoiceStart*/', 0, 0).length;
      if (hooks !== 1) return `expected one start hook, found ${hooks}`;
      if (!/handleStartSpeechToText\(([\w$]+)\)\{\/\*__ccaaVoiceStart\*\/try\{globalThis\.__ccaaVoiceHostStart\?\.\(\1,\(__ccaaVoiceMsg\)=>this\.webview\.postMessage\(__ccaaVoiceMsg\)\)\}catch\([\w$]+\)\{\}\/\*__ccaaVoiceStartEnd\*\/if\(this\.output\.info\(/.test(patched)) {
        return 'the start hook is not the first statement of the VS Code speech-to-text start handler, with its channel and webview poster';
      }
      const host = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
      return host.includes('globalThis.__ccaaVoiceHostStart = onVoiceStart;') ? null : 'the extension does not register __ccaaVoiceHostStart';
    },
  },
  {
    // At the end of the stream, the hook gets the channel and the *last* transcript the
    // loop saw (each message carries the whole text so far), plus this webview's poster.
    name: 'voice-cleanup-done',
    rel: 'extension.js',
    check(patched) {
      const done = patched.match(
        /for await\(let ([\w$]+) of [\w$]+\)([\w$]+)=\1,this\.send\(\{type:"speech_to_text_message",channelId:([\w$]+),text:\1,done:!1\}\)\}catch\([\w$]+\)\{[^]{0,300}?\}finally\{\/\*__ccaaVoiceDone\*\/try\{globalThis\.__ccaaVoiceHostDone\?\.\(([\w$]+),([\w$]+),\(__ccaaVoiceMsg\)=>this\.webview\.postMessage\(__ccaaVoiceMsg\)\)\}/
      );
      if (!done) return 'the transcript stream does not call __ccaaVoiceHostDone first thing in its finally block';
      if (done[4] !== done[3]) return 'the hook gets another channel than the stream';
      if (done[5] !== done[2]) return 'the hook gets another value than the last transcript';
      const host = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
      return host.includes('globalThis.__ccaaVoiceHostDone = onVoiceDone;') ? null : 'the extension does not register __ccaaVoiceHostDone';
    },
  },
  {
    // The built-in mic is made the default right before the native module opens the default
    // input, and put back right after it stops. The helper picks the built-in device whose input source is the internal mic, not the headset jack.
    name: 'dictation-builtin-mic',
    rel: 'extension.js',
    check(patched) {
      if (windows(patched, '/*__ccaaMicStart*/', 0, 0).length !== 1) return 'expected one mic start hook';
      if (windows(patched, '/*__ccaaMicStop*/', 0, 0).length !== 1) return 'expected one mic stop hook';
      if (!/if\(([\w$]+)\.isRecording\(\)\)return"native";\/\*__ccaaMicStart\*\/try\{globalThis\.__ccaaMicStart\?\.\(\)\}catch\([\w$]+\)\{\}\/\*__ccaaMicStartEnd\*\/if\(\1\.startRecording\(/.test(patched)) {
        return 'the start hook does not run right before the native startRecording';
      }
      if (!/if\(([\w$]+)\?\.isRecording\(\)\)\{\1\.stopRecording\(\);\/\*__ccaaMicStop\*\/try\{globalThis\.__ccaaMicStop\?\.\(\)\}catch\([\w$]+\)\{\}\/\*__ccaaMicStopEnd\*\/return\}/.test(patched)) {
        return 'the stop hook does not run right after the native stopRecording';
      }
      const host = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
      const helper = fs.readFileSync(path.join(__dirname, '..', 'mic-helper.c'), 'utf8');
      return need(host + helper, [
        ['the start hook registration', 'globalThis.__ccaaMicStart = onMicStart;'],
        ['the stop hook registration', 'globalThis.__ccaaMicStop = onMicStop;'],
        ['the internal mic lookup', 'transport == kAudioDeviceTransportTypeBuiltIn && is_internal_mic(devices[i])'],
        ['the restore guard', 'if (default_input() != builtin) return 0;'],
      ]);
    },
  },
  {
    name: 'upstream-affordances',
    rel: 'extension.js',
    check: (_patched, clean) =>
      need(clean, [
        ['the session panel map', 'sessionPanels=new Map;'],
        ['the tool-permission request', 'can_use_tool'],
        ['the permission-mode setter', 'setPermissionMode'],
        ['the settings write', 'writeUserSettingsAndPush'],
        ['the applied-settings answer', 'type:"get_applied_settings_response"'],
        ['the flag-settings push', 'applyFlagSettings('],
        ['the uri /open fallback', 'primaryEditor.open'],
        ['the editor-open command', 'claude-vscode.editor.open'],
        ['the active-editor subscription', 'onDidChangeActiveTextEditor'],
        ['the appended VSCode prompt', '# VSCode Extension Context'],
        ['the workspace-relative link rule', 'The URL links should be relative paths'],
        ['the webview state builder', 'spinnerVerbsConfig:this.settings.getSpinnerVerbsConfig(),'],
        ['the state-push settings listener', 'affectsConfiguration("claudeCode.spinnerVerbs"))this.pushStateUpdate()'],
        ['the speech-to-text stream message', 'type:"speech_to_text_message"'],
        ['the speech-to-text start handler', 'handleStartSpeechToText('],
        ['the bundled claude binary', '"native-binary"'],
        ['the native audio capture module', '"audio-capture.node"'],
      ]),
  },
];

module.exports = { assertions: [...WEBVIEW, ...CSS, ...EXTENSION] };
