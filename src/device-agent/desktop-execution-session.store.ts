// DC3-A — Desktop execution session foundation.
//
// Mirrors src/device-control/device-execution-session.store.ts's own
// ownership pattern exactly (getOwned() from the first line, mismatch
// indistinguishable from nonexistent). DC3-A only establishes this as a
// state container — no desktop action ever executes through it yet
// (that is DC3-B's job, once real UI Automation evidence exists). `mode`
// exists as state only in this slice.
import { generateResourceId, getCurrentISOString } from '../common/utils.js';
import { FileRecordStore, resolveNagexDataDir } from '../governance/file-record.store.js';

export type DesktopExecutionMode = 'BACKGROUND' | 'ASSISTED' | 'TAKEOVER';
export type DesktopExecutionSessionState = 'ACTIVE' | 'EXPIRED' | 'CLOSED';

export interface DesktopExecutionSessionRecord {
  executionSessionId: string;
  deviceId: string;
  tenantId: string;
  ownerId: string;
  mode: DesktopExecutionMode;
  state: DesktopExecutionSessionState;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

const VALID_MODES: ReadonlySet<string> = new Set<DesktopExecutionMode>(['BACKGROUND', 'ASSISTED', 'TAKEOVER']);
const VALID_STATES: ReadonlySet<string> = new Set<DesktopExecutionSessionState>(['ACTIVE', 'EXPIRED', 'CLOSED']);

export function isDesktopExecutionSessionRecord(value: unknown): value is DesktopExecutionSessionRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.executionSessionId === 'string' &&
    typeof v.deviceId === 'string' &&
    typeof v.tenantId === 'string' &&
    typeof v.ownerId === 'string' &&
    typeof v.mode === 'string' && VALID_MODES.has(v.mode) &&
    typeof v.state === 'string' && VALID_STATES.has(v.state) &&
    typeof v.createdAt === 'string' &&
    typeof v.updatedAt === 'string' &&
    typeof v.expiresAt === 'string'
  );
}

export interface CreateDesktopExecutionSessionInput {
  deviceId: string;
  tenantId: string;
  ownerId: string;
  mode: DesktopExecutionMode;
  // Caller-supplied TTL — DesktopExecutionSessionStore itself has no
  // opinion on session lifetime policy, mirroring DeviceExecutionSessionStore's
  // own separation of "store persists what it's told" from "service
  // decides bounds."
  expiresAt: string;
}

export interface DesktopExecutionSessionStoreOptions {
  dir?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => string;
}

export class DesktopExecutionSessionStore {
  private readonly fileStore: FileRecordStore<DesktopExecutionSessionRecord>;
  private readonly now: () => string;

  constructor(options: DesktopExecutionSessionStoreOptions = {}) {
    const env = options.env ?? process.env;
    const dir = options.dir ?? resolveNagexDataDir('desktop-execution-sessions', 'NAGEX_DESKTOP_SESSIONS_DIR', env);
    this.fileStore = new FileRecordStore<DesktopExecutionSessionRecord>(dir, isDesktopExecutionSessionRecord);
    this.now = options.now ?? (() => getCurrentISOString());
  }

  public create(input: CreateDesktopExecutionSessionInput): DesktopExecutionSessionRecord {
    const timestamp = this.now();
    const record: DesktopExecutionSessionRecord = {
      executionSessionId: generateResourceId('dxs'),
      deviceId: input.deviceId,
      tenantId: input.tenantId,
      ownerId: input.ownerId,
      mode: input.mode,
      state: 'ACTIVE',
      createdAt: timestamp,
      updatedAt: timestamp,
      expiresAt: input.expiresAt,
    };
    this.fileStore.writeOrThrow(record.executionSessionId, record);
    return record;
  }

  private readRaw(executionSessionId: string): DesktopExecutionSessionRecord | null {
    return this.fileStore.read(executionSessionId);
  }

  public getOwned(executionSessionId: string, tenantId: string, ownerId: string): DesktopExecutionSessionRecord | null {
    const record = this.readRaw(executionSessionId);
    if (!record || record.tenantId !== tenantId || record.ownerId !== ownerId) return null;
    return record;
  }

  private persist(record: DesktopExecutionSessionRecord): DesktopExecutionSessionRecord {
    record.updatedAt = this.now();
    this.fileStore.writeOrThrow(record.executionSessionId, record);
    return record;
  }

  public close(executionSessionId: string, tenantId: string, ownerId: string): DesktopExecutionSessionRecord | null {
    const record = this.getOwned(executionSessionId, tenantId, ownerId);
    if (!record) return null;
    record.state = 'CLOSED';
    return this.persist(record);
  }

  public expire(executionSessionId: string, tenantId: string, ownerId: string): DesktopExecutionSessionRecord | null {
    const record = this.getOwned(executionSessionId, tenantId, ownerId);
    if (!record) return null;
    record.state = 'EXPIRED';
    return this.persist(record);
  }
}
