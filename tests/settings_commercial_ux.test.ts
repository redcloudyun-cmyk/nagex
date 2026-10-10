import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const appJs = () => fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf-8');
const css = () => fs.readFileSync(path.join(process.cwd(), 'public', 'style.css'), 'utf-8');
const routes = () => fs.readFileSync(path.join(process.cwd(), 'src', 'http', 'routes', 'device-agent.routes.ts'), 'utf-8');
const store = () => fs.readFileSync(path.join(process.cwd(), 'src', 'device-agent', 'device-identity.store.ts'), 'utf-8');

test('A. canonical Settings IA is the normal Settings shell', () => {
  const src = appJs();
  for (const key of ['account', 'connections', 'devices', 'permissions', 'notifications', 'personalization', 'privacy-security', 'appearance']) {
    assert.match(src, new RegExp(`\\['${key}'`));
  }
  assert.match(src, /cat-panel-advanced/);
  assert.match(src, /cat-panel-\$\{key\}/);
});

test('B/C/N. normal Settings excludes model/autonomy/internal architecture navigation', () => {
  const shell = appJs().slice(appJs().indexOf('function ensureCommercialSettingsShell'), appJs().indexOf('async function renderSettingsDevices'));
  assert.doesNotMatch(shell, /ai-models|catAutonomy|Internal architecture|Knowledge, Approvals, Skills, and Tools|MCP|Tools|Skills/);
  assert.match(shell, /Developer Mode/);
});

test('D/E/M. devices render nickname, read-only system name, and no visible internal deviceId', () => {
  const src = appJs();
  assert.match(src, /deviceDisplayName/);
  assert.match(src, /Device name:/);
  assert.match(src, /renameSettingsDevice/);
  const renderer = src.slice(src.indexOf('function renderSettingsDeviceCard'), src.indexOf('function renderSettingsDeviceDetail'));
  assert.doesNotMatch(renderer, /device\.deviceId/);
  assert.match(store(), /nickname\?: string \| null/);
  assert.match(store(), /systemDeviceName\?: string \| null/);
});

test('F/G. device capability chips use real capability inventory without hardware specs', () => {
  const src = appJs();
  assert.match(src, /controlCapabilities/);
  assert.match(src, /settings-capability-chip/);
  assert.doesNotMatch(src, /CPU|RAM|motherboard|heartbeat ID|polling internals/);
});

test('H/I/J. settings sections use user-facing states and implemented/policy-safe wording', () => {
  const src = appJs();
  assert.match(src, /Not connected|Available/);
  assert.match(src, /Data access/);
  assert.match(src, /Action permissions/);
  assert.match(src, /Background activity/);
  assert.match(src, /Adjust how NAgex looks on this device/);
  assert.match(src, /Not implemented yet/);
});

test('K. responsive settings layout has desktop and mobile breakpoints', () => {
  const src = css();
  assert.match(src, /settings-commercial-shell/);
  assert.match(src, /@media \(max-width: 1180px\)/);
  assert.match(src, /@media \(max-width: 760px\)/);
  assert.match(src, /overflow-x: auto/);
});

test('L. KR and EN rendering path remains available in Settings', () => {
  const src = appJs();
  const i18n = fs.readFileSync(path.join(process.cwd(), 'public', 'i18n.js'), 'utf-8');
  assert.match(src, /English/);
  assert.match(src, /Korean/);
  assert.match(i18n, /settings\.catAccount/);
});

test('device endpoint supports real device list and nickname persistence', () => {
  const src = routes();
  assert.match(src, /\/api\/v1\/device-agent\/devices/);
  assert.match(src, /\/nickname/);
  assert.match(src, /projectDeviceForSettings/);
});

test('production Account settings omit password and Personal AI space from normal UI', () => {
  const shell = appJs().slice(appJs().indexOf('function ensureCommercialSettingsShell'), appJs().indexOf('async function renderSettingsDevices'));
  assert.doesNotMatch(shell, /Password|Personal AI space/);
  assert.match(shell, /Google/);
  assert.match(shell, /Microsoft/);
});

test('communication provider statuses are visible in Connections', () => {
  const shell = appJs().slice(appJs().indexOf('function renderSettingsConnections'), appJs().indexOf('function renderConnectionCard'));
  assert.match(shell, /Slack · Not connected/);
  assert.match(shell, /Telegram · Not connected/);
});

test('Personalization uses Device & action preferences terminology', () => {
  const shell = appJs().slice(appJs().indexOf('function ensureCommercialSettingsShell'), appJs().indexOf('async function renderSettingsDevices'));
  assert.match(shell, /Device & action preferences/);
  assert.doesNotMatch(shell, /Preferred execution/);
});

test('Advanced is secondary, not part of normal tab array', () => {
  const shell = appJs().slice(appJs().indexOf('function ensureCommercialSettingsShell'), appJs().indexOf('async function renderSettingsDevices'));
  const navArray = shell.slice(shell.indexOf('const nav = ['), shell.indexOf('const navHtml'));
  assert.doesNotMatch(navArray, /advanced/);
  assert.match(shell, /settings-advanced-link/);
});
