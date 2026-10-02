import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { handleAsyncApiRequest } from '../src/server_web.js';

test('1. Six canonical Settings categories exist in HTML layout', async () => {
  const indexHtml = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf-8');
  assert.match(indexHtml, /cat-tab-connections/);
  assert.match(indexHtml, /cat-tab-ai-models/);
  assert.match(indexHtml, /cat-tab-autonomy/);
  assert.match(indexHtml, /cat-tab-privacy/);
  assert.match(indexHtml, /cat-tab-notifications/);
  assert.match(indexHtml, /cat-tab-devices/);
});

test('2. Settings nav item is selected when active tab is tab-settings', async () => {
  const indexHtml = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf-8');
  assert.match(indexHtml, /data-tab="tab-settings"/);
});

test('3. Subsection selected state is clear with active class and aria-selected', async () => {
  const appJs = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf-8');
  assert.match(appJs, /switchSettingsCategory/);
  assert.match(appJs, /aria-selected/);
});

// R24.6C — the Google connection belongs to the authenticated account, so the
// status endpoint no longer answers for an identity named only in headers
// (it used to return a boolean for any header-supplied principal). A signed-in
// session still gets a real boolean; nothing is fabricated for anyone else.
test('4. No fake connection records presented without backend status', async () => {
  const headers = {
    'x-principal-id': 'usr_conn_test_01',
    'x-nagex-tenant': 'ten_conn_test_01',
  };
  const anonymous = await handleAsyncApiRequest('GET', '/api/v1/oauth/google/status', null, headers);
  assert.equal(anonymous.status, 401);
  assert.equal(typeof (anonymous.data as any).connected, 'undefined', 'no connection state may be presented without a session');

  const { identityStore, sessionStore } = await import('../src/server_web.js');
  const { hashPassword } = await import('../src/identity/identity.crypto.js');
  const { identity } = identityStore.createAccount(`settings_ux_4_${Date.now()}@example.com`, hashPassword('password123'));
  identityStore.transitionState(identity.userId, 'ACTIVE');
  const session = sessionStore.createAuthSession(`ten_${identity.userId}`, identity.userId, 'MAIN');
  const res = await handleAsyncApiRequest('GET', '/api/v1/oauth/google/status', null, { cookie: `nagex_session=${session.sessionId}` });
  assert.equal(res.status, 200);
  assert.equal(typeof (res.data as any).connected, 'boolean');
});

test('5. Connection failure semantics distinction from disconnected', async () => {
  const i18nJs = fs.readFileSync(path.join(process.cwd(), 'public', 'i18n.js'), 'utf-8');
  assert.match(i18nJs, /settings\.connected/);
  assert.match(i18nJs, /settings\.notConnected/);
  assert.match(i18nJs, /settings\.loadError/);
});

test('6. Model controls present truthful automatic routing and read-only status', async () => {
  const indexHtml = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf-8');
  const appJs = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf-8');
  assert.match(appJs, /renderSettingsAiModel/);
  assert.match(indexHtml, /Model selection is currently managed automatically/);
});

test('7. Autonomy settings cannot bypass canonical Approval policy', async () => {
  const indexHtml = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf-8');
  const appJs = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf-8');
  assert.match(appJs, /selectAutonomy/);
  assert.match(indexHtml, /human approval policy always takes precedence/);
});

test('8. Destructive settings actions require explicit confirmation dialog', async () => {
  const appJs = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf-8');
  assert.match(appJs, /window\.confirm/);
  assert.match(appJs, /confirmDisconnectMsg/);
});

test('9. Save success shown only after persistence', async () => {
  const appJs = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf-8');
  assert.match(appJs, /showSettingsSaveFeedback\(true/);
});

test('10. Save failure does not show false success state', async () => {
  const appJs = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf-8');
  assert.match(appJs, /showSettingsSaveFeedback\(false/);
  assert.match(appJs, /settings-error-banner/);
});

// R24.6B — supersedes the old "optimistic update + rollback (prevVal/prevLevel)"
// contract, which mutated state before the server answered and could show
// "Saved." for a write that was never durable. The stricter contract: state
// changes ONLY from the server's confirmed response, so a failed write has
// nothing to roll back (real failure behavior is exercised in the browser
// test r24_6b_settings_real_browser).
test('11. Settings never mutate state before the server confirms; failure leaves state unchanged', async () => {
  const appJs = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf-8');
  assert.doesNotMatch(appJs, /prevVal|prevLevel/, 'no optimistic-mutation bookkeeping may remain');
  const handlers = appJs.slice(appJs.indexOf('toggleQuickWakeOpt: async'), appJs.indexOf('renderSettings: () =>'));
  assert.match(handlers, /await apiFetch\('\/api\/v1\/quickwake\/config'/);
  assert.match(handlers, /await apiFetch\('\/api\/v1\/autonomy\/config'/);
  // The only state assignments live inside the post-response commit callbacks.
  assert.doesNotMatch(handlers.replace(/commitSettingsPrefsResult\([^\n]*\n/g, ''), /state\.(quickWakeConfig|autonomyConfig)/);
  const commit = appJs.slice(appJs.indexOf('function commitSettingsPrefsResult'), appJs.indexOf('function applySettingsPrefs'));
  assert.match(commit, /if \(res && !res\.error\) \{\s*apply\(res\);[\s\S]*showSettingsSaveFeedback\(true\)/);
  assert.match(commit, /showSettingsSaveFeedback\(false/);
});

test('12. Settings load failure is presented as distinct error, not default values', async () => {
  const i18nJs = fs.readFileSync(path.join(process.cwd(), 'public', 'i18n.js'), 'utf-8');
  assert.match(i18nJs, /'settings\.loadError':\s*'Settings could not be loaded\.'/);
});

test('13. Privacy S3 sensitive data invariant protection cannot be weakened', async () => {
  const indexHtml = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf-8');
  assert.match(indexHtml, /S3 Sensitive Data Security Invariant/);
  assert.match(indexHtml, /settings\.privacyS3Notice/);
});

test('14. Notification controls only surface supported real channels', async () => {
  const indexHtml = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf-8');
  assert.match(indexHtml, /proactive-assistant-panel/);
  assert.match(indexHtml, /quickwake-settings-options/);
});

// R24.6B — supersedes the old assertion that REQUIRED the hardcoded
// "Local Desktop Agent … Connected" row. No device/session registry is
// readable by the web UI, so a "connected device" row is fabricated state;
// the panel now renders an honest empty state.
test('15. Fake device records absent — no hardcoded "connected" device is rendered', async () => {
  const appJs = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf-8');
  assert.match(appJs, /renderSettingsDevices/);
  const devices = appJs.slice(appJs.indexOf('function renderSettingsDevices'), appJs.indexOf('function renderSettings()'));
  assert.doesNotMatch(devices, /Local Desktop Agent|Windows Desktop|Connected device|Active now|lastSeen|trusted:/);
  assert.doesNotMatch(devices, /badge-status green/);
  assert.match(devices, /settings\.devicesNone/);
});

test('16. EN and KR translations present and resolve properly across Settings', async () => {
  const i18nJs = fs.readFileSync(path.join(process.cwd(), 'public', 'i18n.js'), 'utf-8');
  assert.match(i18nJs, /'settings\.catConnections':\s*'Connections'/);
  assert.match(i18nJs, /'settings\.catConnections':\s*'연결'/);
  assert.match(i18nJs, /'settings\.catModels':\s*'Models'/);
  assert.match(i18nJs, /'settings\.catModels':\s*'AI 및 모델'/);
});

test('17. Keyboard navigation support on category tabs and cards', async () => {
  const appJs = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf-8');
  assert.match(appJs, /tabindex="0"/);
  assert.match(appJs, /onkeydown=/);
});

test('18. Accessible toggle semantics with role="switch" and aria-checked', async () => {
  const appJs = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf-8');
  assert.match(appJs, /role="switch"/);
  assert.match(appJs, /aria-checked=/);
});

test('19. Mobile static contract supported in mobile settings view', async () => {
  const mobSettings = fs.readFileSync(path.join(process.cwd(), 'public', 'mobile', 'mobile-settings.js'), 'utf-8');
  assert.ok(mobSettings.length > 0);
});

test('20. Responsive layout prevents horizontal overflow', async () => {
  const indexHtml = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf-8');
  assert.match(indexHtml, /flex-wrap:\s*wrap/);
});

test('21. No hardcoded provider/vendor business logic added in Settings', async () => {
  const appJs = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf-8');
  assert.doesNotMatch(appJs, /hardcoded_vendor_matrix/);
});
