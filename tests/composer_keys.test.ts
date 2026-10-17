import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

// public/composer-keys.js is the ONE definition of "this Enter sends" / "this Enter only confirms an IME composition" shared by every reachable message box (Main, the ambient bar, Canvas Ask,
// Quick Wake). Its real source runs here in a vm sandbox, the way the other dependency-free browser modules are tested; composer_enter_browser.test.ts proves it on the real pages.
interface Watcher { isActive(): boolean; endedWithin(ms: number): boolean }
interface Keys {
  watchComposition(element: unknown, now?: () => number): Watcher;
  confirmsComposition(event: unknown, watcher: Watcher | null): boolean;
  isSubmitEnter(event: unknown, watcher: Watcher | null): boolean;
  JUST_ENDED_MS: number;
}

function load(): Keys {
  const source = fs.readFileSync(path.resolve(__dirname, '..', '..', 'public', 'composer-keys.js'), 'utf8');
  const sandbox: { window: { NAGEX_COMPOSER_KEYS?: Keys } } = { window: {} };
  vm.runInNewContext(source, sandbox);
  assert.ok(sandbox.window.NAGEX_COMPOSER_KEYS, 'the script publishes window.NAGEX_COMPOSER_KEYS');
  return sandbox.window.NAGEX_COMPOSER_KEYS as Keys;
}

const key = (init: Record<string, unknown> = {}) => ({ key: 'Enter', ...init });
function field() {
  const target = new EventTarget();
  const fire = (type: string, extra: Record<string, unknown> = {}) => { const event = new Event(type); Object.assign(event, extra); target.dispatchEvent(event); };
  return { target, fire };
}

test('a plain Enter sends; Ctrl/Cmd+Enter sends; Shift+Enter and Alt+Enter are not a send; other keys are not an Enter', () => {
  const keys = load();
  const { target } = field();
  const w = keys.watchComposition(target);
  assert.equal(keys.isSubmitEnter(key(), w), true);
  assert.equal(keys.isSubmitEnter(key({ ctrlKey: true }), w), true);
  assert.equal(keys.isSubmitEnter(key({ metaKey: true }), w), true);
  assert.equal(keys.isSubmitEnter(key({ shiftKey: true }), w), false);
  assert.equal(keys.isSubmitEnter(key({ altKey: true }), w), false);
  assert.equal(keys.isSubmitEnter({ key: 'a' }, w), false);
  assert.equal(keys.isSubmitEnter({ key: 'Escape' }, w), false);
  assert.equal(keys.isSubmitEnter(null, w), false);
});

test('the Enter that confirms an IME composition is never a send - whichever signal the browser gives', () => {
  const keys = load();
  const { target, fire } = field();
  let now = 1000;
  const w = keys.watchComposition(target, () => now);

  assert.equal(keys.isSubmitEnter(key({ isComposing: true }), w), false, 'Chrome / Firefox: isComposing');
  assert.equal(keys.isSubmitEnter(key({ keyCode: 229 }), w), false, 'the IME-processing key code');
  fire('compositionstart');
  assert.equal(keys.isSubmitEnter(key(), w), false, 'between compositionstart and compositionend, even when the key is reported as a plain Enter');
  fire('compositionend'); now = 1010;
  assert.equal(keys.isSubmitEnter(key(), w), false, 'Safari order: compositionend first, the confirming Enter right after');
  now = 1000 + keys.JUST_ENDED_MS + 1;
  assert.equal(keys.isSubmitEnter(key(), w), true, 'the next, deliberate Enter sends - after a composition is confirmed Enter sends');
});

test('the composition flag cannot get stuck and block Enter for good', () => {
  const keys = load();
  {
    const { target, fire } = field();
    const w = keys.watchComposition(target, () => 5000);
    fire('compositionstart');
    assert.equal(w.isActive(), true);
    fire('blur'); // the box lost focus mid-composition and the end was never reported
    assert.equal(w.isActive(), false);
    assert.equal(keys.isSubmitEnter(key(), w), true);
  }
  {
    const { target, fire } = field();
    const w = keys.watchComposition(target, () => 5000);
    fire('compositionstart');
    fire('input', { isComposing: true });
    assert.equal(w.isActive(), true, 'input events DURING a composition keep it active');
    fire('input', { isComposing: false }); // ordinary typing again: no composition is running
    assert.equal(w.isActive(), false);
    assert.equal(keys.isSubmitEnter(key(), w), true);
  }
});

test('works without a watcher (a page where the element is not wired) and with an element that cannot take listeners', () => {
  const keys = load();
  assert.equal(keys.isSubmitEnter(key(), null), true);
  assert.equal(keys.isSubmitEnter(key({ isComposing: true }), null), false);
  assert.equal(keys.isSubmitEnter(key({ keyCode: 229 }), null), false);
  const w = keys.watchComposition(null);
  assert.equal(w.isActive(), false);
  assert.equal(keys.isSubmitEnter(key(), w), true);
});

test('every page that has a message box loads the shared script BEFORE the scripts that use it, and the cache stamp covers it', () => {
  const root = path.resolve(__dirname, '..', '..');
  const index = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const quick = fs.readFileSync(path.join(root, 'public', 'desktop-quickwake.html'), 'utf8');
  const at = (html: string, name: string) => html.indexOf(`src="${name}?v=__NAGEX_BUILD_VERSION__"`);
  for (const consumer of ['app.js', 'mobile/mobile-home.js', 'main-surface.js']) {
    assert.ok(at(index, 'composer-keys.js') >= 0, 'index.html loads composer-keys.js');
    assert.ok(at(index, 'composer-keys.js') < at(index, consumer), `composer-keys.js comes before ${consumer}`);
  }
  assert.ok(at(quick, 'composer-keys.js') >= 0 && at(quick, 'composer-keys.js') < at(quick, 'desktop-quickwake.js'), 'Quick Wake loads composer-keys.js before desktop-quickwake.js');
});
