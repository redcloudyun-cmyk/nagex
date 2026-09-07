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

// One stable session per (tenant, principal, type) — in particular, exactly
// one MAIN session per user, persisted so it survives a restart and so
// every entry point resolves to the same session, memory, and task history
// rather than minting a new one on every request.
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
      this.records.set(this.key(record.tenantId, record.principalId, record.type), record);
    }
  }

  private key(tenantId: string, principalId: string, type: SessionType): string {
    return `${tenantId}::${principalId}::${type}`;
  }

  public getOrCreateMain(tenantId: string, principalId: string): SessionRecord {
    return this.getOrCreate(tenantId, principalId, 'MAIN');
  }

  public getOrCreate(tenantId: string, principalId: string, type: SessionType): SessionRecord {
    const key = this.key(tenantId, principalId, type);
    const existing = this.records.get(key);
    if (existing) {
      existing.lastActiveAt = this.now();
      this.fileStore.write(existing.sessionId, existing);
      return existing;
    }
    const record: SessionRecord = {
      sessionId: generateResourceId('sess'),
      tenantId,
      principalId,
      type,
      createdAt: this.now(),
      lastActiveAt: this.now(),
    };
    this.records.set(key, record);
    this.fileStore.write(record.sessionId, record);
    return record;
  }
}
