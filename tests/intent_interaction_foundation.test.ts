// R12.1 Increment 1 — Intent-first UX Core: Universal Intent Interaction
// Foundation. These tests verify the reusable interaction contract itself
// (presentation-state module, logo->Home navigation, composer busy-state/
// recovery, consequence-specific approval CTAs, progressive disclosure),
// not a full Home/Inbox/Activity/Settings redesign (explicitly out of
// scope — see the governing directive's §20).
//
// Same conventions as the rest of this suite: no real browser/DOM harness
// exists here, so behavior is verified either (a) by loading the real,
// pure, DOM-free public/intent-interaction-state.js in a vm sandbox and
// calling its real exported functions, or (b) by fetching the real served
// HTML/JS from a real in-process server and asserting on exact source
// text — the same two techniques tests/ambient_composer.test.ts and
// tests/i18n_strings.test.ts already use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createServerInstance } from '../src/server_web.js';

async function withServer(run: (origin: string) => Promise<void>): Promise<void> {
  const instance = createServerInstance();
  await new Promise<void>((resolve, reject) => {
    instance.listen(0, '127.0.0.1', () => resolve());
    instance.once('error', reject);
  });
  const addr = instance.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${addr.port}`);
  } finally {
    if (typeof (instance as any).closeIdleConnections === 'function') {
      (instance as any).closeIdleConnections();
    }
    await new Promise<void>((resolve) => instance.close(() => resolve()));
  }
}

function loadIntentState(): {
  INTENT_STATE: Record<string, string>;
  INTENT_CERTAINTY: Record<string, string>;
  primaryActionKey: (state: string) => string | null;
  isMutationAuthorized: (state: string) => boolean;
  deriveInteractionState: (input: Record<string, unknown>) => string;
} {
  const source = fs.readFileSync(path.join(process.cwd(), 'public', 'intent-interaction-state.js'), 'utf8');
  const sandbox: Record<string, unknown> = {};
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'intent-interaction-state.js' });
  return (sandbox.window as Record<string, unknown>).NAGEX_INTENT_STATE as ReturnType<typeof loadIntentState>;
}

function loadI18n(): { t: (key: string) => string; setLocale: (locale: string) => void } {
  const source = fs.readFileSync(path.join(process.cwd(), 'public', 'i18n.js'), 'utf8');
  const storage: Record<string, string> = {};
  const documentStub = { documentElement: {} as Record<string, unknown>, title: '', querySelectorAll: () => [] as unknown[] };
  const localStorageStub = {
    getItem: (key: string) => (Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : null),
    setItem: (key: string, value: string) => { storage[key] = value; },
  };
  const sandbox: Record<string, unknown> = { document: documentStub, localStorage: localStorageStub };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'i18n.js' });
  return (sandbox.window as Record<string, unknown>).NAGEX_I18N as ReturnType<typeof loadI18n>;
}

// ── 1. Logo click returns Home ───────────────────────────────────────────

test('1. the desktop header, ambient modal, and mobile home logos are all wired to window.NAGEX.goHome() with keyboard activation', async () => {
  await withServer(async (origin) => {
    const html = await (await fetch(`${origin}/`)).text();

    const logoBlocks = [
      /<div class="brand-logo-group"[^>]*>/,
      /<img[^>]*class="nagex-compact-logo ambient-logo"[^>]*>/,
      /<img[^>]*class="mh-logo"[^>]*>/,
    ];
    for (const pattern of logoBlocks) {
      const match = pattern.exec(html);
      assert.ok(match, `expected to find logo markup matching ${pattern}`);
      const tag = match![0];
      assert.match(tag, /onclick="window\.NAGEX\.goHome\(\)"/, `${pattern} must call window.NAGEX.goHome() on click`);
      assert.match(tag, /role="button"/, `${pattern} must be a real interactive element`);
      assert.match(tag, /tabindex="0"/, `${pattern} must be keyboard-focusable`);
      assert.match(tag, /onkeydown="if\(event\.key==='Enter'\|\|event\.key===' '\)/, `${pattern} must activate on Enter/Space, not click-only`);
    }
  });
});

test('1b. window.NAGEX.goHome closes the ambient overlay and switches to tab-home, never partially (both calls present, in that order)', async () => {
  await withServer(async (origin) => {
    const appJs = await (await fetch(`${origin}/app.js`)).text();
    const start = appJs.indexOf('window.NAGEX.goHome = ()');
    assert.ok(start >= 0, 'expected to find window.NAGEX.goHome defined in app.js');
    const end = appJs.indexOf('};', start);
    const body = appJs.slice(start, end);
    const closeIdx = body.indexOf('closeAmbientOverlay()');
    const switchIdx = body.indexOf("switchTab('tab-home')");
    assert.ok(closeIdx >= 0 && switchIdx >= 0, 'goHome must call both closeAmbientOverlay() and switchTab(\'tab-home\')');
    assert.ok(closeIdx < switchIdx, 'the overlay must close before switching tabs, not after');
  });
});

// ── 2. Universal composer starts empty (Home input specifically; the
// ambient composer's own empty-start contract is covered by
// tests/ambient_composer.test.ts) ────────────────────────────────────────

test('2. the Home composer textarea ships with no baked-in value, only an i18n-driven placeholder', async () => {
  await withServer(async (origin) => {
    const html = await (await fetch(`${origin}/`)).text();
    const match = /<textarea[^>]*id="home-prompt-input"[^>]*>([^<]*)<\/textarea>/.exec(html);
    assert.ok(match, 'expected to find the home prompt textarea in the served page');
    assert.equal(match![1], '', 'the textarea must start with no content between its tags');
    assert.match(match![0], /data-i18n-placeholder="workspace\.askOrDrop"/);
  });
});

// ── 3. Duplicate submission blocked ──────────────────────────────────────

test('3. the Home composer send handler re-enters no-ops while a submission is already in flight', async () => {
  await withServer(async (origin) => {
    const appJs = await (await fetch(`${origin}/app.js`)).text();
    const start = appJs.indexOf('if (btnSend && homeInput) {');
    const end = appJs.indexOf('if (btnLink && homeInput)', start);
    const body = appJs.slice(start, end);
    assert.match(body, /if \(btnSend\.disabled\) return;/, 're-entrant clicks while already submitting must be a no-op');
    assert.match(body, /btnSend\.disabled = true;/);
    assert.match(body, /homeInput\.disabled = true;/);
  });
});

// ── 4. Failed request restores composer ──────────────────────────────────

test('4. a failed classification request preserves the user\'s typed text and re-enables the composer, never discarding it', async () => {
  await withServer(async (origin) => {
    const appJs = await (await fetch(`${origin}/app.js`)).text();
    const start = appJs.indexOf('if (btnSend && homeInput) {');
    const end = appJs.indexOf('if (btnLink && homeInput)', start);
    const body = appJs.slice(start, end);

    const routeCallIdx = body.indexOf("apiFetch('/api/v1/workspace/route-input'");
    const failureCheckIdx = body.indexOf('if (!routeRes || routeRes.error)', routeCallIdx);
    const clearIdx = body.indexOf("homeInput.value = '';", routeCallIdx);
    assert.ok(routeCallIdx >= 0 && failureCheckIdx >= 0, 'expected an explicit failure check right after the classification call');
    assert.ok(failureCheckIdx < clearIdx, 'the input must only ever be cleared AFTER the failure check, never before it — a failed request must never have already discarded the text');

    const finallyIdx = body.indexOf('} finally {');
    const handedOffCheckIdx = body.indexOf('if (!handedOff)', finallyIdx);
    assert.ok(finallyIdx >= 0 && handedOffCheckIdx >= 0, 'controls must be re-enabled in a finally block, gated on whether the flow was handed off to the ambient run guard');
  });
});

// ── 5/6/9. Presentation-state invariants (pure module, real assertions) ──

test('5. CLARIFICATION_REQUIRED never authorizes a mutation', () => {
  const m = loadIntentState();
  assert.equal(m.isMutationAuthorized(m.INTENT_STATE.CLARIFICATION_REQUIRED), false);
});

test('6. REVIEW_REQUIRED (plan review) never authorizes a mutation — plan acceptance != action approval', () => {
  const m = loadIntentState();
  assert.equal(m.isMutationAuthorized(m.INTENT_STATE.REVIEW_REQUIRED), false);
  // Even a plan whose steps are all EXECUTION_READY still only reaches
  // REVIEW_REQUIRED here — it never implies APPROVAL_REQUIRED was granted.
  assert.equal(m.deriveInteractionState({ planStatus: 'EXECUTION_READY' }), m.INTENT_STATE.REVIEW_REQUIRED);
  assert.notEqual(m.deriveInteractionState({ planStatus: 'EXECUTION_READY' }), m.INTENT_STATE.APPROVAL_REQUIRED);
});

test('9. COMPLETED is derived only from a real, explicit executionSucceeded=true — never inferred from the absence of an error', () => {
  const m = loadIntentState();
  assert.equal(m.deriveInteractionState({ executionSucceeded: true }), m.INTENT_STATE.COMPLETED);
  assert.notEqual(m.deriveInteractionState({}), m.INTENT_STATE.COMPLETED);
  assert.notEqual(m.deriveInteractionState({ isSubmitting: false, hasError: false }), m.INTENT_STATE.COMPLETED);
  // A real error always wins, even if some other flag looks positive —
  // never a false success.
  assert.equal(m.deriveInteractionState({ executionSucceeded: true, hasError: true }), m.INTENT_STATE.FAILED);
});

test('one primary next action per state, and APPROVAL_REQUIRED has none of its own (the caller must resolve a consequence-specific CTA, never a generic one)', () => {
  const m = loadIntentState();
  assert.equal(m.primaryActionKey(m.INTENT_STATE.CLARIFICATION_REQUIRED), 'intent.action.answer');
  assert.equal(m.primaryActionKey(m.INTENT_STATE.REVIEW_REQUIRED), 'intent.action.reviewPlan');
  assert.equal(m.primaryActionKey(m.INTENT_STATE.COMPLETED), 'intent.action.openResult');
  assert.equal(m.primaryActionKey(m.INTENT_STATE.WORKING), null, 'WORKING must not carry a mutating primary action');
  assert.equal(m.primaryActionKey(m.INTENT_STATE.APPROVAL_REQUIRED), null, 'a generic APPROVAL_REQUIRED action would violate the consequence-specific CTA rule');
});

// ── 7. Approval CTA is consequence-specific ──────────────────────────────

test('7. the Calendar and Gmail approve buttons render consequence-specific text, never a generic Run/Continue/OK', async () => {
  await withServer(async (origin) => {
    const appJs = await (await fetch(`${origin}/app.js`)).text();
    assert.match(appJs, /id="btn-calendar-approve"[^>]*>\$\{escapeHtml\(t\('calendar\.approveAndCreateEvent'\)\)\}/);
    assert.match(appJs, /id="btn-gmail-approve"[^>]*>\$\{escapeHtml\(t\(gmailApproveButtonLabelKey\(approval\.toolId\)\)\)\}/);

    const i18n = fs.readFileSync(path.join(process.cwd(), 'public', 'i18n.js'), 'utf8');
    for (const key of ['calendar.approveAndCreateEvent', 'gmail.approveAndSend', 'gmail.approveAndReply', 'gmail.approveAndCreateDraft']) {
      const line = new RegExp(`'${key.replace('.', '\\.')}': '([^']+)'`).exec(i18n);
      assert.ok(line, `expected an i18n value for ${key}`);
      for (const generic of ['Run', 'Continue', 'OK']) {
        assert.notEqual(line![1], generic, `${key} must not be the generic label "${generic}"`);
      }
    }
  });
});

// ── 8. Rejected approval does not execute ────────────────────────────────

test('8. the Calendar reject handler never calls a provider-mutation endpoint — only the approval record\'s own reject() method', async () => {
  await withServer(async (origin) => {
    const appJs = await (await fetch(`${origin}/app.js`)).text();
    const reqStart = appJs.indexOf('async function requestCalendarApproval(');
    assert.ok(reqStart >= 0, 'expected to find requestCalendarApproval in the served app.js');
    const reqEnd = appJs.indexOf('\n  async function ', reqStart + 1);
    const body = appJs.slice(reqStart, reqEnd > reqStart ? reqEnd : reqStart + 4000);
    const rejectHandlerIdx = body.indexOf('btnReject.onclick');
    assert.ok(rejectHandlerIdx >= 0, 'expected to find the reject button handler');
    const rejectBody = body.slice(rejectHandlerIdx, body.indexOf('};', rejectHandlerIdx));
    assert.doesNotMatch(rejectBody, /tools\/google-calendar\/create-event/, 'rejecting an approval must never call the create-event execution endpoint');
    assert.match(rejectBody, /\/reject/, 'the reject handler must call the approval reject endpoint');
  });
});

// ── 10. Details panel is optional/progressive, collapsed by default ─────

test('10. the "What NAgex is doing" activity detail panel is hidden and collapsed by default', async () => {
  await withServer(async (origin) => {
    const html = await (await fetch(`${origin}/`)).text();
    const containerMatch = /<div class="ambient-activity-detail" id="ambient-activity-detail"[^>]*>/.exec(html);
    assert.ok(containerMatch, 'expected to find the ambient activity detail container');
    assert.match(containerMatch![0], /style="display:none;"/, 'the panel must be hidden until there is real detail to show');

    const toggleMatch = /<button class="ambient-activity-toggle" id="btn-ambient-activity-toggle"[^>]*>/.exec(html);
    assert.ok(toggleMatch, 'expected to find the activity detail toggle button');
    assert.match(toggleMatch![0], /aria-expanded="false"/);
    assert.match(toggleMatch![0], /aria-controls="ambient-activity-detail-body"/);

    const bodyMatch = /<div class="ambient-activity-detail-body" id="ambient-activity-detail-body"([^>]*)>/.exec(html);
    assert.ok(bodyMatch, 'expected to find the activity detail body');
    assert.match(bodyMatch![1], /\bhidden\b/, 'the detail body must be [hidden] by default');
  });
});

// ── 11. EN/KR strings resolve for every new key ──────────────────────────

test('11. every new R12.1 Increment 1 i18n key resolves to a real, non-empty, distinct EN and KR string', () => {
  const i18n = loadI18n();
  const newKeys = [
    'ambient.progress.planReady',
    'ambient.unableToGeneratePlan',
    'ambient.activityToggle',
    'ambient.activityProvider',
    'ambient.activityModel',
    'ambient.activityLatency',
    'ambient.activityRequestId',
    'nav.logoHomeAria',
    'calendar.approveAndCreateEvent',
    'calendar.reject',
    'intent.action.answer',
    'intent.action.reviewPlan',
    'intent.action.openResult',
    'intent.action.retry',
  ];
  for (const key of newKeys) {
    i18n.setLocale('en');
    const en = i18n.t(key);
    i18n.setLocale('ko');
    const ko = i18n.t(key);
    assert.ok(en && en !== key, `${key} must resolve to a real EN string, not fall back to the raw key`);
    assert.ok(ko && ko !== key, `${key} must resolve to a real KR string, not fall back to the raw key`);
    assert.notEqual(en, ko, `${key}'s EN and KR values must actually differ (a real translation, not a copy-paste placeholder)`);
  }
});

// ── 12. Keyboard navigation (logo activation) ────────────────────────────

test('12. all three logo instances activate goHome() on both Enter and Space, matching the codebase\'s established keyboard-activation idiom', async () => {
  await withServer(async (origin) => {
    const html = await (await fetch(`${origin}/`)).text();
    const matches = html.match(/onkeydown="if\(event\.key==='Enter'\|\|event\.key===' '\)\{event\.preventDefault\(\);window\.NAGEX\.goHome\(\);\}"/g) || [];
    assert.equal(matches.length, 3, `expected exactly 3 logo instances wired for keyboard activation, found ${matches.length}`);
  });
});

// ── 13. Mobile viewport: new CSS introduces no fixed width wider than the
// smallest required viewport (360px) ─────────────────────────────────────

test('13. the new activity-detail CSS never sets a fixed pixel width, so it cannot overflow a 360px viewport', () => {
  const css = fs.readFileSync(path.join(process.cwd(), 'public', 'style.css'), 'utf8');
  const start = css.indexOf('.ambient-activity-detail {');
  assert.ok(start >= 0, 'expected to find the new .ambient-activity-detail rules');
  const end = css.indexOf('/* ── R8', start);
  const block = css.slice(start, end > start ? end : start + 1500);
  const fixedWidthMatches = block.match(/width:\s*\d+px/g) || [];
  assert.deepEqual(fixedWidthMatches, [], `activity-detail CSS must not use a fixed pixel width (found: ${fixedWidthMatches.join(', ')}) — it must stay fluid within its container at any viewport`);
});

// ── 14. Back/Forward navigation correctness: goHome/switchTab never touch
// history.pushState or location.hash, so the browser's native history is
// never put into a broken half-routed state ──────────────────────────────

test('14. goHome() and switchTab() never call history.pushState/replaceState or set location.hash — tab navigation stays pure client state, never partially-broken URL routing', async () => {
  await withServer(async (origin) => {
    const appJs = await (await fetch(`${origin}/app.js`)).text();

    const goHomeStart = appJs.indexOf('window.NAGEX.goHome = ()');
    const goHomeEnd = appJs.indexOf('};', goHomeStart);
    const goHomeBody = appJs.slice(goHomeStart, goHomeEnd);
    assert.doesNotMatch(goHomeBody, /history\.(push|replace)State/);
    assert.doesNotMatch(goHomeBody, /location\.hash/);

    const switchTabStart = appJs.indexOf('function switchTab(tabId)');
    const switchTabEnd = appJs.indexOf('\n  function renderActiveTab', switchTabStart);
    const switchTabBody = appJs.slice(switchTabStart, switchTabEnd);
    assert.doesNotMatch(switchTabBody, /history\.(push|replace)State/);
    assert.doesNotMatch(switchTabBody, /location\.hash/);
  });
});
