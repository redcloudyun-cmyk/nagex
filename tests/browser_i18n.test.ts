import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';

function loadI18n(): {
  t: (key: string) => string;
  getLocale: () => string;
  setLocale: (locale: string) => void;
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

const BROWSER_KEYS = [
  'browser.openingWebsite',
  'browser.readingPage',
  'browser.connectPrompt',
  'browser.sessionBlocked',
  'browser.approvalRequired',
  'browser.target',
  'browser.currentPage',
  'browser.approveAndClick',
  'browser.reject',
  'browser.actionCompleted',
  'browser.openLink',
];

test('every browser.* key resolves to a real, non-empty EN string', () => {
  const i18n = loadI18n();
  for (const key of BROWSER_KEYS) {
    const value = i18n.t(key);
    assert.notEqual(value, key, `expected an EN translation for ${key}`);
    assert.ok(value.trim().length > 0, `expected a non-empty EN translation for ${key}`);
  }
});

test('every browser.* key resolves to a real, non-empty KR string', () => {
  const i18n = loadI18n();
  i18n.setLocale('ko');
  for (const key of BROWSER_KEYS) {
    const value = i18n.t(key);
    assert.notEqual(value, key, `expected a KR translation for ${key}`);
    assert.ok(value.trim().length > 0, `expected a non-empty KR translation for ${key}`);
  }
});

test('spot check: exact required strings for the status lines', () => {
  const i18n = loadI18n();
  assert.equal(i18n.t('browser.openingWebsite'), 'Opening website...');
  assert.equal(i18n.t('browser.readingPage'), 'Reading page...');
  i18n.setLocale('ko');
  assert.equal(i18n.t('browser.openingWebsite'), '웹사이트 여는 중...');
  assert.equal(i18n.t('browser.readingPage'), '페이지 읽는 중...');
});
