// DC3-B1 — Local Device Agent transport client. Deliberately
// Electron-independent (plain Node crypto/fetch only) so it's fully
// unit-testable without a real Electron runtime; desktop-app.ts wires a
// thin lifecycle integration around it (start on app ready, stop on quit).
//
// Never executes a desktop action — this slice's entire authority is
// connect/authenticate/heartbeat/receive-a-bounded-command/acknowledge/
// reconnect/disconnect. The device's private key never leaves this
// process (it is held here, in memory, and used only to sign outbound
// envelopes — never transmitted).
import crypto from 'node:crypto';
import { generateResourceId } from '../common/utils.js';
import { canonicalEnvelopeSigningBytes, hashCanonicalPayload, type DeviceSignedEnvelope } from './device-transport-security.js';
import type { DeviceAgentCommandPayload, DeviceAgentCommandType, DevicePendingCommand } from './device-agent-protocol.js';
import type { DeviceAgentResponse } from './device-agent-transport-endpoint.service.js';

type FetchFn = typeof fetch;

export interface LocalDeviceAgentClientOptions {
  tenantId: string;
  ownerId: string;
  deviceId: string;
  // The device's own private key (PEM) — generated once at enrollment,
  // held only in this process, never sent over the wire.
  privateKeyPem: string;
  serverBaseUrl: string;
  agentVersion: string;
  capabilityInventory?: string[];
  fetchFn?: FetchFn;
  now?: () => number;
  envelopeTtlMs?: number;
}

const DEFAULT_ENVELOPE_TTL_MS = 30_000;

export class LocalDeviceAgentClient {
  private sequence = 0;
  private connected = false;
  private readonly fetchFn: FetchFn;
  private readonly now: () => number;
  private readonly envelopeTtlMs: number;

  constructor(private readonly options: LocalDeviceAgentClientOptions) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? (() => Date.now());
    this.envelopeTtlMs = options.envelopeTtlMs ?? DEFAULT_ENVELOPE_TTL_MS;
  }

  public isConnected(): boolean {
    return this.connected;
  }

  private buildSignedMessage(commandType: DeviceAgentCommandType, executionSessionId: string | null, data: Record<string, unknown>): { envelope: DeviceSignedEnvelope; payload: DeviceAgentCommandPayload } {
    // A fresh, monotonically-increasing sequence and a fresh messageId
    // every single call — no envelope is ever reused, so a genuine
    // reconnect naturally re-authenticates with new, never-replayed
    // credentials rather than resending anything already-consumed.
    this.sequence += 1;
    const messageId = generateResourceId('msg');
    const issuedAt = new Date(this.now()).toISOString();
    const expiresAt = new Date(this.now() + this.envelopeTtlMs).toISOString();
    const payload: DeviceAgentCommandPayload = { commandType, executionSessionId, data };
    const payloadHash = hashCanonicalPayload(payload);
    const envelopeBase = {
      deviceId: this.options.deviceId,
      tenantId: this.options.tenantId,
      ownerId: this.options.ownerId,
      messageId,
      sequence: this.sequence,
      issuedAt,
      expiresAt,
      payloadHash,
    };
    const signingBytes = canonicalEnvelopeSigningBytes(envelopeBase);
    const signature = crypto.sign(null, signingBytes, { key: this.options.privateKeyPem, format: 'pem' }).toString('base64');
    return { envelope: { ...envelopeBase, signature }, payload };
  }

  private async send(commandType: DeviceAgentCommandType, executionSessionId: string | null, data: Record<string, unknown>): Promise<DeviceAgentResponse> {
    const { envelope, payload } = this.buildSignedMessage(commandType, executionSessionId, data);
    const response = await this.fetchFn(`${this.options.serverBaseUrl}/api/v1/device-agent/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ envelope, payload }),
    });
    if (!response.ok) {
      throw new Error(`Local Device Agent transport error: HTTP ${response.status}`);
    }
    return (await response.json()) as DeviceAgentResponse;
  }

  public async connect(): Promise<DeviceAgentResponse> {
    const response = await this.send('CONNECT', null, {});
    this.connected = true;
    return response;
  }

  // Bounded reconnect with exponential backoff — never an unbounded retry
  // loop. Each attempt is a genuine fresh CONNECT (re-authentication),
  // never an assumption that a prior session is still valid.
  public async connectWithBackoff(maxAttempts = 5, baseDelayMs = 250, sleepFn: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<DeviceAgentResponse> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.connect();
      } catch (error) {
        lastError = error;
        if (attempt === maxAttempts) break;
        await sleepFn(baseDelayMs * 2 ** (attempt - 1));
      }
    }
    throw lastError;
  }

  // Heartbeat may deliver at most one piggybacked pending command (see
  // device-agent-protocol.ts). The client verifies the delivered
  // command's own deviceId/tenantId/ownerId genuinely match its own
  // identity before ever acting on or acknowledging it — "verify
  // server-issued command context," Section 3's own explicit requirement.
  public async heartbeat(): Promise<DevicePendingCommand | null> {
    const response = await this.send('HEARTBEAT', null, {
      agentVersion: this.options.agentVersion,
      capabilityInventory: this.options.capabilityInventory ?? [],
    });
    const result = response.result as { pendingCommand?: DevicePendingCommand | null } | undefined;
    const pendingCommand = result?.pendingCommand ?? null;
    if (!pendingCommand) return null;

    const contextMatches =
      pendingCommand.deviceId === this.options.deviceId &&
      pendingCommand.tenantId === this.options.tenantId &&
      pendingCommand.ownerId === this.options.ownerId;
    if (!contextMatches) {
      // A delivered command that doesn't even match this device's own
      // identity is never acted on and never acknowledged — fails closed.
      return null;
    }

    await this.send('ACK', pendingCommand.executionSessionId, { commandId: pendingCommand.commandId });
    return pendingCommand;
  }

  public async openSession(mode: 'BACKGROUND' | 'ASSISTED' | 'TAKEOVER', ttlMs?: number): Promise<string> {
    const response = await this.send('SESSION_OPEN', null, { mode, ...(ttlMs ? { ttlMs } : {}) });
    return (response.result as { executionSessionId: string }).executionSessionId;
  }

  public async closeSession(executionSessionId: string): Promise<void> {
    await this.send('SESSION_CLOSE', executionSessionId, {});
  }

  public async status(executionSessionId: string | null = null): Promise<unknown> {
    return (await this.send('STATUS', executionSessionId, {})).result;
  }

  // "Shutdown cleanly" — best-effort: a real network-loss disconnect
  // can't always deliver this, which is fine (the server relies on
  // heartbeat staleness for that case, not this explicit signal).
  public async disconnect(): Promise<void> {
    if (!this.connected) return;
    try {
      await this.send('DISCONNECT', null, {});
    } finally {
      this.connected = false;
    }
  }
}
