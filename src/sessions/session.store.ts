import { generateResourceId } from '../common/utils.js';
import { FileRecordStore, resolveNagexDataDir } from '../governance/file-record.store.js';

// MASTER.md Section 14.3 — Main Session. Only the 'web' channel is wired
// today; Telegram/Slack/Android identity linking is Phase G3/G4 and not
// implemented here. The session record itself is channel-agnostic so those
// phases can resolve into the same MAIN session without a schema change.
export type SessionType = 'MAIN' | 'DIRECT' | 'GROUP' | 'TASK' | 'AGENT' | 'BACKGROUND';

export interface SessionRecord {
  sessionId: string;
  tenantId: string;
  principalId: string;
  type: SessionType;
  createdAt: string;
  lastActiveAt: string;
  expiresAt: string;
  revokedAt: string | null;
  userAgent: string | null;
  ipAddress: string | null;
  deviceMetadata: string | null;
}

export function isSessionRecord(value: unknown): value is SessionRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.sessionId === 'string' &&
    typeof v.tenantId === 'string' &&
    typeof v.principalId === 'string' &&
    typeof v.type === 'string' &&
    typeof v.createdAt === 'string' &&
    typeof v.lastActiveAt === 'string'
  );
}

export interface SessionStoreOptions {
  dir?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => string;
}

const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export class SessionStore {
  private readonly records = new Map<string, SessionRecord>();
  private readonly fileStore: FileRecordStore<SessionRecord>;
  private readonly now: () => string;

  constructor(options: SessionStoreOptions = {}) {
    const env = options.env ?? process.env;
    const dir = options.dir ?? resolveNagexDataDir('sessions', 'NAGEX_SESSIONS_DIR', env);
    this.fileStore = new FileRecordStore<SessionRecord>(dir, isSessionRecord);
    this.now = options.now ?? (() => new Date().toISOString());
    for (const record of this.fileStore.readAll()) {
      this.records.set(record.sessionId, record);
    }
  }

  public getSession(sessionId: string): SessionRecord | null {
    const record = this.records.get(sessionId);
    if (!record) return null;
    if (record.revokedAt != null) return null; // revoked
    if (new Date(this.now()).getTime() > new Date(record.expiresAt).getTime()) return null; // expired

    // touch lastActiveAt
    record.lastActiveAt = this.now();
    this.fileStore.write(record.sessionId, record);
    return record;
  }

  public createAuthSession(
    tenantId: string,
    principalId: string,
    type: SessionType = 'MAIN',
    meta: { userAgent?: string | null; ipAddress?: string | null; deviceMetadata?: string | null; ttlMs?: number } = {}
  ): SessionRecord {
    const createdAt = this.now();
    const ttlMs = meta.ttlMs ?? DEFAULT_SESSION_TTL_MS;
    const expiresAt = new Date(new Date(createdAt).getTime() + ttlMs).toISOString();

    const record: SessionRecord = {
      sessionId: generateResourceId('sess'),
      tenantId,
      principalId,
      type,
      createdAt,
      lastActiveAt: createdAt,
      expiresAt,
      revokedAt: null,
      userAgent: meta.userAgent || null,
      ipAddress: meta.ipAddress || null,
      deviceMetadata: meta.deviceMetadata || null,
    };

    this.records.set(record.sessionId, record);
    this.fileStore.write(record.sessionId, record);
    return record;
  }

  public rotateSession(
    oldSessionId: string,
    tenantId: string,
    principalId: string,
    meta: { userAgent?: string | null; ipAddress?: string | null; deviceMetadata?: string | null } = {}
  ): SessionRecord {
    if (oldSessionId) {
      this.revokeSession(oldSessionId);
    }
    return this.createAuthSession(tenantId, principalId, 'MAIN', meta);
  }

  public revokeSession(sessionId: string): boolean {
    const record = this.records.get(sessionId);
    if (!record || record.revokedAt != null) return false;
    record.revokedAt = this.now();
    this.fileStore.write(record.sessionId, record);
    return true;
  }

  public revokeAllUserSessions(tenantId: string, principalId: string, exceptSessionId?: string): number {
    let count = 0;
    const nowIso = this.now();
    for (const record of this.records.values()) {
      if (
        record.tenantId === tenantId &&
        record.principalId === principalId &&
        record.revokedAt == null &&
        record.sessionId !== exceptSessionId
      ) {
        record.revokedAt = nowIso;
        this.fileStore.write(record.sessionId, record);
        count++;
      }
    }
    return count;
  }

  public listUserSessions(tenantId: string, principalId: string): SessionRecord[] {
    const nowIso = this.now();
    const nowMs = new Date(nowIso).getTime();
    const list: SessionRecord[] = [];

    for (const record of this.records.values()) {
      if (
        record.tenantId === tenantId &&
        record.principalId === principalId &&
        record.revokedAt == null &&
        new Date(record.expiresAt).getTime() > nowMs
      ) {
        list.push(record);
      }
    }

    return list.sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  }

  // Legacy helper compatibility
  public getOrCreateMain(tenantId: string, principalId: string): SessionRecord {
    const active = this.listUserSessions(tenantId, principalId).find((s) => s.type === 'MAIN');
    if (active) {
      active.lastActiveAt = this.now();
      this.fileStore.write(active.sessionId, active);
      return active;
    }
    return this.createAuthSession(tenantId, principalId, 'MAIN');
  }

  public getOrCreate(tenantId: string, principalId: string, type: SessionType): SessionRecord {
    const active = this.listUserSessions(tenantId, principalId).find((s) => s.type === type);
    if (active) {
      active.lastActiveAt = this.now();
      this.fileStore.write(active.sessionId, active);
      return active;
    }
    return this.createAuthSession(tenantId, principalId, type);
  }
}
