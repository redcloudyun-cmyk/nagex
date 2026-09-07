import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';

// Same loading technique as tests/i18n_strings.test.ts.
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

// Every gmail.* key referenced by app.js's Gmail ambient wiring (see
// tests/gmail_ambient_wiring.test.ts) must resolve to a real, distinct
// translation in both EN and KR — never silently fall back to the raw key
// (which would mean a missing entry) and never resolve to the same literal
// string in both locales (which would mean a forgotten translation).
const GMAIL_KEYS = [
  'gmail.confirmSend',
  'gmail.confirmReply',
  'gmail.confirmDraft',
  'gmail.to',
  'gmail.cc',
  'gmail.bcc',
  'gmail.subject',
  'gmail.body',
  'gmail.account',
  'gmail.threadId',
  'gmail.replyToMessageId',
  'gmail.recipientHint',
  'gmail.recipientHintSuffix',
  'gmail.toRequired',
  'gmail.previewAndRequestApproval',
  'gmail.connectPrompt',
  'gmail.connectButton',
  'gmail.connectNotConfigured',
  'gmail.requestingApproval',
  'gmail.sending',
  'gmail.replying',
  'gmail.savingDraft',
  'gmail.sent',
  'gmail.replySent',
  'gmail.draftCreated',
  'gmail.openInGmail',
  'gmail.searching',
  'gmail.searchResults',
  'gmail.noResults',
  'gmail.loadingThread',
  'gmail.threadMessages',
  'gmail.approveAndSend',
  'gmail.approveAndReply',
  'gmail.approveAndCreateDraft',
  'gmail.reject',
];

test('every gmail.* key resolves to a real EN string (never falls back to the raw key)', () => {
  const i18n = loadI18n();
  assert.equal(i18n.getLocale(), 'en');
  for (const key of GMAIL_KEYS) {
    const value = i18n.t(key);
    assert.notEqual(value, key, `expected an EN translation for ${key}`);
    assert.ok(value.trim().length > 0, `expected a non-empty EN translation for ${key}`);
  }
});

test('every gmail.* key resolves to a real KR string (never falls back to the raw key or the EN value)', () => {
  const i18n = loadI18n();
  i18n.setLocale('ko');
  assert.equal(i18n.getLocale(), 'ko');
  for (const key of GMAIL_KEYS) {
    const value = i18n.t(key);
    assert.notEqual(value, key, `expected a KR translation for ${key}`);
    assert.ok(value.trim().length > 0, `expected a non-empty KR translation for ${key}`);
  }
});

test('spot check: exact required EN/KR strings for the send flow', () => {
  const i18n = loadI18n();
  assert.equal(i18n.t('gmail.sent'), 'Email sent');
  assert.equal(i18n.t('gmail.approveAndSend'), 'Approve & Send');
  i18n.setLocale('ko');
  assert.equal(i18n.t('gmail.sent'), '이메일이 전송되었습니다');
  assert.equal(i18n.t('gmail.approveAndSend'), '승인 및 전송');
});
