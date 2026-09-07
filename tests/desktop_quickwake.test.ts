import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DesktopRuntimeEngine } from '../src/desktop/desktop-runtime.engine.js';
import { NotificationEngine } from '../src/notifications/notification.engine.js';
import { NotificationStore } from '../src/notifications/notification.store.js';
import { SessionStore } from '../src/sessions/session.store.js';
import { TaskStore } from '../src/tasks/task.store.js';
import { AuditLogger } from '../src/governance/audit.logger.js';
import { handleAsyncApiRequest, desktopRuntimeEngine } from '../src/server_web.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-desktop-test-'));
}

test('DesktopRuntimeEngine hotkey toggle behavior (Alt+N) and single instance state', () => {
  const dir = tempDir();
  const sessionStore = new SessionStore({ dir: path.join(dir, 'sessions') });
  const taskStore = new TaskStore({ dir: path.join(dir, 'tasks') });
  const auditLogger = new AuditLogger();

  const engine = new DesktopRuntimeEngine({ sessionStore, taskStore, auditLogger });

  assert.equal(engine.getHotkey(), 'Alt+N');
  
  let state = engine.getWindowState();
  assert.equal(state.visible, false);
  assert.equal(state.bounds.width, 420);
  assert.equal(state.bounds.height, 680);
  assert.equal(state.bounds.position, 'bottom-right');

  // Trigger hotkey 1: hidden -> show & focus composer
  state = engine.triggerGlobalHotkey('req_1');
  assert.equal(state.visible, true);
  assert.equal(state.minimized, false);
  assert.equal(state.focusedField, 'composer');

  // Minimize window
  state = engine.minimizeWindow();
  assert.equal(state.minimized, true);

  // Trigger hotkey 2: minimized -> restore & focus composer
  state = engine.triggerGlobalHotkey('req_2');
  assert.equal(state.visible, true);
  assert.equal(state.minimized, false);
  assert.equal(state.focusedField, 'composer');

  // Hide window
  state = engine.hideWindow();
  assert.equal(state.visible, false);
});

test('DesktopRuntimeEngine tray actions & background vs quit behavior', () => {
  const dir = tempDir();
  const sessionStore = new SessionStore({ dir: path.join(dir, 'sessions') });
  const taskStore = new TaskStore({ dir: path.join(dir, 'tasks') });
  const auditLogger = new AuditLogger();

  const engine = new DesktopRuntimeEngine({ sessionStore, taskStore, auditLogger });

  // Tray menu localized strings
  const enItems = engine.getTrayMenuItems('en');
  const koItems = engine.getTrayMenuItems('ko');

  assert.equal(enItems.find((i) => i.id === 'OPEN_NAGEX')?.label, 'Open NAgex');
  assert.equal(koItems.find((i) => i.id === 'OPEN_NAGEX')?.label, 'NAgex 열기');
  assert.equal(enItems.find((i) => i.id === 'QUIT')?.label, 'Quit');
  assert.equal(koItems.find((i) => i.id === 'QUIT')?.label, '종료');

  // Tray OPEN_NAGEX action
  const res1 = engine.handleTrayAction('OPEN_NAGEX');
  assert.equal(res1.status, 'WINDOW_SHOWN');
  assert.equal(engine.getWindowState().visible, true);

  // Hide window (closing mini window hides it without terminating process)
  engine.hideWindow();
  assert.equal(engine.getWindowState().visible, false);
  assert.equal(engine.isRunning(), true);

  // Explicit QUIT terminates process
  const resQuit = engine.handleTrayAction('QUIT');
  assert.equal(resQuit.status, 'TERMINATED');
  assert.equal(engine.isRunning(), false);

  assert.throws(() => engine.triggerGlobalHotkey('req_after_quit'), /terminated/i);
});

test('DesktopRuntimeEngine native desktop notification dispatch via NotificationEngine', async () => {
  const dir = tempDir();
  const sessionStore = new SessionStore({ dir: path.join(dir, 'sessions') });
  const taskStore = new TaskStore({ dir: path.join(dir, 'tasks') });
  const auditLogger = new AuditLogger();
  const notificationStore = new NotificationStore({ dir: path.join(dir, 'notifications') });

  const desktopEngine = new DesktopRuntimeEngine({ sessionStore, taskStore, auditLogger });
  const notifEngine = new NotificationEngine({
    store: notificationStore,
    desktopRuntimeEngine: desktopEngine,
    auditLogger,
  });

  // Dispatch notifications of required types
  const types = ['TASK_COMPLETED', 'TASK_FAILED', 'CONDITION_MET', 'APPROVAL_REQUEST'] as const;

  for (const type of types) {
    const record = await notifEngine.dispatch({
      tenantId: 'ten_test',
      principalId: 'usr_admin_001',
      type,
      title: `Desktop Test ${type}`,
      body: `Testing native notification dispatch for ${type}`,
    });

    const desktopDelivery = record.channelDeliveries.find((d) => d.channel === 'DESKTOP');
    assert.ok(desktopDelivery, `DESKTOP delivery should exist for ${type}`);
    assert.equal(desktopDelivery.status, 'DELIVERED');
  }

  const dispatched = desktopEngine.getDispatchedDesktopNotifications();
  assert.equal(dispatched.length, 4);
  assert.equal(dispatched[0].title, 'Desktop Test TASK_COMPLETED');
});

test('Desktop Quick Wake API endpoints (status, toggle, tray action)', async () => {
  // GET status
  const statusRes = await handleAsyncApiRequest('GET', '/api/v1/desktop/quickwake/status', null, {});
  assert.equal(statusRes.status, 200);
  assert.equal((statusRes.data as any).hotkey, 'Alt+N');
  assert.ok((statusRes.data as any).windowState);

  // POST toggle
  const toggleRes = await handleAsyncApiRequest('POST', '/api/v1/desktop/quickwake/toggle', {}, {});
  assert.equal(toggleRes.status, 200);
  assert.equal((toggleRes.data as any).windowState.visible, true);

  // POST tray action
  const trayRes = await handleAsyncApiRequest('POST', '/api/v1/desktop/quickwake/tray/action', { action: 'PAUSE_AUTOMATIONS' }, {});
  assert.equal(trayRes.status, 200);
  assert.equal((trayRes.data as any).action, 'PAUSE_AUTOMATIONS');
});

test('Same Main Session verification (sess_main_001 & usr_admin_001 principal)', async () => {
  // Main session endpoint check
  const mainSessRes = await handleAsyncApiRequest('GET', '/api/v1/sessions/main', null, {
    'x-principal-id': 'usr_admin_001',
  });
  assert.equal(mainSessRes.status, 200);
  assert.ok((mainSessRes.data as any).sessionId.startsWith('sess_'));
  assert.equal((mainSessRes.data as any).type, 'MAIN');
  assert.equal((mainSessRes.data as any).principalId, 'usr_admin_001');
});

test('Desktop Quick Wake HTML/JS frontend assets accessibility', async () => {
  const htmlPath = path.join(process.cwd(), 'public', 'desktop-quickwake.html');
  const cssPath = path.join(process.cwd(), 'public', 'desktop-quickwake.css');
  const jsPath = path.join(process.cwd(), 'public', 'desktop-quickwake.js');
  const i18nPath = path.join(process.cwd(), 'public', 'i18n.js');

  assert.ok(fs.existsSync(htmlPath), 'desktop-quickwake.html should exist');
  assert.ok(fs.existsSync(cssPath), 'desktop-quickwake.css should exist');
  assert.ok(fs.existsSync(jsPath), 'desktop-quickwake.js should exist');

  const htmlContent = fs.readFileSync(htmlPath, 'utf8');
  assert.ok(htmlContent.includes('NAgex Quick Wake'), 'HTML should contain title');
  assert.ok(htmlContent.includes('sess_main_001'), 'HTML should reference Main Session');
  assert.ok(htmlContent.includes('qw-btn-voice'), 'HTML should include voice button placeholder');
  assert.ok(htmlContent.includes('qw-btn-expand'), 'HTML should include expand to Control Center button');

  const jsContent = fs.readFileSync(jsPath, 'utf8');
  assert.ok(jsContent.includes('Alt+N') || jsContent.includes('isSubmitting'), 'JS should handle Alt+N or single flight submit');
  assert.ok(jsContent.includes('/api/v1/sessions/main'), 'JS should connect to exact same Main Session');

  const i18nContent = fs.readFileSync(i18nPath, 'utf8');
  assert.ok(i18nContent.includes('desktop.title'), 'i18n.js should contain desktop.title key');
  assert.ok(i18nContent.includes('NAgex 빠른 호출'), 'i18n.js should contain Korean desktop translation');
});
