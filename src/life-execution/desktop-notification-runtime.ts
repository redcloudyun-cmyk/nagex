export type DesktopPopupType = 'INFO' | 'ACTIONABLE' | 'APPROVAL_REQUIRED' | 'COMPLETED' | 'ERROR' | 'NEEDS_USER';
export type DesktopNotificationStatus = 'VISIBLE' | 'AUTO_DISMISSED' | 'DISMISSED' | 'PERSISTED' | 'RESOLVED';

export interface DesktopPopup {
  readonly popupId: string;
  readonly goalId: string;
  readonly executionId: string;
  readonly type: DesktopPopupType;
  readonly summary: string;
  readonly visibleSeconds: number;
  readonly nonBlocking: true;
  readonly foregroundStealing: false;
  readonly approvalId?: string;
  readonly sensitiveDetailsRedacted: boolean;
}

export interface DesktopNotificationRecord {
  readonly notificationId: string;
  readonly timestamp: string;
  readonly goalId: string;
  readonly executionId: string;
  readonly type: DesktopPopupType;
  readonly summary: string;
  readonly status: DesktopNotificationStatus;
  readonly actions: readonly string[];
  readonly approvalId?: string;
  readonly approvalStatus?: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';
  readonly expiry?: string;
}

export class DesktopNotificationCenter {
  private readonly records = new Map<string, DesktopNotificationRecord>();

  persist(record: DesktopNotificationRecord): DesktopNotificationRecord {
    this.records.set(record.notificationId, record);
    return record;
  }

  get(notificationId: string): DesktopNotificationRecord | undefined {
    return this.records.get(notificationId);
  }

  all(): readonly DesktopNotificationRecord[] {
    return [...this.records.values()];
  }
}

export class DesktopCompactPopupRuntime {
  constructor(private readonly center: DesktopNotificationCenter) {}

  show(input: Omit<DesktopPopup, 'visibleSeconds' | 'nonBlocking' | 'foregroundStealing'> & { readonly visibleSeconds?: number }): DesktopPopup {
    const popup: DesktopPopup = {
      ...input,
      visibleSeconds: input.visibleSeconds ?? this.defaultDuration(input.type),
      nonBlocking: true,
      foregroundStealing: false,
    };
    this.center.persist({
      notificationId: `notification-${popup.popupId}`,
      timestamp: new Date(0).toISOString(),
      goalId: popup.goalId,
      executionId: popup.executionId,
      type: popup.type,
      summary: popup.sensitiveDetailsRedacted ? 'NAgex confirmation required.' : popup.summary,
      status: 'VISIBLE',
      actions: this.actionsFor(popup.type),
      approvalId: popup.approvalId,
      approvalStatus: popup.type === 'APPROVAL_REQUIRED' ? 'PENDING' : undefined,
    });
    return popup;
  }

  autoDismiss(popup: DesktopPopup): DesktopNotificationRecord {
    const existing = this.center.get(`notification-${popup.popupId}`);
    const record: DesktopNotificationRecord = {
      notificationId: `notification-${popup.popupId}`,
      timestamp: existing?.timestamp ?? new Date(0).toISOString(),
      goalId: popup.goalId,
      executionId: popup.executionId,
      type: popup.type,
      summary: existing?.summary ?? popup.summary,
      status: popup.type === 'INFO' || popup.type === 'COMPLETED' ? 'AUTO_DISMISSED' : 'PERSISTED',
      actions: existing?.actions ?? this.actionsFor(popup.type),
      approvalId: popup.approvalId,
      approvalStatus: popup.type === 'APPROVAL_REQUIRED' ? 'PENDING' : existing?.approvalStatus,
    };
    return this.center.persist(record);
  }

  close(popup: DesktopPopup): DesktopNotificationRecord {
    const existing = this.center.get(`notification-${popup.popupId}`);
    const record: DesktopNotificationRecord = {
      notificationId: `notification-${popup.popupId}`,
      timestamp: existing?.timestamp ?? new Date(0).toISOString(),
      goalId: popup.goalId,
      executionId: popup.executionId,
      type: popup.type,
      summary: existing?.summary ?? popup.summary,
      status: popup.type === 'APPROVAL_REQUIRED' ? 'PERSISTED' : 'DISMISSED',
      actions: existing?.actions ?? this.actionsFor(popup.type),
      approvalId: popup.approvalId,
      approvalStatus: popup.type === 'APPROVAL_REQUIRED' ? 'PENDING' : existing?.approvalStatus,
    };
    return this.center.persist(record);
  }

  private defaultDuration(type: DesktopPopupType): number {
    if (type === 'INFO') return 10;
    return 30;
  }

  private actionsFor(type: DesktopPopupType): readonly string[] {
    if (type === 'APPROVAL_REQUIRED') return ['approve', 'reject', 'details'];
    if (type === 'ACTIONABLE' || type === 'NEEDS_USER') return ['open', 'dismiss'];
    return ['dismiss'];
  }
}
