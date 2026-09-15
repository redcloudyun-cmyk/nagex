// DC3-B1 — ephemeral device connection status.
//
// Deliberately a NEW, separate store rather than a field added to
// DeviceIdentityStore's frozen DC3-A schema — "connected" is transient
// session-level state (changes every reconnect/heartbeat), while
// DeviceIdentityRecord is the durable enrollment record. Keeping them
// apart also keeps DC3-A's own file completely unmodified, per this
// directive's own "reuse DC3-A unchanged" instruction.
//
// Critical distinction this store exists to enforce: CONNECTED is not
// AUTHORIZED. This store only ever answers "is this device's transport
// currently live," never "may this device execute an action" — that
// remains entirely outside this store's concern (Capability Broker /
// ActionApprovalStore territory, untouched by DC3-B1).
import { getCurrentISOString } from '../common/utils.js';
import { FileRecordStore, resolveNagexDataDir } from '../governance/file-record.store.js';

export type DeviceConnectionState = 'CONNECTED' | 'DISCONNECTED';

export interface DeviceConnectionStatusRecord {
  deviceId: string;
  tenantId: string;
  ownerId: string;
  connectionState: DeviceConnectionState;
  lastConnectedAt: string | null;
  lastDisconnectedAt: string | null;
}

function isDeviceConnectionStatusRecord(value: unknown): value is DeviceConnectionStatusRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.deviceId === 'string' &&
    typeof v.tenantId === 'string' &&
    typeof v.ownerId === 'string' &&
    (v.connectionState === 'CONNECTED' || v.connectionState === 'DISCONNECTED') &&
    (v.lastConnectedAt === null || typeof v.lastConnectedAt === 'string') &&
    (v.lastDisconnectedAt === null || typeof v.lastDisconnectedAt === 'string')
  );
}

export interface DeviceConnectionStatusStoreOptions {
  dir?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => string;
}

export class DeviceConnectionStatusStore {
  private readonly fileStore: FileRecordStore<DeviceConnectionStatusRecord>;
  private readonly now: () => string;

  constructor(options: DeviceConnectionStatusStoreOptions = {}) {
    const env = options.env ?? process.env;
    const dir = options.dir ?? resolveNagexDataDir('device-connection-status', 'NAGEX_DEVICE_CONNECTION_STATUS_DIR', env);
    this.fileStore = new FileRecordStore<DeviceConnectionStatusRecord>(dir, isDeviceConnectionStatusRecord);
    this.now = options.now ?? (() => getCurrentISOString());
  }

  // Callers always pass an already-ownership-verified deviceId/tenantId/
  // ownerId (the output of DeviceTransportSecurity.verify()) — this store
  // has no getOwned() gate of its own because it is never queried by an
  // untrusted caller directly; it only ever records/reads state for a
  // device the transport layer has already authenticated.
  public markConnected(deviceId: string, tenantId: string, ownerId: string): DeviceConnectionStatusRecord {
    const record: DeviceConnectionStatusRecord = {
      deviceId,
      tenantId,
      ownerId,
      connectionState: 'CONNECTED',
      lastConnectedAt: this.now(),
      lastDisconnectedAt: this.readRaw(deviceId)?.lastDisconnectedAt ?? null,
    };
    this.fileStore.writeOrThrow(deviceId, record);
    return record;
  }

  public markDisconnected(deviceId: string, tenantId: string, ownerId: string): DeviceConnectionStatusRecord {
    const record: DeviceConnectionStatusRecord = {
      deviceId,
      tenantId,
      ownerId,
      connectionState: 'DISCONNECTED',
      lastConnectedAt: this.readRaw(deviceId)?.lastConnectedAt ?? null,
      lastDisconnectedAt: this.now(),
    };
    this.fileStore.writeOrThrow(deviceId, record);
    return record;
  }

  private readRaw(deviceId: string): DeviceConnectionStatusRecord | null {
    return this.fileStore.read(deviceId);
  }

  public getStatus(deviceId: string, tenantId: string, ownerId: string): DeviceConnectionStatusRecord | null {
    const record = this.readRaw(deviceId);
    if (!record || record.tenantId !== tenantId || record.ownerId !== ownerId) return null;
    return record;
  }
}
