import { FileRecordStore, resolveNagexDataDir } from '../governance/file-record.store.js';

export type NotificationType = 'APPROVAL_REQUEST' | 'TASK_COMPLETED' | 'TASK_FAILED' | 'CONDITION_MET' | 'SYSTEM_ALERT';

export type DeliveryStatus = 'PENDING' | 'DELIVERED' | 'FAILED' | 'SKIPPED';

export interface ChannelDelivery {
  channel: 'WEB' | 'TELEGRAM' | 'SLACK' | 'DESKTOP';
  status: DeliveryStatus;
  targetId?: string;
  deliveredAt?: string;
  error?: string;
}

export interface NotificationRecord {
  id: string;
  tenantId: string;
  principalId: string;
  type: NotificationType;
  title: string;
  body: string;
  read: boolean;
  channelDeliveries: ChannelDelivery[];
  metadata?: Record<string, unknown>;
  // P04 — a caller-supplied key that prevents the same logical event
  // (e.g. taskId + runId + eventType) from producing duplicate notifications
  // across restart, approval resume, or duplicate finalization triggers.
  dedupeKey?: string;
  createdAt: string;
}

export function isNotificationRecord(value: unknown): value is NotificationRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.tenantId === 'string' &&
    typeof v.principalId === 'string' &&
    typeof v.type === 'string' &&
    typeof v.title === 'string' &&
    typeof v.body === 'string' &&
    typeof v.read === 'boolean' &&
    Array.isArray(v.channelDeliveries) &&
    typeof v.createdAt === 'string'
  );
}

export interface NotificationStoreOptions {
  dir?: string;
  env?: NodeJS.ProcessEnv;
}

export class NotificationStore {
  private readonly records = new Map<string, NotificationRecord>();
  private readonly fileStore: FileRecordStore<NotificationRecord>;

  constructor(options: NotificationStoreOptions = {}) {
    const env = options.env ?? process.env;
    const dir = options.dir ?? resolveNagexDataDir('notifications', 'NAGEX_NOTIFICATIONS_DIR', env);
    this.fileStore = new FileRecordStore<NotificationRecord>(dir, isNotificationRecord);
    for (const record of this.fileStore.readAll()) {
      this.records.set(record.id, record);
    }
  }

  public save(record: NotificationRecord): NotificationRecord {
    this.records.set(record.id, record);
    this.fileStore.write(record.id, record);
    return record;
  }

  public get(id: string): NotificationRecord | undefined {
    return this.records.get(id);
  }

  public list(principalId: string, limit = 50): NotificationRecord[] {
    return [...this.records.values()]
      .filter((r) => r.principalId === principalId)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, limit);
  }

  // P04 — principal guard: the caller must own the notification to mark it
  // read.  If principalId is omitted (backward compat for internal/system
  // callers), the guard is bypassed — existing callers that don't pass it
  // continue to work identically.
  public markAsRead(id: string, principalId?: string): NotificationRecord | undefined {
    const record = this.records.get(id);
    if (!record) return undefined;
    if (principalId && record.principalId !== principalId) return undefined;
    record.read = true;
    this.fileStore.write(id, record);
    return record;
  }

  // P04 — deduplication: returns true if any record with the given
  // dedupeKey already exists.  O(n) scan is acceptable for the expected
  // notification volume (hundreds, not millions).
  public existsByDedupeKey(key: string): boolean {
    for (const record of this.records.values()) {
      if (record.dedupeKey === key) return true;
    }
    return false;
  }

  // P04 — returns the first record matching the given dedupeKey, or
  // undefined if none exists.
  public getByDedupeKey(key: string): NotificationRecord | undefined {
    for (const record of this.records.values()) {
      if (record.dedupeKey === key) return record;
    }
    return undefined;
  }

  public markAllAsRead(principalId: string): number {
    let count = 0;
    for (const record of this.records.values()) {
      if (record.principalId === principalId && !record.read) {
        record.read = true;
        this.fileStore.write(record.id, record);
        count++;
      }
    }
    return count;
  }

  public getUnreadCount(principalId: string): number {
    return [...this.records.values()].filter((r) => r.principalId === principalId && !r.read).length;
  }
}
