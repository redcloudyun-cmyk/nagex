import { app, BrowserWindow, globalShortcut, Tray, Menu, Notification, shell, ipcMain, screen, safeStorage, powerMonitor } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { DesktopConfigStore } from './desktop-config.store.js';
import { LocalDeviceCredentialStore, PlaintextLocalStorageFallback, type LocalSecureStorage } from '../device-agent/local-device-credential.store.js';
import { LocalDeviceAgentRuntime, type LocalDeviceAgentConnectionState } from '../device-agent/local-device-agent-runtime.js';

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

async function startWebServerIfNeeded(): Promise<string> {
  const port = Number(process.env.PORT || 8085);
  const gatewayUrl = `http://localhost:${port}`;

  try {
    const res = await fetch(`${gatewayUrl}/api/v1/health`);
    if (res.ok) {
      console.log(`[NAgex Desktop] Gateway server is already running at ${gatewayUrl}`);
      return gatewayUrl;
    }
  } catch {
    // Gateway server not running yet; import and start server_web dynamically
    console.log(`[NAgex Desktop] Starting embedded NAgex Gateway on port ${port}...`);
    try {
      await import('../server_web.js');
    } catch (err) {
      console.error('[NAgex Desktop] Failed to start embedded Gateway server:', err);
    }
  }
  return gatewayUrl;
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

function createWindow(gatewayUrl: string) {
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
    icon: path.join(__dirname, '../../public/assets/favicon.png'),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const targetUrl = `${gatewayUrl}/quickwake`;
  mainWindow.loadURL(targetUrl);

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

  mainWindow.once('ready-to-show', () => {
    // Hidden initially until global hotkey Alt+N or explicit user trigger
    console.log('[NAgex Desktop] Quick Wake window ready.');
  });
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

function setupTrayIcon(gatewayUrl: string) {
  const iconPath = path.join(__dirname, '../../public/assets/favicon.png');
  const fallbackIcon = fs.existsSync(iconPath) ? iconPath : path.join(__dirname, '../../public/assets/nagex-app-icon.png');

  tray = new Tray(fallbackIcon);
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
        icon: path.join(__dirname, '../../public/assets/favicon.png'),
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
function buildLocalSecureStorage(): LocalSecureStorage {
  if (safeStorage.isEncryptionAvailable()) {
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
  const gatewayUrl = await startWebServerIfNeeded();
  createWindow(gatewayUrl);
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
