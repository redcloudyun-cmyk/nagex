// DC3-B1 — a small FIFO of server-queued commands awaiting delivery to a
// specific device, delivered piggybacked on that device's own next
// HEARTBEAT response (see device-agent-protocol.ts's own header comment
// for why this replaces real blocking long-poll for this slice). Nothing
// in DC3-B1 itself enqueues a command through a user-facing flow yet —
// this is the primitive a later slice's "open a session from the NAgex
// UI" feature will call; proven here only at the store level.
import { generateResourceId, getCurrentISOString } from '../common/utils.js';
import { FileRecordStore, resolveNagexDataDir } from '../governance/file-record.store.js';
import { type DeviceAgentCommandType, type DevicePendingCommand } from './device-agent-protocol.js';

function isDevicePendingCommand(value: unknown): value is DevicePendingCommand {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.commandId === 'string' &&
    typeof v.commandType === 'string' &&
    typeof v.deviceId === 'string' &&
    typeof v.tenantId === 'string' &&
    typeof v.ownerId === 'string' &&
    (v.executionSessionId === null || typeof v.executionSessionId === 'string') &&
    !!v.data && typeof v.data === 'object' &&
    typeof v.queuedAt === 'string'
  );
}

export interface DevicePendingCommandStoreOptions {
  dir?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => string;
}

export class DevicePendingCommandStore {
  private readonly fileStore: FileRecordStore<DevicePendingCommand>;
  private readonly now: () => string;

  constructor(options: DevicePendingCommandStoreOptions = {}) {
    const env = options.env ?? process.env;
    const dir = options.dir ?? resolveNagexDataDir('device-pending-commands', 'NAGEX_DEVICE_PENDING_COMMANDS_DIR', env);
    this.fileStore = new FileRecordStore<DevicePendingCommand>(dir, isDevicePendingCommand);
    this.now = options.now ?? (() => getCurrentISOString());
  }

  public enqueue(deviceId: string, tenantId: string, ownerId: string, commandType: DeviceAgentCommandType, executionSessionId: string | null, data: Record<string, unknown>): DevicePendingCommand {
    const command: DevicePendingCommand = {
      commandId: generateResourceId('cmd'),
      commandType,
      deviceId,
      tenantId,
      ownerId,
      executionSessionId,
      data,
      queuedAt: this.now(),
    };
    this.fileStore.writeOrThrow(command.commandId, command);
    return command;
  }

  // Pops the single oldest pending command for this device, if any — one
  // command delivered per heartbeat, never a batch, keeping each delivery
  // small and boundedly verifiable by the agent.
  public dequeueNext(deviceId: string, tenantId: string, ownerId: string): DevicePendingCommand | null {
    const all = this.fileStore.readAll().filter((c) => c.deviceId === deviceId && c.tenantId === tenantId && c.ownerId === ownerId);
    if (all.length === 0) return null;
    all.sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
    const next = all[0];
    this.fileStore.remove(next.commandId);
    return next;
  }
}
