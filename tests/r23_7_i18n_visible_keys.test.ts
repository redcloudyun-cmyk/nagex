import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const REQUIRED_VISIBLE_KEYS = [
  'nav.create',
  'nav.canvas',
  'canvas.agentChat',
  'canvas.agentContext',
  'canvas.agentSuggestions',
  'canvas.agentChatIntro',
] as const;

function loadI18n() {
  const listeners = new Map<string, () => void>();
  const storage = new Map<string, string>();
  const document = {
    documentElement: { lang: '' },
    title: '',
    readyState: 'complete',
    addEventListener: (event: string, handler: () => void) => listeners.set(event, handler),
    querySelectorAll: () => [],
  };
  const context = {
    document,
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    window: {},
  };
  vm.createContext(context);
  const source = fs.readFileSync(path.resolve('public/i18n.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'public/i18n.js' });
  return context.window as { NAGEX_I18N: { t: (key: string) => string; setLocale: (locale: string) => void } };
}

test('R23.7 visible i18n keys resolve for EN and KR without raw-key fallback', () => {
  const { NAGEX_I18N } = loadI18n();

  for (const locale of ['en', 'ko']) {
    NAGEX_I18N.setLocale(locale);
    for (const key of REQUIRED_VISIBLE_KEYS) {
      const value = NAGEX_I18N.t(key);
      assert.notEqual(value, key, `${key} must not resolve to the raw key in ${locale}`);
      assert.ok(value.trim().length > 0, `${key} must resolve to visible text in ${locale}`);
    }
  }
});
