import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const css = fs.readFileSync('apps/control-center/styles.css', 'utf8');
const app = fs.readFileSync('apps/control-center/app.js', 'utf8');
const server = fs.readFileSync('apps/control-center/server.mjs', 'utf8');

test('final design system uses semantic Control Center tokens', () => {
  for (const token of ['--cc-color-canvas', '--cc-color-surface', '--cc-color-text', '--cc-color-live-bg', '--cc-color-benchmark-bg', '--cc-color-simulation-bg', '--cc-space-4', '--cc-radius-md', '--cc-shadow-focus', '--cc-table-row']) {
    assert.ok(css.includes(token), `missing ${token}`);
  }
});

test('desktop-first layout supports 1280, 1440 and 1920 class screens', () => {
  assert.ok(css.includes('grid-template-columns: 280px 1fr'));
  assert.ok(css.includes('@media (max-width: 1280px)'));
  assert.ok(css.includes('.table-wrap'));
  assert.ok(css.includes('min-width: 980px'));
});

test('accessibility basics include focus state, semantic labels and status text', () => {
  assert.ok(css.includes(':focus-visible'));
  assert.ok(css.includes('--cc-shadow-focus'));
  assert.ok(app.includes('status('));
  assert.ok(fs.readFileSync('apps/control-center/index.html', 'utf8').includes('aria-label="Admin navigation"'));
});

test('final polish includes charts, trace visualization and operational states', () => {
  for (const marker of ['chartGrid', 'Operational States', 'trace-step', 'Loading', 'No access', 'Provider unavailable', 'Partial telemetry']) {
    assert.ok(app.includes(marker) || css.includes(marker), `missing ${marker}`);
  }
});

test('privacy and security posture remain explicit after final polish', () => {
  assert.ok(app.includes('Private user content is not available in the standard admin view.'));
  assert.ok(server.includes('HttpOnly'));
  assert.ok(server.includes('SameSite=Strict'));
  assert.ok(server.includes("frame-ancestors 'none'"));
  assert.ok(server.includes('rawUserPrivateContentExposed: false'));
  assert.ok(server.includes('secretExposed: false'));
});
