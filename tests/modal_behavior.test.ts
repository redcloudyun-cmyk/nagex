import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';

// public/modal-behavior.js is a dependency-free browser script (IIFE), loaded
// the same way tests/plan_resolution_ui.test.ts loads plan-resolution-view.js:
// run its real source in a vm sandbox so we exercise the actual focus-trap
// and scroll-lock logic the Plan Preview modal relies on, not a
// re-implementation of it.
function loadModalBehavior(): {
  computeFocusTrapTarget: (focusableElements: unknown[], activeElement: unknown, shiftKey: boolean) => unknown;
  createScrollLock: () => { lock: (v: unknown) => void; unlock: () => unknown; isLocked: () => boolean };
  isBackdropSelfClick: (eventTarget: unknown, backdropElement: unknown) => boolean;
} {
  const source = fs.readFileSync(path.join(process.cwd(), 'public', 'modal-behavior.js'), 'utf8');
  const sandbox: Record<string, unknown> = {};
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'modal-behavior.js' });
  return (sandbox.window as Record<string, unknown>).NAGEX_MODAL_BEHAVIOR as ReturnType<typeof loadModalBehavior>;
}

const behavior = loadModalBehavior();

// ── focus trap ───────────────────────────────────────────────────────────

test('Shift+Tab on the first focusable element wraps to the last', () => {
  const els = ['first', 'middle', 'last'];
  assert.equal(behavior.computeFocusTrapTarget(els, 'first', true), 'last');
});

test('Tab on the last focusable element wraps to the first', () => {
  const els = ['first', 'middle', 'last'];
  assert.equal(behavior.computeFocusTrapTarget(els, 'last', false), 'first');
});

test('Tab/Shift+Tab in the middle of the modal needs no wrap-around', () => {
  const els = ['first', 'middle', 'last'];
  assert.equal(behavior.computeFocusTrapTarget(els, 'middle', false), null);
  assert.equal(behavior.computeFocusTrapTarget(els, 'middle', true), null);
});

test('no focusable elements: never throws, always returns null', () => {
  assert.equal(behavior.computeFocusTrapTarget([], 'anything', false), null);
  assert.equal(behavior.computeFocusTrapTarget(null as unknown as unknown[], 'anything', true), null);
});

test('a single focusable element traps Tab and Shift+Tab onto itself', () => {
  const els = ['only'];
  assert.equal(behavior.computeFocusTrapTarget(els, 'only', false), 'only');
  assert.equal(behavior.computeFocusTrapTarget(els, 'only', true), 'only');
});

// ── body scroll lock/unlock (item 6: always restore, even called redundantly) ──

test('scroll lock restores the exact prior value on unlock', () => {
  const lock = behavior.createScrollLock();
  lock.lock('auto');
  assert.equal(lock.isLocked(), true);
  assert.equal(lock.unlock(), 'auto');
  assert.equal(lock.isLocked(), false);
});

test('unlock is a safe no-op (returns null) when the lock was never engaged', () => {
  const lock = behavior.createScrollLock();
  assert.equal(lock.unlock(), null);
});

test('unlock is safe to call more than once: the restore value is returned exactly once', () => {
  // Models e.g. a backdrop click immediately followed by an Escape keypress
  // both trying to close the same modal — must not restore scrolling twice
  // or throw on the second call.
  const lock = behavior.createScrollLock();
  lock.lock('');
  assert.equal(lock.unlock(), '');
  assert.equal(lock.unlock(), null);
});

test('locking twice in a row keeps the FIRST prior value', () => {
  const lock = behavior.createScrollLock();
  lock.lock('scroll');
  lock.lock('hidden'); // no-op: already locked, must not clobber the real prior value
  assert.equal(lock.unlock(), 'scroll');
});

test('lock -> unlock -> lock -> unlock is independent across cycles (reopening the modal later)', () => {
  const lock = behavior.createScrollLock();
  lock.lock('auto');
  assert.equal(lock.unlock(), 'auto');
  lock.lock('scroll');
  assert.equal(lock.unlock(), 'scroll');
});

// ── backdrop click vs. click inside the modal ───────────────────────────

test('a click on the backdrop itself should close the modal', () => {
  const backdrop = {};
  assert.equal(behavior.isBackdropSelfClick(backdrop, backdrop), true);
});

test('a click on anything inside the modal (a descendant of the backdrop) must not close it', () => {
  const backdrop = {};
  const modalContent = {};
  const button = {};
  assert.equal(behavior.isBackdropSelfClick(modalContent, backdrop), false);
  assert.equal(behavior.isBackdropSelfClick(button, backdrop), false);
});
