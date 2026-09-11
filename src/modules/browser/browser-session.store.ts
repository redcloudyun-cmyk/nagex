import { generateResourceId } from '../../common/utils.js';
import { FileRecordStore, resolveNagexDataDir } from '../../governance/file-record.store.js';

// Browser Agent MVP session model (MASTER.md Section 14.5 item 06, spec
// item 8). One session per owner is enforced here for the MVP (item 14) —
// mirrors SessionStore's "exactly one MAIN session per (tenant, principal)"
// pattern exactly.
export type BrowserSessionStatus = 'OPEN' | 'BLOCKED_NEEDS_HUMAN' | 'CLOSED';

export interface BrowserSessionRecord {
  browserSessionId: string;
  tenantId: string;
  ownerId: string;
  status: BrowserSessionStatus;
  currentUrl: string | null;
  createdAt: string;
  lastActiveAt: string;
}

export function isBrowserSessionRecord(value: unknown): value is BrowserSessionRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.browserSessionId === 'string' &&
    typeof v.tenantId === 'string' &&
    typeof v.ownerId === 'string' &&
    typeof v.status === 'string' &&
    (v.currentUrl === null || typeof v.currentUrl === 'string') &&
    typeof v.createdAt === 'string' &&
    typeof v.lastActiveAt === 'string'
  );
}

export interface BrowserSessionStoreOptions {
  dir?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => string;
}

export class BrowserSessionStore {
  private readonly records = new Map<string, BrowserSessionRecord>();
  private readonly fileStore: FileRecordStore<BrowserSessionRecord>;
  private readonly now: () => string;

  constructor(options: BrowserSessionStoreOptions = {}) {
    const env = options.env ?? process.env;
    const dir = options.dir ?? resolveNagexDataDir('browser-sessions', 'NAGEX_BROWSER_SESSIONS_DIR', env);
    this.fileStore = new FileRecordStore<BrowserSessionRecord>(dir, isBrowserSessionRecord);
    this.now = options.now ?? (() => new Date().toISOString());
    for (const record of this.fileStore.readAll()) {
      this.records.set(this.key(record.tenantId, record.ownerId), record);
    }
  }

  private key(tenantId: string, ownerId: string): string {
    return `${tenantId}::${ownerId}`;
  }

  public getOrCreate(tenantId: string, ownerId: string): BrowserSessionRecord {
    const key = this.key(tenantId, ownerId);
    const existing = this.records.get(key);
    if (existing && existing.status !== 'CLOSED') {
      existing.lastActiveAt = this.now();
      this.fileStore.write(existing.browserSessionId, existing);
      return existing;
    }
    const record: BrowserSessionRecord = {
      browserSessionId: generateResourceId('brw'),
      tenantId,
      ownerId,
      status: 'OPEN',
      currentUrl: null,
      createdAt: this.now(),
      lastActiveAt: this.now(),
    };
    this.records.set(key, record);
    this.fileStore.write(record.browserSessionId, record);
    return record;
  }

  public get(browserSessionId: string): BrowserSessionRecord | undefined {
    for (const record of this.records.values()) {
      if (record.browserSessionId === browserSessionId) return record;
    }
    return undefined;
  }

  public updateUrl(browserSessionId: string, url: string): void {
    const record = this.get(browserSessionId);
    if (!record) return;
    record.currentUrl = url;
    record.lastActiveAt = this.now();
    this.fileStore.write(record.browserSessionId, record);
  }

  public setStatus(browserSessionId: string, status: BrowserSessionStatus): void {
    const record = this.get(browserSessionId);
    if (!record) return;
    record.status = status;
    record.lastActiveAt = this.now();
    this.fileStore.write(record.browserSessionId, record);
  }

  public close(browserSessionId: string): void {
    this.setStatus(browserSessionId, 'CLOSED');
  }
}

export const browserSessionStore = new BrowserSessionStore();
export const generateEvidenceId = (): string => generateResourceId('bev');
