// DC3-A — Device Identity foundation.
//
// A DeviceIdentityRecord is a tenant/owner-scoped record of one enrolled
// Local Device Agent — structurally identical to every other ownership-
// scoped record this codebase already has (Task/Approval/Memory/Workflow/
// BrowserSession/BrowserEvidence/DeviceExecutionSession), reusing the same
// FileRecordStore + getOwned() pattern rather than a new persistence model.
//
// The device's private key is generated ON the device and never leaves
// it — this store only ever holds the public key. deviceId is an
// identifier, never an authorization secret: a wrong tenant/owner, an
// unknown deviceId, and a revoked device are all handled by the same
// fail-closed getOwned()-style lookup DC0/DC1/DC1-R1 already established
// — a mismatch is indistinguishable from "does not exist."
import { generateResourceId, getCurrentISOString } from '../common/utils.js';
import { FileRecordStore, resolveNagexDataDir } from '../governance/file-record.store.js';

export type DeviceStatus = 'ACTIVE' | 'REVOKED';

export interface DeviceIdentityRecord {
  deviceId: string;
  tenantId: string;
  ownerId: string;
  // SPKI/PEM-encoded public key — the device's own asymmetric keypair is
  // generated locally; only the public half is ever persisted here.
  publicKey: string;
  agentVersion: string;
  capabilityInventory: string[];
  status: DeviceStatus;
  enrolledAt: string;
  lastSeenAt: string;
}

const VALID_STATUSES: ReadonlySet<string> = new Set<DeviceStatus>(['ACTIVE', 'REVOKED']);

export function isDeviceIdentityRecord(value: unknown): value is DeviceIdentityRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.deviceId === 'string' &&
    typeof v.tenantId === 'string' &&
    typeof v.ownerId === 'string' &&
    typeof v.publicKey === 'string' &&
    typeof v.agentVersion === 'string' &&
    Array.isArray(v.capabilityInventory) && v.capabilityInventory.every((c) => typeof c === 'string') &&
    typeof v.status === 'string' && VALID_STATUSES.has(v.status) &&
    typeof v.enrolledAt === 'string' &&
    typeof v.lastSeenAt === 'string'
  );
}

export interface EnrollDeviceInput {
  tenantId: string;
  ownerId: string;
  publicKey: string;
  agentVersion: string;
  capabilityInventory?: string[];
}

export interface DeviceIdentityStoreOptions {
  dir?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => string;
}

export class DeviceIdentityStore {
  private readonly fileStore: FileRecordStore<DeviceIdentityRecord>;
  private readonly now: () => string;

  constructor(options: DeviceIdentityStoreOptions = {}) {
    const env = options.env ?? process.env;
    const dir = options.dir ?? resolveNagexDataDir('device-identities', 'NAGEX_DEVICE_IDENTITIES_DIR', env);
    this.fileStore = new FileRecordStore<DeviceIdentityRecord>(dir, isDeviceIdentityRecord);
    this.now = options.now ?? (() => getCurrentISOString());
  }

  // The server always mints its own deviceId — never trusts a
  // client-supplied resource id — matching every other create() in this
  // codebase.
  public enroll(input: EnrollDeviceInput): DeviceIdentityRecord {
    const timestamp = this.now();
    const record: DeviceIdentityRecord = {
      deviceId: generateResourceId('dev'),
      tenantId: input.tenantId,
      ownerId: input.ownerId,
      publicKey: input.publicKey,
      agentVersion: input.agentVersion,
      capabilityInventory: [...(input.capabilityInventory ?? [])],
      status: 'ACTIVE',
      enrolledAt: timestamp,
      lastSeenAt: timestamp,
    };
    this.fileStore.writeOrThrow(record.deviceId, record);
    return record;
  }

  private readRaw(deviceId: string): DeviceIdentityRecord | null {
    return this.fileStore.read(deviceId);
  }

  // The one centralized ownership gate every other method routes through
  // — a tenant/owner mismatch returns null, identical to a nonexistent
  // deviceId. Deliberately does NOT also gate on status here: a caller
  // that needs "owned AND active" (transport verification, session
  // creation) checks record.status itself, so a revoked-but-still-owned
  // device is still distinguishable from a genuinely unknown one for
  // legitimate owner-facing reads (e.g. "why is my device revoked?"),
  // while transport/execution paths apply their own stricter ACTIVE gate.
  public getOwned(deviceId: string, tenantId: string, ownerId: string): DeviceIdentityRecord | null {
    const record = this.readRaw(deviceId);
    if (!record || record.tenantId !== tenantId || record.ownerId !== ownerId) return null;
    return record;
  }

  private persist(record: DeviceIdentityRecord): DeviceIdentityRecord {
    this.fileStore.writeOrThrow(record.deviceId, record);
    return record;
  }

  public revoke(deviceId: string, tenantId: string, ownerId: string): DeviceIdentityRecord | null {
    const record = this.getOwned(deviceId, tenantId, ownerId);
    if (!record) return null;
    record.status = 'REVOKED';
    return this.persist(record);
  }

  public updateCapabilityInventory(deviceId: string, tenantId: string, ownerId: string, capabilityInventory: string[]): DeviceIdentityRecord | null {
    const record = this.getOwned(deviceId, tenantId, ownerId);
    if (!record) return null;
    record.capabilityInventory = [...capabilityInventory];
    return this.persist(record);
  }

  public touchLastSeen(deviceId: string, tenantId: string, ownerId: string): DeviceIdentityRecord | null {
    const record = this.getOwned(deviceId, tenantId, ownerId);
    if (!record) return null;
    record.lastSeenAt = this.now();
    return this.persist(record);
  }
}
