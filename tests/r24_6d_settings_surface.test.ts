// R24.6D — deterministic source/markup contract for the Settings surface completion
// (the behavior itself is certified in real Chromium by r24_6d_settings_surface_browser).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const read = (f: string) => fs.readFileSync(path.join(process.cwd(), 'public', f), 'utf8');

function loadI18n(): { t: (k: string) => string; setLocale: (l: string) => void } {
  const context: any = {
    window: {},
    document: { readyState: 'loading', addEventListener() {}, documentElement: {}, querySelectorAll: () => [] },
    localStorage: { getItem: () => null, setItem() {} },
    navigator: { language: 'en' },
    CustomEvent: class {},
  };
  vm.createContext(context);
  vm.runInContext(read('i18n.js'), context);
  return context.window.NAGEX_I18N;
}

describe('R24.6D — Settings surface contract', () => {
  it('Desktop Settings has an Account category whose container is the shared renderer\'s Desktop target', () => {
    const html = read('index.html');
    assert.match(html, /id="cat-tab-account"[^>]*data-cat="account"|data-cat="account"[^>]*id="cat-tab-account"/);
    assert.match(html, /id="cat-panel-account"/);
    assert.match(html, /id="desktop-account-panel"/);
    const auth = read('auth-ui.js');
    assert.match(auth, /ACCOUNT_CONTAINERS\s*=\s*\[[\s\S]*mh-account-panel[\s\S]*desktop-account-panel/);
    assert.equal((auth.match(/async function renderAccountInto/g) || []).length, 1, 'exactly one Account renderer implementation');
    assert.match(read('app.js'), /catKey === 'account'[\s\S]{0,160}renderAccountSettings/);
  });

  it('every Account element id is container-prefixed in the one renderer, so two containers never duplicate ids', () => {
    const auth = read('auth-ui.js');
    const body = auth.slice(auth.indexOf('async function renderAccountInto'), auth.indexOf('// Initialize header pill click handlers'));
    const unprefixed = [...body.matchAll(/\bid="([^"$][^"]*)"/g)].map((m) => m[1]);
    assert.deepEqual(unprefixed, [], `unprefixed ids in the shared Account renderer: ${unprefixed.join(', ')}`);
    assert.deepEqual([...body.matchAll(/getElementById\('(acc-[^']+|btn-[^']+)'\)/g)].map((m) => m[1]), [], 'lookups must use the container prefix');
  });

  it('the Cancel Deletion control has a real handler (no dead control)', () => {
    const auth = read('auth-ui.js');
    assert.match(auth, /getElementById\(idp \+ 'btn-cancel-delete'\)\?\.addEventListener\('click'/);
    assert.match(auth, /\/api\/v1\/account\/delete\/cancel/);
  });

  it('Organization is hidden by default on Mobile and one gate (isEnterpriseUiMode) controls both Desktop and Mobile', () => {
    const html = read('index.html');
    assert.match(html, /id="mh-org-settings-heading"[^>]*\bhidden\b/);
    assert.match(html, /id="mh-org-settings-card"[^>]*\bhidden\b/);
    const app = read('app.js');
    const gate = app.slice(app.indexOf('function applyEnterpriseUiGate'), app.indexOf('function updateFlowStage'));
    assert.match(gate, /cat-tab-organization/);
    assert.match(gate, /mh-org-settings-heading/);
    assert.match(gate, /mh-org-settings-card/);
    assert.match(gate, /isEnt/);
    assert.match(app, /catKey === 'organization' && !isEnterpriseUiMode\(\)/);
  });

  it('Desktop Quick Wake / Autonomy labels come from the same i18n keys Mobile uses (no hardcoded English)', () => {
    const app = read('app.js');
    for (const hardcoded of ['Floating NAgex Button', 'Quick Settings Tile (Android)', 'Lock Screen Shortcut', 'Voice Wake Command', 'Double-Tap Shortcut', 'Fingerprint Sensor Button', 'Not supported on this device', "title: 'Always ask'", "title: 'Read and suggest'", "title: 'Help with routine tasks'", "title: 'Use trusted routines'"]) {
      assert.equal(app.includes(hardcoded), false, `app.js still hardcodes: ${hardcoded}`);
    }
    for (const key of ['mobileSettings.qwFloatingButton', 'mobileSettings.qwFingerprintNotSupported', 'mobileSettings.autonomyL0Title', 'mobileSettings.autonomyL3Desc']) {
      assert.ok(app.includes(`tr('${key}')`), `desktop Settings must read ${key}`);
    }
  });

  it('the new Settings/Account strings resolve in both languages and are really translated', () => {
    const i18n = loadI18n();
    const keys = ['settings.privacyS3Title', 'settings.categoriesAria', 'account.loadingSessions', 'account.passwordUpdateFailed', 'account.disablePrompt', 'account.disableFailed', 'account.deletePrompt', 'account.deleteFailed', 'account.cancelDeletePrompt', 'account.cancelDeleteFailed', 'account.unknownDevice', 'account.currentSession', 'account.createdLabel', 'account.title'];
    const en = Object.fromEntries(keys.map((k) => [k, i18n.t(k)]));
    i18n.setLocale('ko');
    for (const k of keys) {
      const ko = i18n.t(k);
      assert.notEqual(en[k], k, `${k} must resolve in EN`);
      assert.notEqual(ko, k, `${k} must resolve in KR`);
      assert.match(ko, /[가-힣]/, `${k} must be translated in KR (got ${ko})`);
    }
    assert.equal(read('index.html').includes('??/ pan>'), false);
    assert.doesNotMatch(read('index.html'), /settings-advanced-caret">\?\?\/span>/, 'the corrupted Advanced caret markup must stay fixed');
  });
});
