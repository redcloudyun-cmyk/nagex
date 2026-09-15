// DC3-B1 — server-side transport endpoint. One entry point
// (`handle()`) dispatches every allowed command type after
// DeviceTransportSecurity.verify() has authenticated the envelope.
//
// Section 10's truthfulness requirement is enforced structurally here:
// this file never touches CapabilityBroker, CapabilityRegistry, or
// anything resembling `device.desktop.execute` — "connected" and
// "authenticated" are exactly as far as this service's authority reaches.
import { NagexError } from '../common/errors.js';
import { DeviceIdentityStore } from './device-identity.store.js';
import { DeviceTransportSecurity, type DeviceSignedEnvelope } from './device-transport-security.js';
import { DeviceConnectionStatusStore } from './device-connection-status.store.js';
import { DesktopExecutionSessionStore, type DesktopExecutionMode } from './desktop-execution-session.store.js';
import { isDeviceAgentCommandPayload, type DeviceAgentCommandPayload } from './device-agent-protocol.js';
import { DevicePendingCommandStore } from './device-pending-command.store.js';

const VALID_MODES: ReadonlySet<string> = new Set<DesktopExecutionMode>(['BACKGROUND', 'ASSISTED', 'TAKEOVER']);
const DEFAULT_SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_SESSION_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours — a hard ceiling, not caller-controlled beyond this

export interface DeviceAgentMessage {
  envelope: DeviceSignedEnvelope;
  payload: unknown;
}

export interface DeviceAgentResponse {
  status: 'OK';
  commandType: string;
  result: unknown;
}

export class DeviceAgentTransportEndpoint {
  constructor(
    private readonly transportSecurity: DeviceTransportSecurity,
    private readonly devices: DeviceIdentityStore,
    private readonly connectionStatus: DeviceConnectionStatusStore,
    private readonly sessions: DesktopExecutionSessionStore,
    private readonly pendingCommands: DevicePendingCommandStore,
  ) {}

  public handle(message: DeviceAgentMessage, requestId: string): DeviceAgentResponse {
    // Authenticates the envelope FIRST — every command below only ever
    // runs against a verified, ACTIVE, owned device. A malformed/disallowed
    // payload shape fails closed before dispatch, never guessed into a
    // best-effort command.
    const device = this.transportSecurity.verify(message.envelope, message.payload, requestId);

    if (!isDeviceAgentCommandPayload(message.payload)) {
      throw new NagexError({ code: 'DEVICE_COMMAND_UNSUPPORTED', category: 'VALIDATION', message: 'This command is not part of the DC3-B1 transport allowlist.', request_id: requestId });
    }
    const payload: DeviceAgentCommandPayload = message.payload;

    switch (payload.commandType) {
      case 'CONNECT': {
        this.connectionStatus.markConnected(device.deviceId, device.tenantId, device.ownerId);
        this.devices.touchLastSeen(device.deviceId, device.tenantId, device.ownerId);
        return { status: 'OK', commandType: 'CONNECT', result: { deviceId: device.deviceId, connected: true } };
      }

      case 'HEARTBEAT': {
        const agentVersion = typeof payload.data.agentVersion === 'string' ? payload.data.agentVersion : undefined;
        const capabilityInventory = Array.isArray(payload.data.capabilityInventory) && payload.data.capabilityInventory.every((c) => typeof c === 'string')
          ? (payload.data.capabilityInventory as string[])
          : undefined;
        // Heartbeat's ENTIRE authority: lastSeenAt/agentVersion/
        // capabilityInventory/connection status — nothing else. It never
        // grants execution rights (Section 7's own explicit invariant).
        this.devices.recordHeartbeat(device.deviceId, device.tenantId, device.ownerId, { agentVersion, capabilityInventory });
        this.connectionStatus.markConnected(device.deviceId, device.tenantId, device.ownerId);
        // At most one queued command piggybacked per heartbeat — see
        // device-agent-protocol.ts's own header comment for why this
        // stands in for real blocking long-poll in this slice.
        const pendingCommand = this.pendingCommands.dequeueNext(device.deviceId, device.tenantId, device.ownerId);
        return { status: 'OK', commandType: 'HEARTBEAT', result: { acknowledged: true, pendingCommand } };
      }

      case 'DISCONNECT': {
        this.connectionStatus.markDisconnected(device.deviceId, device.tenantId, device.ownerId);
        return { status: 'OK', commandType: 'DISCONNECT', result: { disconnected: true } };
      }

      case 'PING': {
        return { status: 'OK', commandType: 'PING', result: { pong: true, serverTime: new Date().toISOString() } };
      }

      case 'SESSION_OPEN': {
        const requestedMode = typeof payload.data.mode === 'string' ? payload.data.mode : 'BACKGROUND';
        if (!VALID_MODES.has(requestedMode)) {
          throw new NagexError({ code: 'DEVICE_SESSION_MODE_INVALID', category: 'VALIDATION', message: `Unknown desktop execution mode "${requestedMode}".`, request_id: requestId });
        }
        const requestedTtlMs = typeof payload.data.ttlMs === 'number' && payload.data.ttlMs > 0 ? payload.data.ttlMs : DEFAULT_SESSION_TTL_MS;
        const ttlMs = Math.min(requestedTtlMs, MAX_SESSION_TTL_MS);
        const session = this.sessions.create({
          deviceId: device.deviceId,
          tenantId: device.tenantId,
          ownerId: device.ownerId,
          mode: requestedMode as DesktopExecutionMode,
          expiresAt: new Date(Date.now() + ttlMs).toISOString(),
        });
        return { status: 'OK', commandType: 'SESSION_OPEN', result: { executionSessionId: session.executionSessionId, mode: session.mode, expiresAt: session.expiresAt } };
      }

      case 'SESSION_CLOSE': {
        if (!payload.executionSessionId) {
          throw new NagexError({ code: 'DEVICE_EXECUTION_SESSION_ID_REQUIRED', category: 'VALIDATION', message: 'executionSessionId is required for SESSION_CLOSE.', request_id: requestId });
        }
        const closed = this.sessions.close(payload.executionSessionId, device.tenantId, device.ownerId);
        if (!closed) {
          throw new NagexError({ code: 'DEVICE_EXECUTION_SESSION_NOT_FOUND', category: 'NOT_FOUND', message: `Execution session ${payload.executionSessionId} was not found.`, request_id: requestId });
        }
        return { status: 'OK', commandType: 'SESSION_CLOSE', result: { executionSessionId: closed.executionSessionId, state: closed.state } };
      }

      case 'CANCEL': {
        if (!payload.executionSessionId) {
          throw new NagexError({ code: 'DEVICE_EXECUTION_SESSION_ID_REQUIRED', category: 'VALIDATION', message: 'executionSessionId is required for CANCEL.', request_id: requestId });
        }
        // For DC3-B1 (no execution loop exists yet), CANCEL is identical
        // to SESSION_CLOSE — the same terminal CLOSED state, no separate
        // CANCELLED state needed until there is something to actually
        // interrupt mid-flight.
        const cancelled = this.sessions.close(payload.executionSessionId, device.tenantId, device.ownerId);
        if (!cancelled) {
          throw new NagexError({ code: 'DEVICE_EXECUTION_SESSION_NOT_FOUND', category: 'NOT_FOUND', message: `Execution session ${payload.executionSessionId} was not found.`, request_id: requestId });
        }
        return { status: 'OK', commandType: 'CANCEL', result: { executionSessionId: cancelled.executionSessionId, state: cancelled.state } };
      }

      case 'STATUS': {
        const connection = this.connectionStatus.getStatus(device.deviceId, device.tenantId, device.ownerId);
        const session = payload.executionSessionId ? this.sessions.getOwned(payload.executionSessionId, device.tenantId, device.ownerId) : null;
        return {
          status: 'OK',
          commandType: 'STATUS',
          result: {
            deviceId: device.deviceId,
            deviceStatus: device.status,
            connectionState: connection?.connectionState ?? 'DISCONNECTED',
            executionSession: session ? { executionSessionId: session.executionSessionId, state: session.state, mode: session.mode } : null,
          },
        };
      }

      case 'ACK': {
        return { status: 'OK', commandType: 'ACK', result: { acknowledged: true } };
      }
    }
  }

  // Called on disconnect/shutdown/logout paths — never on the authenticated
  // command path itself.
  public markDisconnected(deviceId: string, tenantId: string, ownerId: string): void {
    this.connectionStatus.markDisconnected(deviceId, tenantId, ownerId);
  }
}
