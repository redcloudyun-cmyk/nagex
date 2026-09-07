import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DesktopConfigStore, DEFAULT_DESKTOP_CONFIG } from '../src/desktop/desktop-config.store.js';
import { handleAsyncApiRequest } from '../src/server_web.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-desktop-shell-test-'));
}

test('DesktopConfigStore loads defaults, supports updates, and persists config', () => {
  const dir = tempDir();
  const store1 = new DesktopConfigStore(dir);

  const initial = store1.get();
  assert.equal(initial.hotkey, 'Alt+N');
  assert.equal(initial.alwaysOnTop, false);
  assert.equal(initial.openAtLogin, false);
  assert.equal(initial.windowBounds?.width, 420);
  assert.equal(initial.windowBounds?.height, 680);

  // Update configuration
  const updated = store1.update({
    alwaysOnTop: true,
    openAtLogin: true,
    principalId: 'usr_custom_001',
    windowBounds: { x: 100, y: 150, width: 450, height: 700 },
  });

  assert.equal(updated.alwaysOnTop, true);
  assert.equal(updated.openAtLogin, true);
  assert.equal(updated.principalId, 'usr_custom_001');
  assert.equal(updated.windowBounds?.x, 100);
  assert.equal(updated.windowBounds?.y, 150);
  assert.equal(updated.windowBounds?.width, 450);
  assert.equal(updated.windowBounds?.height, 700);

  // Verify persistence with a fresh instance pointing at same dir
  const store2 = new DesktopConfigStore(dir);
  const loaded = store2.get();

  assert.equal(loaded.alwaysOnTop, true);
  assert.equal(loaded.openAtLogin, true);
  assert.equal(loaded.principalId, 'usr_custom_001');
  assert.equal(loaded.windowBounds?.width, 450);
});

test('Native Desktop Preload Bridge definition & safe IPC contract', () => {
  const preloadPath = path.join(process.cwd(), 'src', 'desktop', 'preload.ts');
  assert.ok(fs.existsSync(preloadPath), 'preload.ts file should exist');

  const content = fs.readFileSync(preloadPath, 'utf8');
  assert.ok(content.includes('contextBridge.exposeInMainWorld'), 'Preload should expose bridge via contextBridge');
  assert.ok(content.includes('NAGEX_DESKTOP'), 'Preload should register NAGEX_DESKTOP namespace');
  assert.ok(content.includes('desktop:show'), 'Preload should contain show IPC channel');
  assert.ok(content.includes('desktop:hide'), 'Preload should contain hide IPC channel');
  assert.ok(content.includes('desktop:open_external'), 'Preload should contain open_external IPC channel');
  assert.ok(content.includes('desktop:send_notification'), 'Preload should contain send_notification IPC channel');
});

test('Desktop App Main entry module & single instance structure', () => {
  const mainAppPath = path.join(process.cwd(), 'src', 'desktop', 'desktop-app.ts');
  assert.ok(fs.existsSync(mainAppPath), 'desktop-app.ts file should exist');

  const content = fs.readFileSync(mainAppPath, 'utf8');
  assert.ok(content.includes('app.requestSingleInstanceLock()'), 'App main should enforce single instance lock');
  assert.ok(content.includes('globalShortcut.register'), 'App main should register global shortcut');
  assert.ok(content.includes('Alt+N'), 'App main should register default Alt+N hotkey');
  assert.ok(content.includes('new Tray'), 'App main should initialize system tray');
  assert.ok(content.includes('Notification.isSupported()'), 'App main should check notification support');
  assert.ok(content.includes('screen.getPrimaryDisplay()'), 'App main should position relative to primary display workArea');
});

test('Gateway API Main Session connectivity for Desktop client', async () => {
  const res = await handleAsyncApiRequest('GET', '/api/v1/sessions/main', null, {
    'x-principal-id': 'usr_admin_001',
    'x-nagex-tenant': 'ten_production_01',
  });

  assert.equal(res.status, 200);
  assert.ok((res.data as any).sessionId.startsWith('sess_'));
  assert.equal((res.data as any).type, 'MAIN');
  assert.equal((res.data as any).principalId, 'usr_admin_001');
});
