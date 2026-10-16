import { getCurrentISOString } from '../common/utils.js';
import { FileRecordStore, resolveNagexDataDir } from '../governance/file-record.store.js';

export type DeviceCommandStage = 'QUEUED' | 'DELIVERED' | 'CLAIMED' | 'WAITING_FOR_PRECONDITION' | 'EXECUTING' | 'COMPLETED' | 'FAILED';

export interface DeviceCommandStatusRecord {
  commandId: string;
  tenantId: string;
  ownerId: string;
  deviceId: string;
  executionId: string | null;
  stage: DeviceCommandStage;
  deliveredAt: string | null;
  claimedAt: string | null;
  executingAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  resultCode: string | null;
  /** what the device reports it saw and did, bounded and flat (see sanitizeCommandEvidence); never the content of a person's documents */
  evidence?: Record<string, unknown> | null;
  updatedAt: string;
}

const MAX_EVIDENCE_BYTES = 4096;
const MAX_EVIDENCE_KEYS = 24;
const MAX_EVIDENCE_STRING = 200;

/** Evidence arrives from a device: only plain, small, flat facts are kept (strings, numbers, booleans, and short lists of those); anything else is dropped. */
export function sanitizeCommandEvidence(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>).slice(0, MAX_EVIDENCE_KEYS)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(key)) continue;
    if (typeof raw === 'string') out[key] = raw.slice(0, MAX_EVIDENCE_STRING);
    else if (typeof raw === 'number' && Number.isFinite(raw)) out[key] = raw;
    else if (typeof raw === 'boolean') out[key] = raw;
    else if (Array.isArray(raw)) out[key] = raw.slice(0, 16).filter((item) => typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean').map((item) => (typeof item === 'string' ? item.slice(0, MAX_EVIDENCE_STRING) : item));
  }
  return Buffer.byteLength(JSON.stringify(out), 'utf8') <= MAX_EVIDENCE_BYTES ? out : null;
}

function isDeviceCommandStatusRecord(value: unknown): value is DeviceCommandStatusRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.commandId === 'string' &&
    typeof v.tenantId === 'string' &&
    typeof v.ownerId === 'string' &&
    typeof v.deviceId === 'string' &&
    (v.executionId === null || typeof v.executionId === 'string') &&
    typeof v.stage === 'string' &&
    (v.deliveredAt === null || typeof v.deliveredAt === 'string') &&
    (v.claimedAt === null || typeof v.claimedAt === 'string') &&
    (v.executingAt === null || typeof v.executingAt === 'string') &&
    (v.completedAt === null || typeof v.completedAt === 'string') &&
    (v.failedAt === null || typeof v.failedAt === 'string') &&
    (v.resultCode === null || typeof v.resultCode === 'string') &&
    typeof v.updatedAt === 'string'
  );
}

export interface DeviceCommandStatusStoreOptions {
  dir?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => string;
}

export class DeviceCommandStatusStore {
  private readonly fileStore: FileRecordStore<DeviceCommandStatusRecord>;
  private readonly now: () => string;

  constructor(options: DeviceCommandStatusStoreOptions = {}) {
    const env = options.env ?? process.env;
    const dir = options.dir ?? resolveNagexDataDir('device-command-status', 'NAGEX_DEVICE_COMMAND_STATUS_DIR', env);
    this.fileStore = new FileRecordStore<DeviceCommandStatusRecord>(dir, isDeviceCommandStatusRecord);
    this.now = options.now ?? (() => getCurrentISOString());
  }

  public markQueued(input: { commandId: string; tenantId: string; ownerId: string; deviceId: string; executionId?: string | null }): DeviceCommandStatusRecord {
    const now = this.now();
    const existing = this.fileStore.read(input.commandId);
    const record: DeviceCommandStatusRecord = {
      commandId: input.commandId,
      tenantId: input.tenantId,
      ownerId: input.ownerId,
      deviceId: input.deviceId,
      executionId: input.executionId ?? existing?.executionId ?? null,
      stage: existing?.stage ?? 'QUEUED',
      deliveredAt: existing?.deliveredAt ?? null,
      claimedAt: existing?.claimedAt ?? null,
      executingAt: existing?.executingAt ?? null,
      completedAt: existing?.completedAt ?? null,
      failedAt: existing?.failedAt ?? null,
      resultCode: existing?.resultCode ?? null,
      updatedAt: now,
    };
    this.fileStore.writeOrThrow(record.commandId, record);
    return record;
  }

  public markDelivered(commandId: string, tenantId: string, ownerId: string, deviceId: string, executionId: string | null): DeviceCommandStatusRecord {
    const record = this.ensure(commandId, tenantId, ownerId, deviceId, executionId);
    if (record.stage === 'QUEUED') record.stage = 'DELIVERED';
    record.deliveredAt = record.deliveredAt ?? this.now();
    record.updatedAt = this.now();
    this.fileStore.writeOrThrow(commandId, record);
    return record;
  }

  public report(commandId: string, tenantId: string, ownerId: string, deviceId: string, stage: DeviceCommandStage, resultCode: string | null = null): DeviceCommandStatusRecord {
    const record = this.ensure(commandId, tenantId, ownerId, deviceId, null);
    const now = this.now();
    record.stage = stage;
    if (stage === 'CLAIMED') record.claimedAt = record.claimedAt ?? now;
    if (stage === 'WAITING_FOR_PRECONDITION') record.claimedAt = record.claimedAt ?? now;
    if (stage === 'EXECUTING') record.executingAt = record.executingAt ?? now;
    if (stage === 'COMPLETED') record.completedAt = record.completedAt ?? now;
    if (stage === 'FAILED') record.failedAt = record.failedAt ?? now;
    record.resultCode = resultCode ?? record.resultCode;
    record.updatedAt = now;
    this.fileStore.writeOrThrow(commandId, record);
    return record;
  }

  /** What a device reported it saw while carrying out a command the server queued as a desktop plan; sanitised (flat, small). Nothing else about the record changes. */
  public attachEvidence(commandId: string, evidence: unknown): DeviceCommandStatusRecord | null {
    const record = this.fileStore.read(commandId);
    if (!record || evidence === undefined) return record;
    record.evidence = sanitizeCommandEvidence(evidence);
    record.updatedAt = this.now();
    this.fileStore.writeOrThrow(commandId, record);
    return record;
  }

  public get(commandId: string): DeviceCommandStatusRecord | null {
    return this.fileStore.read(commandId);
  }

  public listForOwner(tenantId: string, ownerId: string): DeviceCommandStatusRecord[] {
    return this.fileStore.readAll()
      .filter((record) => record.tenantId === tenantId && record.ownerId === ownerId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  private ensure(commandId: string, tenantId: string, ownerId: string, deviceId: string, executionId: string | null): DeviceCommandStatusRecord {
    const existing = this.fileStore.read(commandId);
    if (existing) return existing;
    return {
      commandId,
      tenantId,
      ownerId,
      deviceId,
      executionId,
      stage: 'QUEUED',
      deliveredAt: null,
      claimedAt: null,
      executingAt: null,
      completedAt: null,
      failedAt: null,
      resultCode: null,
      updatedAt: this.now(),
    };
  }
}
