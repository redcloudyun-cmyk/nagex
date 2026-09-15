// DC3-A — Device transport security.
//
// Deliberately separate from ActionApprovalStore (Section 4's own explicit
// rule): this store answers "is this message really from this device,
// unaltered, unexpired, and not a replay?" — a transport-authentication
// question. ActionApprovalStore answers a completely different question —
// "did a human explicitly authorize this specific consequential action?"
// — and remains the sole authority for that. A verified transport message
// is not itself an approval; a consequential action proposed inside a
// verified message still goes through the existing, unchanged
// ActionApprovalStore exactly like every other consequential action in
// this codebase.
//
// Every rejection reason (unknown device, wrong tenant/owner, revoked,
// expired, bad signature, replay) throws the identical
// DEVICE_TRANSPORT_REJECTED/POLICY error — Section 3's own explicit
// requirement: never reveal whether another tenant's device exists, or
// which specific check failed.
import crypto from 'node:crypto';
import { NagexError } from '../common/errors.js';
import { getCurrentISOString } from '../common/utils.js';
import { FileRecordStore, resolveNagexDataDir } from '../governance/file-record.store.js';
import { DeviceIdentityStore, type DeviceIdentityRecord } from './device-identity.store.js';

export interface DeviceSignedEnvelope {
  deviceId: string;
  tenantId: string;
  ownerId: string;
  messageId: string;
  sequence: number;
  issuedAt: string;
  expiresAt: string;
  // sha256 hex digest of the canonicalized message payload — the
  // signature covers this hash (and the rest of the envelope), so the
  // payload itself never needs to be signed directly.
  payloadHash: string;
  // base64-encoded Ed25519 signature over the canonical envelope bytes
  // (every field above except signature itself).
  signature: string;
}

interface DeviceMessageReplayRecord {
  deviceId: string;
  messageId: string;
  seenAt: string;
}

function isDeviceMessageReplayRecord(value: unknown): value is DeviceMessageReplayRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.deviceId === 'string' && typeof v.messageId === 'string' && typeof v.seenAt === 'string';
}

// Deterministic, fixed-key-order serialization — the exact bytes the
// device itself must sign, and the exact bytes the server re-derives to
// verify against. Never includes `signature` (a field can't sign itself).
export function canonicalEnvelopeSigningBytes(envelope: Omit<DeviceSignedEnvelope, 'signature'>): Buffer {
  return Buffer.from(
    JSON.stringify({
      deviceId: envelope.deviceId,
      tenantId: envelope.tenantId,
      ownerId: envelope.ownerId,
      messageId: envelope.messageId,
      sequence: envelope.sequence,
      issuedAt: envelope.issuedAt,
      expiresAt: envelope.expiresAt,
      payloadHash: envelope.payloadHash,
    }),
    'utf8',
  );
}

export function hashCanonicalPayload(payload: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export interface DeviceTransportSecurityOptions {
  dir?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

const REJECTED = (requestId: string): NagexError =>
  new NagexError({
    code: 'DEVICE_TRANSPORT_REJECTED',
    category: 'POLICY',
    message: 'This device message could not be verified.',
    request_id: requestId,
  });

export class DeviceTransportSecurity {
  private readonly replayStore: FileRecordStore<DeviceMessageReplayRecord>;
  private readonly now: () => number;

  constructor(private readonly devices: DeviceIdentityStore, options: DeviceTransportSecurityOptions = {}) {
    const env = options.env ?? process.env;
    const dir = options.dir ?? resolveNagexDataDir('device-transport-replay', 'NAGEX_DEVICE_TRANSPORT_REPLAY_DIR', env);
    this.replayStore = new FileRecordStore<DeviceMessageReplayRecord>(dir, isDeviceMessageReplayRecord);
    this.now = options.now ?? (() => Date.now());
  }

  // Verifies one signed envelope against a real payload. Returns the
  // owning DeviceIdentityRecord on success (the caller's proof that this
  // message really came from this specific, active, owned device) or
  // throws the identical DEVICE_TRANSPORT_REJECTED for every failure mode.
  // This method alone establishes transport authenticity — it says
  // nothing about whether any action inside the payload is *authorized*;
  // that remains ActionApprovalStore's job, unchanged.
  public verify(envelope: DeviceSignedEnvelope, payload: unknown, requestId: string): DeviceIdentityRecord {
    const device = this.devices.getOwned(envelope.deviceId, envelope.tenantId, envelope.ownerId);
    if (!device || device.status !== 'ACTIVE') {
      throw REJECTED(requestId);
    }

    if (new Date(envelope.expiresAt).getTime() <= this.now()) {
      throw REJECTED(requestId);
    }

    const computedHash = hashCanonicalPayload(payload);
    if (computedHash !== envelope.payloadHash) {
      throw REJECTED(requestId);
    }

    const signingBytes = canonicalEnvelopeSigningBytes(envelope);
    let signatureValid: boolean;
    try {
      signatureValid = crypto.verify(null, signingBytes, { key: device.publicKey, format: 'pem', type: 'spki' }, Buffer.from(envelope.signature, 'base64'));
    } catch {
      // A malformed key/signature is a verification failure, not a crash.
      signatureValid = false;
    }
    if (!signatureValid) {
      throw REJECTED(requestId);
    }

    // Replay check happens only AFTER the signature is proven valid —
    // recording "seen" (or rejecting as a duplicate) for a message that
    // was never actually authenticated would let an attacker probe replay
    // state without ever holding a real private key.
    const replayKey = `${envelope.deviceId}:${envelope.messageId}`;
    if (this.replayStore.read(replayKey)) {
      throw REJECTED(requestId);
    }
    this.replayStore.writeOrThrow(replayKey, { deviceId: envelope.deviceId, messageId: envelope.messageId, seenAt: getCurrentISOString() });

    return device;
  }
}
