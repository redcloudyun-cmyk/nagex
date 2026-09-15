import { app, BrowserWindow, globalShortcut, Tray, Menu, Notification, shell, ipcMain, screen, safeStorage, powerMonitor } from 'electron';
import path from 'node:path';
import os from 'node:os';
import { DesktopConfigStore } from './desktop-config.store.js';
import { LocalDeviceCredentialStore, PlaintextLocalStorageFallback, type LocalSecureStorage } from '../device-agent/local-device-credential.store.js';
import { LocalDeviceAgentRuntime, type LocalDeviceAgentConnectionState } from '../device-agent/local-device-agent-runtime.js';
import { resolveExistingPublicAsset } from './asset-path.resolver.js';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let configStore: DesktopConfigStore;
// DC3-B1-R1 — at most one active LocalDeviceAgentClient per running
// desktop host: exactly one module-level instance, constructed once in
// app.whenReady(); start() is itself idempotent as a second layer of
// protection against accidental double-construction.
let deviceAgentRuntime: LocalDeviceAgentRuntime | null = null;
let deviceAgentState: LocalDeviceAgentConnectionState = 'UNENROLLED';

// Enforce single instance lock at the OS level
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  console.log('[NAgex Desktop] Another instance is already running. Exiting.');
  app.quit();
  process.exit(0);
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send('desktop:hotkey_triggered');
  }
});

// DC3-B1-R1-R1 — the real bug: `await import('../server_web.js')` only
// ever evaluates that module. server_web.ts's actual `server.listen(...)`
// call lives inside an `if (require.main === module)` guard, which is
// FALSE when the module is imported as a dependency (as it is here) —
// meaning the import always "succeeded" while nothing was ever listening,
// producing a false-ready state and the observed ERR_CONNECTION_REFUSED.
// Fixed by calling the module's own exported, genuinely-awaitable
// startNagexServer() (GATEWAY_PROMISE_RESOLVES_AFTER_LISTEN=YES — see
// server_web.ts's own lifecycle 'http-server' hook, whose start() promise
// only resolves inside server.listen()'s real callback) instead of relying
// on module-evaluation side effects.
async function startWebServerIfNeeded(): Promise<{ gatewayUrl: string; ready: boolean }> {
  const port = Number(process.env.PORT || 8085);
  const gatewayUrl = `http://localhost:${port}`;

  try {
    const res = await fetch(`${gatewayUrl}/api/v1/health`);
    if (res.ok) {
      console.log(`[NAgex Desktop] Gateway server is already running at ${gatewayUrl}`);
      return { gatewayUrl, ready: true };
    }
  } catch {
    // Not reachable yet — fall through to start it below. This is the
    // expected first-launch path, not a failure.
  }

  console.log(`[NAgex Desktop] Starting embedded NAgex Gateway on port ${port}...`);
  try {
    const { startNagexServer } = await import('../server_web.js');
    await startNagexServer(); // GATEWAY_LISTEN_ERROR_PROPAGATES=YES: a real bind/startup failure throws here, caught below — never silently swallowed.
    console.log(`[NAgex Desktop] Embedded NAgex Gateway is listening at ${gatewayUrl}`);
    return { gatewayUrl, ready: true };
  } catch (err) {
    console.error('[NAgex Desktop] Failed to start embedded Gateway server:', err);
    return { gatewayUrl, ready: false };
  }
}

function calculateInitialBounds(storedBounds?: { x?: number; y?: number; width: number; height: number }) {
  const width = storedBounds?.width || 420;
  const height = storedBounds?.height || 680;

  if (storedBounds?.x !== undefined && storedBounds?.y !== undefined) {
    return { x: storedBounds.x, y: storedBounds.y, width, height };
  }

  const primaryDisplay = screen.getPrimaryDisplay();
  const { workArea } = primaryDisplay;

  // Default position: bottom-right of primary display work area, respecting Windows taskbar
  const x = workArea.x + workArea.width - width - 16;
  const y = workArea.y + workArea.height - height - 16;

  return { x, y, width, height };
}

function windowIconPath(): string | undefined {
  return resolveExistingPublicAsset({ appPath: app.getAppPath(), isPackaged: app.isPackaged }, ['assets/favicon.png']) ?? undefined;
}

// DC3-B1-R1-R1 — `gatewayReady` makes the window creation path itself
// truthful about the gateway's real state (Section 2/3): when the
// embedded gateway failed to start, this never attempts to load the real
// Quick Wake URL (which would just reproduce ERR_CONNECTION_REFUSED) —
// it loads a small inline, honest error page instead, and "ready" is
// never logged for a page that never actually loaded.
async function createWindow(gatewayUrl: string, gatewayReady: boolean): Promise<void> {
  configStore = new DesktopConfigStore();
  const config = configStore.get();
  const bounds = calculateInitialBounds(config.windowBounds);

  const preloadPath = path.join(__dirname, 'preload.js');

  mainWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    minWidth: 380,
    minHeight: 500,
    frame: false,
    transparent: false,
    resizable: true,
    alwaysOnTop: config.alwaysOnTop,
    show: false,
    skipTaskbar: false,
    icon: windowIconPath(),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Save bounds on resize/move
  const saveBounds = () => {
    if (!mainWindow) return;
    const currentBounds = mainWindow.getBounds();
    configStore.update({ windowBounds: currentBounds });
  };
  mainWindow.on('resized', saveBounds);
  mainWindow.on('moved', saveBounds);

  // Window close button hides to tray instead of quitting process
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  if (!gatewayReady) {
    console.error('[NAgex Desktop] Embedded Gateway did not start — showing a truthful error state instead of a broken Quick Wake load.');
    await mainWindow.loadURL(
      'data:text/html,' + encodeURIComponent('<html><body style="font-family:sans-serif;padding:24px;"><h3>NAgex Gateway failed to start</h3><p>Quick Wake could not load. Check the desktop app logs.</p></body></html>'),
    );
    return;
  }

  const targetUrl = `${gatewayUrl}/quickwake`;
  try {
    // QUICKWAKE_READY_ONLY_AFTER_SUCCESSFUL_LOAD — the truthful "ready"
    // log only fires once loadURL's own promise actually resolves, never
    // merely because the window object exists or is about to show.
    await mainWindow.loadURL(targetUrl);
    console.log('[NAgex Desktop] Quick Wake window ready.');
  } catch (err) {
    // QUICKWAKE_LOAD_FAILURE_CAUGHT — explicitly caught, never an
    // unhandled rejection, and never logged as "ready."
    console.error('[NAgex Desktop] Quick Wake page failed to load:', err);
  }
}

function registerGlobalHotkey() {
  const config = configStore.get();
  const hotkey = config.hotkey || 'Alt+N';

  try {
    globalShortcut.unregisterAll();
    const registered = globalShortcut.register(hotkey, () => {
      if (!mainWindow) return;
      if (!mainWindow.isVisible() || mainWindow.isMinimized()) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      } else {
        mainWindow.focus();
      }
      mainWindow.webContents.send('desktop:hotkey_triggered');
    });

    if (registered) {
      console.log(`[NAgex Desktop] OS Global Hotkey (${hotkey}) registered successfully.`);
    } else {
      console.warn(`[NAgex Desktop] Failed to register OS Global Hotkey (${hotkey}).`);
    }
  } catch (err) {
    console.error(`[NAgex Desktop] Error registering global hotkey ${hotkey}:`, err);
  }
}

// DC3-B1-R1 — truthful, minimal local status label. Reuses the existing
// Tray primitive only (Section 10) — no new IPC/renderer surface, and
// deliberately never says anything resembling "NAgex is controlling this
// device": no control occurs in this slice.
function deviceAgentTrayLabel(state: LocalDeviceAgentConnectionState): string {
  switch (state) {
    case 'UNENROLLED':
      return 'Device Agent: Enrollment required';
    case 'CONNECTING':
      return 'Device Agent: Connecting…';
    case 'AUTHENTICATED':
      return 'Device Agent: Connected';
    case 'DISCONNECTED':
      return 'Device Agent: Disconnected';
    case 'DEGRADED':
      return 'Device Agent: Connection degraded';
    case 'REVOKED':
      return 'Device Agent: Revoked';
  }
}

function rebuildTrayMenu(gatewayUrl: string): void {
  if (!tray) return;
  const contextMenu = Menu.buildFromTemplate([
    { label: deviceAgentTrayLabel(deviceAgentState), enabled: false },
    { type: 'separator' },
    {
      label: 'Open NAgex Quick Wake',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    {
      label: 'Quick Wake (Alt+N)',
      click: () => {
        if (mainWindow) {
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.show();
          mainWindow.focus();
          mainWindow.webContents.send('desktop:hotkey_triggered');
        }
      },
    },
    {
      label: 'Active Tasks',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
          mainWindow.webContents.send('desktop:tray_action', 'ACTIVE_TASKS');
        }
      },
    },
    {
      label: 'Pause Automations',
      click: async () => {
        try {
          await fetch(`${gatewayUrl}/api/v1/desktop/quickwake/tray/action`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'PAUSE_AUTOMATIONS' }),
          });
        } catch (err) {
          console.error('[NAgex Desktop] Failed to pause automations from tray:', err);
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Open Control Center',
      click: () => {
        shell.openExternal(`${gatewayUrl}/`);
      },
    },
    {
      label: 'Settings',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
          mainWindow.webContents.send('desktop:tray_action', 'SETTINGS');
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
}

// TRAY_SETUP_FAILURE_CAUGHT — never throws uncaught. An unresolvable icon
// or a Tray-construction failure (Electron's Tray constructor throws for
// a missing/invalid icon file) is logged truthfully and the desktop app
// continues without a tray, rather than producing an unhandled rejection
// that could crash or destabilize the main process.
function setupTrayIcon(gatewayUrl: string): void {
  const iconPath = resolveExistingPublicAsset(
    { appPath: app.getAppPath(), isPackaged: app.isPackaged },
    ['assets/favicon.png', 'assets/nagex-app-icon.png'],
  );
  if (!iconPath) {
    console.error('[NAgex Desktop] No tray icon asset could be resolved — continuing without a system tray icon.');
    return;
  }

  try {
    tray = new Tray(iconPath);
  } catch (err) {
    console.error('[NAgex Desktop] Failed to create the system tray icon:', err);
    tray = null;
    return;
  }

  tray.setToolTip('NAgex Quick Wake (Alt+N)');
  rebuildTrayMenu(gatewayUrl);
  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function setupIpcHandlers(gatewayUrl: string) {
  ipcMain.handle('desktop:show', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  ipcMain.handle('desktop:hide', () => {
    mainWindow?.hide();
  });

  ipcMain.handle('desktop:toggle', () => {
    if (!mainWindow) return;
    if (!mainWindow.isVisible() || mainWindow.isMinimized()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    } else {
      mainWindow.hide();
    }
  });

  ipcMain.handle('desktop:focus_composer', () => {
    mainWindow?.focus();
    mainWindow?.webContents.send('desktop:hotkey_triggered');
  });

  ipcMain.handle('desktop:open_external', (_event, url: string) => {
    if (typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'))) {
      shell.openExternal(url);
    }
  });

  ipcMain.handle('desktop:tray_action', (_event, action: string) => {
    if (action === 'OPEN_CONTROL_CENTER') {
      shell.openExternal(`${gatewayUrl}/`);
    } else if (action === 'QUIT') {
      isQuitting = true;
      app.quit();
    }
  });

  ipcMain.handle('desktop:send_notification', (_event, payload: { title: string; body: string; type?: string }) => {
    if (Notification.isSupported()) {
      const notif = new Notification({
        title: payload.title || 'NAgex Notification',
        body: payload.body || '',
        icon: windowIconPath(),
      });
      notif.on('click', () => {
        if (mainWindow) {
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.show();
          mainWindow.focus();
          mainWindow.webContents.send('desktop:notification_clicked', payload);
        }
      });
      notif.show();
    }
  });

  ipcMain.handle('desktop:get_config', () => {
    return configStore.get();
  });

  ipcMain.handle('desktop:update_config', (_event, patch: Record<string, unknown>) => {
    const updated = configStore.update(patch as any);
    if (patch.alwaysOnTop !== undefined && mainWindow) {
      mainWindow.setAlwaysOnTop(Boolean(patch.alwaysOnTop));
    }
    if (patch.openAtLogin !== undefined) {
      app.setLoginItemSettings({ openAtLogin: Boolean(patch.openAtLogin) });
    }
    if (patch.hotkey !== undefined) {
      registerGlobalHotkey();
    }
    return updated;
  });
}

// DC3-B1-R1 — real OS-protected storage when available (safeStorage,
// backed by Windows DPAPI/Credential Manager); the disclosed plaintext
// fallback (0600 file, no real encryption) only when the platform genuinely
// has none configured — never silently claimed as encrypted otherwise.
//
// DC3-B1-R1-R1 — logs exactly two non-secret diagnostic values
// (SAFE_STORAGE_AVAILABLE, CREDENTIAL_STORAGE_MODE) so real Windows
// acceptance can be confirmed from the process's own log output. Never
// logs the key, the encrypted bytes, or any credential content.
function buildLocalSecureStorage(): LocalSecureStorage {
  const available = safeStorage.isEncryptionAvailable();
  const mode = available ? 'SAFE_STORAGE' : 'PLAINTEXT_FALLBACK';
  console.log(JSON.stringify({ event: 'nagex_device_credential_storage_mode', SAFE_STORAGE_AVAILABLE: available ? 'YES' : 'NO', CREDENTIAL_STORAGE_MODE: mode }));
  if (available) {
    return {
      isAvailable: () => true,
      encrypt: (plainText: string) => safeStorage.encryptString(plainText),
      decrypt: (cipherBuffer: Buffer) => safeStorage.decryptString(cipherBuffer),
    };
  }
  console.warn('[NAgex Desktop] OS-protected credential storage is unavailable on this machine — falling back to a permission-restricted, unencrypted local file for the device credential.');
  return new PlaintextLocalStorageFallback();
}

app.whenReady().then(async () => {
  const { gatewayUrl, ready } = await startWebServerIfNeeded();
  await createWindow(gatewayUrl, ready);
  registerGlobalHotkey();
  setupTrayIcon(gatewayUrl);
  setupIpcHandlers(gatewayUrl);

  const config = configStore.get();
  app.setLoginItemSettings({ openAtLogin: config.openAtLogin });

  // DC3-B1-R1 — construct and start the one Local Device Agent runtime
  // for this process. No hardcoded usr_admin_001/ten_production_01 here —
  // identity comes only from the local enrolled credential, if one
  // exists; if not, the runtime reports UNENROLLED and the desktop shell
  // continues normally (no fallback identity is ever fabricated).
  const credentialPath = path.join(os.homedir(), '.nagex', 'desktop', 'device-credential.enc');
  const credentialStore = new LocalDeviceCredentialStore(credentialPath, buildLocalSecureStorage());
  deviceAgentRuntime = new LocalDeviceAgentRuntime({
    credentialStore,
    serverBaseUrl: gatewayUrl,
    agentVersion: app.getVersion(),
    onStateChange: (state) => {
      deviceAgentState = state;
      rebuildTrayMenu(gatewayUrl);
    },
  });
  await deviceAgentRuntime.start();

  // Section 7/8 — never assume a connection survives sleep or a session
  // boundary; every one of these fails safe (disconnect now) rather than
  // letting a stale timer fire into a suspended/locked state.
  powerMonitor.on('suspend', () => {
    void deviceAgentRuntime?.suspend();
  });
  powerMonitor.on('resume', () => {
    void deviceAgentRuntime?.resume();
  });
  powerMonitor.on('lock-screen', () => {
    void deviceAgentRuntime?.onSessionLock();
  });
}).catch((err) => {
  // NO_UNHANDLED_PROMISE_REJECTION_PATH — the final backstop: every
  // individual failure mode above (gateway startup, Quick Wake load, tray
  // setup) is already caught and surfaced truthfully at its own call
  // site, but this ensures nothing thrown anywhere in this startup chain
  // can ever surface as an UnhandledPromiseRejectionWarning.
  console.error('[NAgex Desktop] Fatal error during startup:', err);
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  // Clears the heartbeat timer synchronously (before any async disconnect
  // call, win or lose) — Section 6's "no hanging process because of
  // transport timers" holds even if the process exits before the
  // best-effort disconnect message completes.
  void deviceAgentRuntime?.stop();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && isQuitting) {
    app.quit();
  }
});
