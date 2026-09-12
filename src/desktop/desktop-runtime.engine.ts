import type { AuditLogger } from '../governance/audit.logger.js';
import type { NotificationEngine } from '../notifications/notification.engine.js';
import type { SessionStore } from '../sessions/session.store.js';
import type { TaskStore } from '../tasks/task.store.js';

export interface DesktopWindowBounds {
  width: number;
  height: number;
  position: 'bottom-right' | 'top-right' | 'center';
}

export interface DesktopWindowState {
  visible: boolean;
  minimized: boolean;
  focusedField: 'composer' | 'none';
  bounds: DesktopWindowBounds;
}

export type TrayAction =
  | 'OPEN_NAGEX'
  | 'QUICK_WAKE'
  | 'ACTIVE_TASKS'
  | 'PAUSE_AUTOMATIONS'
  | 'OPEN_CONTROL_CENTER'
  | 'SETTINGS'
  | 'QUIT';

export interface DesktopTrayItem {
  id: TrayAction;
  label: string;
  enabled: boolean;
}

export interface DesktopNotificationPayload {
  id: string;
  title: string;
  body: string;
  type: string;
  deliveredAt: string;
}

export interface DesktopRuntimeOptions {
  sessionStore: SessionStore;
  taskStore: TaskStore;
  notificationEngine?: NotificationEngine;
  auditLogger: AuditLogger;
  hotkey?: string;
}

export class DesktopRuntimeEngine {
  private windowState: DesktopWindowState = {
    visible: false,
    minimized: false,
    focusedField: 'none',
    bounds: {
      width: 420,
      height: 680,
      position: 'bottom-right',
    },
  };

  private readonly hotkey: string;
  private isTerminated = false;
  private readonly dispatchedNotifications: DesktopNotificationPayload[] = [];

  constructor(private readonly options: DesktopRuntimeOptions) {
    this.hotkey = options.hotkey || 'Alt+N';
  }

  public getHotkey(): string {
    return this.hotkey;
  }

  public getWindowState(): DesktopWindowState {
    return { ...this.windowState, bounds: { ...this.windowState.bounds } };
  }

  // ── 2. Global Hotkey Behavior (Alt+N) ────────────────────────────────────
  // - If hidden → show mini window
  // - If visible → focus composer
  // - If minimized → restore and focus composer
  // - Prevent duplicate windows (single instance state)
  public triggerGlobalHotkey(requestId = `req_hk_${Date.now()}`): DesktopWindowState {
    if (this.isTerminated) {
      throw new Error('Desktop runtime is terminated.');
    }

    if (!this.windowState.visible || this.windowState.minimized) {
      this.windowState.visible = true;
      this.windowState.minimized = false;
      this.windowState.focusedField = 'composer';
    } else {
      // Already visible and restored: focus composer
      this.windowState.focusedField = 'composer';
    }

    this.options.auditLogger.logEvent({
      actor: { type: 'user', id: 'usr_admin_001' },
      tenant_id: 'ten_production_01',
      action: 'desktop:quickwake_hotkey_triggered',
      resource: { type: 'DesktopWindow', id: 'mini_quickwake_01' },
      result: 'SUCCESS',
      request_id: requestId,
      details: { hotkey: this.hotkey, windowState: this.windowState },
    });

    return this.getWindowState();
  }

  public hideWindow(): DesktopWindowState {
    this.windowState.visible = false;
    this.windowState.focusedField = 'none';
    return this.getWindowState();
  }

  public minimizeWindow(): DesktopWindowState {
    this.windowState.minimized = true;
    this.windowState.focusedField = 'none';
    return this.getWindowState();
  }

  public restoreWindow(): DesktopWindowState {
    this.windowState.visible = true;
    this.windowState.minimized = false;
    this.windowState.focusedField = 'composer';
    return this.getWindowState();
  }

  // ── 5. System Tray & Actions ─────────────────────────────────────────────
  public getTrayMenuItems(locale: 'en' | 'ko' = 'en'): DesktopTrayItem[] {
    const isKo = locale === 'ko';
    return [
      { id: 'OPEN_NAGEX', label: isKo ? 'NAgex 열기' : 'Open NAgex', enabled: true },
      { id: 'QUICK_WAKE', label: isKo ? `Quick Wake (${this.hotkey})` : `Quick Wake (${this.hotkey})`, enabled: true },
      { id: 'ACTIVE_TASKS', label: isKo ? '실행 중인 작업' : 'Active Tasks', enabled: true },
      { id: 'PAUSE_AUTOMATIONS', label: isKo ? '자동화 일시정지' : 'Pause Automations', enabled: true },
      { id: 'OPEN_CONTROL_CENTER', label: isKo ? '컨트롤 센터 열기' : 'Open Control Center', enabled: true },
      { id: 'SETTINGS', label: isKo ? '설정' : 'Settings', enabled: true },
      { id: 'QUIT', label: isKo ? '종료' : 'Quit', enabled: true },
    ];
  }

  public handleTrayAction(action: TrayAction, requestId = `req_tray_${Date.now()}`): { action: TrayAction; status: string; result?: unknown } {
    if (this.isTerminated && action !== 'QUIT') {
      throw new Error('Desktop runtime is terminated.');
    }

    this.options.auditLogger.logEvent({
      actor: { type: 'user', id: 'usr_admin_001' },
      tenant_id: 'ten_production_01',
      action: 'desktop:tray_action_triggered',
      resource: { type: 'DesktopTray', id: 'main_tray' },
      result: 'SUCCESS',
      request_id: requestId,
      details: { action },
    });

    switch (action) {
      case 'OPEN_NAGEX':
      case 'QUICK_WAKE':
        this.triggerGlobalHotkey(requestId);
        return { action, status: 'WINDOW_SHOWN', result: this.getWindowState() };

      case 'OPEN_CONTROL_CENTER':
        this.restoreWindow();
        return { action, status: 'CONTROL_CENTER_OPENED', result: { url: '/' } };

      case 'ACTIVE_TASKS':
        this.restoreWindow();
        const activeTasks = this.options.taskStore.list('ten_production_01', 'usr_admin_001').filter((t) => t.status === 'ACTIVE' || t.status === 'RUNNING' || t.status === 'WAITING');
        return { action, status: 'TASKS_LISTED', result: activeTasks };

      case 'PAUSE_AUTOMATIONS':
        const pausedCount = this.pauseAllAutomations();
        return { action, status: 'AUTOMATIONS_PAUSED', result: { pausedCount } };

      case 'SETTINGS':
        this.restoreWindow();
        return { action, status: 'SETTINGS_OPENED', result: { tab: 'tab-settings' } };

      case 'QUIT':
        this.quitApp();
        return { action, status: 'TERMINATED' };
    }
  }

  public pauseAllAutomations(): number {
    const tasks = this.options.taskStore.list('ten_production_01', 'usr_admin_001');
    let count = 0;
    for (const t of tasks) {
      if (t.status === 'ACTIVE' || t.status === 'WAITING') {
        this.options.taskStore.pause(t.taskId, t.tenantId, t.ownerId, 'req_pause_all');
        count++;
      }
    }
    return count;
  }

  // ── 6. Background Behavior & Terminate ──────────────────────────────────
  public quitApp(): void {
    this.windowState.visible = false;
    this.windowState.minimized = false;
    this.isTerminated = true;
  }

  public isRunning(): boolean {
    return !this.isTerminated;
  }

  // ── 7. Native Desktop Notification Formatting ───────────────────────────
  public sendDesktopNotification(title: string, body: string, type = 'SYSTEM_ALERT'): DesktopNotificationPayload {
    const payload: DesktopNotificationPayload = {
      id: `notif_desk_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      title,
      body,
      type,
      deliveredAt: new Date().toISOString(),
    };

    this.dispatchedNotifications.push(payload);

    this.options.auditLogger.logEvent({
      actor: { type: 'system', id: 'desktop-runtime' },
      tenant_id: 'ten_production_01',
      action: 'desktop:notification_dispatched',
      resource: { type: 'DesktopNotification', id: payload.id },
      result: 'SUCCESS',
      request_id: `req_desk_notif_${Date.now()}`,
      details: { title, body, type },
    });

    return payload;
  }

  public dispatchNotification(opts: { type: string; title: string; body: string; metadata?: Record<string, unknown> }): DesktopNotificationPayload {
    return this.sendDesktopNotification(opts.title, opts.body, opts.type);
  }

  public getDispatchedDesktopNotifications(): DesktopNotificationPayload[] {
    return [...this.dispatchedNotifications];
  }
}
