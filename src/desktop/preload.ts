import { contextBridge, ipcRenderer } from 'electron';

export interface DesktopBridgeApi {
  isNativeDesktop: boolean;
  showWindow: () => Promise<void>;
  hideWindow: () => Promise<void>;
  toggleWindow: () => Promise<void>;
  focusComposer: () => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  trayAction: (action: string) => Promise<unknown>;
  sendNativeNotification: (payload: { title: string; body: string; type?: string; metadata?: Record<string, unknown> }) => Promise<void>;
  getConfig: () => Promise<Record<string, unknown>>;
  updateConfig: (patch: Record<string, unknown>) => Promise<Record<string, unknown>>;
  onHotkeyTriggered: (callback: () => void) => void;
  onNotificationClicked: (callback: (data: unknown) => void) => void;
}

const desktopBridge: DesktopBridgeApi = {
  isNativeDesktop: true,
  showWindow: () => ipcRenderer.invoke('desktop:show'),
  hideWindow: () => ipcRenderer.invoke('desktop:hide'),
  toggleWindow: () => ipcRenderer.invoke('desktop:toggle'),
  focusComposer: () => ipcRenderer.invoke('desktop:focus_composer'),
  openExternal: (url: string) => ipcRenderer.invoke('desktop:open_external', url),
  trayAction: (action: string) => ipcRenderer.invoke('desktop:tray_action', action),
  sendNativeNotification: (payload) => ipcRenderer.invoke('desktop:send_notification', payload),
  getConfig: () => ipcRenderer.invoke('desktop:get_config'),
  updateConfig: (patch) => ipcRenderer.invoke('desktop:update_config', patch),
  onHotkeyTriggered: (callback) => {
    ipcRenderer.on('desktop:hotkey_triggered', () => callback());
  },
  onNotificationClicked: (callback) => {
    ipcRenderer.on('desktop:notification_clicked', (_event, data) => callback(data));
  },
};

contextBridge.exposeInMainWorld('NAGEX_DESKTOP', desktopBridge);
