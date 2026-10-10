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
  showCompactPopup: (payload: {
    type: 'INFO' | 'ACTIONABLE' | 'APPROVAL_REQUIRED' | 'COMPLETED' | 'ERROR' | 'NEEDS_USER';
    summary: string;
    detail?: string;
    goalId?: string;
    executionId?: string;
    approvalId?: string;
    actions?: string[];
    expiry?: string;
  }) => Promise<{ shown: boolean; nonBlocking: boolean; foregroundStealing: boolean }>;
  getNotificationHistory: () => Promise<unknown[]>;
  startVoiceCapture: () => Promise<unknown>;
  stopVoiceCapture: () => Promise<unknown>;
  getConfig: () => Promise<Record<string, unknown>>;
  updateConfig: (patch: Record<string, unknown>) => Promise<Record<string, unknown>>;
  onHotkeyTriggered: (callback: () => void) => void;
  onPushToTalkTriggered: (callback: (data: unknown) => void) => void;
  onVoiceCaptureRequested: (callback: (data: unknown) => void) => void;
  onVoiceCaptureStopRequested: (callback: () => void) => void;
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
  showCompactPopup: (payload) => ipcRenderer.invoke('desktop:show_compact_popup', payload),
  getNotificationHistory: () => ipcRenderer.invoke('desktop:get_notification_history'),
  startVoiceCapture: () => ipcRenderer.invoke('desktop:start_voice_capture'),
  stopVoiceCapture: () => ipcRenderer.invoke('desktop:stop_voice_capture'),
  getConfig: () => ipcRenderer.invoke('desktop:get_config'),
  updateConfig: (patch) => ipcRenderer.invoke('desktop:update_config', patch),
  onHotkeyTriggered: (callback) => {
    ipcRenderer.on('desktop:hotkey_triggered', () => callback());
  },
  onPushToTalkTriggered: (callback) => {
    ipcRenderer.on('desktop:push_to_talk_triggered', (_event, data) => callback(data));
  },
  onVoiceCaptureRequested: (callback) => {
    ipcRenderer.on('desktop:voice_capture_requested', (_event, data) => callback(data));
  },
  onVoiceCaptureStopRequested: (callback) => {
    ipcRenderer.on('desktop:voice_capture_stop_requested', () => callback());
  },
  onNotificationClicked: (callback) => {
    ipcRenderer.on('desktop:notification_clicked', (_event, data) => callback(data));
  },
};

contextBridge.exposeInMainWorld('NAGEX_DESKTOP', desktopBridge);
