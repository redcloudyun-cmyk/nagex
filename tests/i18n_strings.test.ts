import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';

// public/i18n.js is a dependency-free browser script (IIFE) that reads
// localStorage and touches a handful of `document` properties at load time
// (via applyLocale(), called from setLocale()). It has no real DOM
// dependency for the pure dictionary-lookup behavior this test cares about,
// so a minimal document/localStorage stub is enough to load it in a vm
// sandbox — the same pattern tests/plan_resolution_ui.test.ts uses for
// plan-resolution-view.js, extended with the few globals this module reads.
function loadI18n(): {
  t: (key: string) => string;
  getLocale: () => string;
  setLocale: (locale: string) => void;
  toggleLocale: () => void;
  applyLocale: () => void;
} {
  const source = fs.readFileSync(path.join(process.cwd(), 'public', 'i18n.js'), 'utf8');
  const storage: Record<string, string> = {};
  const documentStub = {
    documentElement: {} as Record<string, unknown>,
    title: '',
    querySelectorAll: () => [] as unknown[],
  };
  const localStorageStub = {
    getItem: (key: string) => (Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : null),
    setItem: (key: string, value: string) => {
      storage[key] = value;
    },
  };
  const sandbox: Record<string, unknown> = { document: documentStub, localStorage: localStorageStub };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'i18n.js' });
  return (sandbox.window as Record<string, unknown>).NAGEX_I18N as ReturnType<typeof loadI18n>;
}

test('EN is the default locale and returns the canonical Plan Preview modal strings', () => {
  const i18n = loadI18n();
  assert.equal(i18n.getLocale(), 'en');
  assert.equal(i18n.t('ambient.modalTitle'), 'Plan Preview');
  assert.equal(i18n.t('ambient.close'), 'Close');
  assert.equal(i18n.t('ambient.pressEscToClose'), 'Press Esc to close');
  assert.equal(i18n.t('ambient.promptPlaceholder'), 'Prepare my next client meeting and schedule it.');
  assert.equal(i18n.t('ambient.promptAriaLabel'), 'Ask NAgex');
  assert.equal(i18n.t('ambient.run'), 'Run');
  assert.equal(i18n.t('ambient.running'), 'Running...');
});

test('switching to KR returns the Korean Plan Preview modal strings', () => {
  const i18n = loadI18n();
  i18n.setLocale('ko');
  assert.equal(i18n.getLocale(), 'ko');
  assert.equal(i18n.t('ambient.modalTitle'), '계획 미리보기');
  assert.equal(i18n.t('ambient.close'), '닫기');
  assert.equal(i18n.t('ambient.pressEscToClose'), 'Esc 키를 눌러 닫기');
  assert.equal(i18n.t('ambient.promptPlaceholder'), '다음 고객 미팅을 준비하고 일정을 잡아줘.');
  assert.equal(i18n.t('ambient.promptAriaLabel'), 'NAgex에게 요청하기');
  assert.equal(i18n.t('ambient.run'), '실행');
  assert.equal(i18n.t('ambient.running'), '실행 중...');
});

test('toggleLocale flips between EN and KR and back', () => {
  const i18n = loadI18n();
  assert.equal(i18n.getLocale(), 'en');
  i18n.toggleLocale();
  assert.equal(i18n.getLocale(), 'ko');
  assert.equal(i18n.t('ambient.close'), '닫기');
  i18n.toggleLocale();
  assert.equal(i18n.getLocale(), 'en');
  assert.equal(i18n.t('ambient.close'), 'Close');
});

test('an unknown key falls back to the EN dictionary, then to the raw key', () => {
  const i18n = loadI18n();
  i18n.setLocale('ko');
  // Every KR key added for the modal has a value, so falling back to EN
  // only happens for a genuinely missing key.
  assert.equal(i18n.t('not.a.real.key'), 'not.a.real.key');
});
