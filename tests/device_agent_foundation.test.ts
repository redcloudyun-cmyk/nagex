// DC3-A — Local Device Agent Foundation.
//
// Uses real Node crypto (Ed25519) throughout — the same primitives a real
// Local Device Agent would use to generate its keypair and sign envelopes.
// No mocked crypto, no fake signature verification.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DeviceIdentityStore } from '../src/device-agent/device-identity.store.js';
import { DeviceTransportSecurity, canonicalEnvelopeSigningBytes, hashCanonicalPayload, type DeviceSignedEnvelope } from '../src/device-agent/device-transport-security.js';
import { DesktopExecutionSessionStore } from '../src/device-agent/desktop-execution-session.store.js';
import { NagexError } from '../src/common/errors.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-device-agent-test-'));
}

function generateDeviceKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

function buildHarness() {
  const dir = tempDir();
  const devices = new DeviceIdentityStore({ dir: path.join(dir, 'devices') });
  const transport = new DeviceTransportSecurity(devices, { dir: path.join(dir, 'replay') });
  const sessions = new DesktopExecutionSessionStore({ dir: path.join(dir, 'sessions') });
  return { dir, devices, transport, sessions };
}

// Signs an envelope the way a real device agent would: build the envelope
// minus signature, hash the payload, sign the canonical bytes with the
// device's own real private key.
function signEnvelope(base: Omit<DeviceSignedEnvelope, 'payloadHash' | 'signature'>, payload: unknown, privateKeyPem: string): DeviceSignedEnvelope {
  const payloadHash = hashCanonicalPayload(payload);
  const withHash = { ...base, payloadHash };
  const signingBytes = canonicalEnvelopeSigningBytes(withHash);
  const signature = crypto.sign(null, signingBytes, { key: privateKeyPem, format: 'pem' }).toString('base64');
  return { ...withHash, signature };
}

const TENANT_A = 'ten_dc3a_a';
const TENANT_B = 'ten_dc3a_b';
const OWNER_X = 'usr_dc3a_x';
const OWNER_Y = 'usr_dc3a_y';

// ── 1-4: device identity ownership ──────────────────────────────────────

test('DEVICE_ENROLL_RIGHTFUL: enrollment persists a real, tenant/owner-scoped device with only the public key', async () => {
  const { devices } = buildHarness();
  const { publicKeyPem } = generateDeviceKeypair();
  const record = devices.enroll({ tenantId: TENANT_A, ownerId: OWNER_X, publicKey: publicKeyPem, agentVersion: '1.0.0', capabilityInventory: ['uia.invoke'] });
  assert.equal(record.status, 'ACTIVE');
  assert.equal(record.tenantId, TENANT_A);
  assert.equal(record.ownerId, OWNER_X);
  assert.equal(record.publicKey, publicKeyPem);
  assert.equal(devices.getOwned(record.deviceId, TENANT_A, OWNER_X)?.deviceId, record.deviceId);
});

test('DEVICE_CROSS_TENANT_READ_BLOCK / DEVICE_CROSS_OWNER_READ_BLOCK / DEVICE_UNKNOWN_ID_INDISTINGUISHABLE', async () => {
  const { devices } = buildHarness();
  const { publicKeyPem } = generateDeviceKeypair();
  const record = devices.enroll({ tenantId: TENANT_A, ownerId: OWNER_X, publicKey: publicKeyPem, agentVersion: '1.0.0' });

  const crossTenant = devices.getOwned(record.deviceId, TENANT_B, OWNER_X);
  const crossOwner = devices.getOwned(record.deviceId, TENANT_A, OWNER_Y);
  const unknown = devices.getOwned('dev_does_not_exist', TENANT_A, OWNER_X);

  assert.equal(crossTenant, null, 'wrong tenant must fail closed');
  assert.equal(crossOwner, null, 'wrong owner must fail closed');
  assert.equal(unknown, null, 'unknown deviceId must fail closed');
  // All three must be genuinely the SAME value (null), not just "falsy" —
  // indistinguishable, not merely blocked.
  assert.equal(crossTenant, crossOwner);
  assert.equal(crossOwner, unknown);
});

// ── 5-9: transport security ─────────────────────────────────────────────

test('DEVICE_SIGNATURE_VALID: a real Ed25519-signed envelope from the enrolled device verifies successfully', async () => {
  const { devices, transport } = buildHarness();
  const { publicKeyPem, privateKeyPem } = generateDeviceKeypair();
  const device = devices.enroll({ tenantId: TENANT_A, ownerId: OWNER_X, publicKey: publicKeyPem, agentVersion: '1.0.0' });

  const payload = { goal: 'observe' };
  const issuedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const envelope = signEnvelope(
    { deviceId: device.deviceId, tenantId: TENANT_A, ownerId: OWNER_X, messageId: 'msg_1', sequence: 1, issuedAt, expiresAt },
    payload,
    privateKeyPem,
  );

  const verified = transport.verify(envelope, payload, 'req_verify_1');
  assert.equal(verified.deviceId, device.deviceId);
});

test('DEVICE_SIGNATURE_INVALID_BLOCK: a tampered payload (real hash mismatch) or a signature from a different key is rejected', async () => {
  const { devices, transport } = buildHarness();
  const { publicKeyPem, privateKeyPem } = generateDeviceKeypair();
  const device = devices.enroll({ tenantId: TENANT_A, ownerId: OWNER_X, publicKey: publicKeyPem, agentVersion: '1.0.0' });
  const issuedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 60_000).toISOString();

  // Case A: payload tampered after signing.
  const originalPayload = { action: 'OBSERVE' };
  const envelopeA = signEnvelope({ deviceId: device.deviceId, tenantId: TENANT_A, ownerId: OWNER_X, messageId: 'msg_a', sequence: 1, issuedAt, expiresAt }, originalPayload, privateKeyPem);
  const tamperedPayload = { action: 'CLICK' };
  await assert.rejects(
    (async () => transport.verify(envelopeA, tamperedPayload, 'req_tamper'))(),
    (err: unknown) => err instanceof NagexError && err.code === 'DEVICE_TRANSPORT_REJECTED',
  );

  // Case B: signed by a DIFFERENT keypair than the one enrolled.
  const attackerKeys = generateDeviceKeypair();
  const envelopeB = signEnvelope({ deviceId: device.deviceId, tenantId: TENANT_A, ownerId: OWNER_X, messageId: 'msg_b', sequence: 2, issuedAt, expiresAt }, originalPayload, attackerKeys.privateKeyPem);
  await assert.rejects(
    (async () => transport.verify(envelopeB, originalPayload, 'req_wrong_key'))(),
    (err: unknown) => err instanceof NagexError && err.code === 'DEVICE_TRANSPORT_REJECTED',
  );
});

test('DEVICE_REPLAY_BLOCK: re-submitting the exact same real, validly-signed envelope a second time is rejected', async () => {
  const { devices, transport } = buildHarness();
  const { publicKeyPem, privateKeyPem } = generateDeviceKeypair();
  const device = devices.enroll({ tenantId: TENANT_A, ownerId: OWNER_X, publicKey: publicKeyPem, agentVersion: '1.0.0' });
  const payload = { action: 'STOP' };
  const issuedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const envelope = signEnvelope({ deviceId: device.deviceId, tenantId: TENANT_A, ownerId: OWNER_X, messageId: 'msg_replay', sequence: 1, issuedAt, expiresAt }, payload, privateKeyPem);

  const first = transport.verify(envelope, payload, 'req_first');
  assert.equal(first.deviceId, device.deviceId);

  await assert.rejects(
    (async () => transport.verify(envelope, payload, 'req_second'))(),
    (err: unknown) => err instanceof NagexError && err.code === 'DEVICE_TRANSPORT_REJECTED',
  );
});

test('DEVICE_EXPIRED_MESSAGE_BLOCK: an envelope whose expiresAt has already passed is rejected, even with a real valid signature', async () => {
  const { devices, transport } = buildHarness();
  const { publicKeyPem, privateKeyPem } = generateDeviceKeypair();
  const device = devices.enroll({ tenantId: TENANT_A, ownerId: OWNER_X, publicKey: publicKeyPem, agentVersion: '1.0.0' });
  const payload = { action: 'OBSERVE' };
  const issuedAt = new Date(Date.now() - 120_000).toISOString();
  const expiresAt = new Date(Date.now() - 60_000).toISOString(); // already expired
  const envelope = signEnvelope({ deviceId: device.deviceId, tenantId: TENANT_A, ownerId: OWNER_X, messageId: 'msg_expired', sequence: 1, issuedAt, expiresAt }, payload, privateKeyPem);

  await assert.rejects(
    (async () => transport.verify(envelope, payload, 'req_expired'))(),
    (err: unknown) => err instanceof NagexError && err.code === 'DEVICE_TRANSPORT_REJECTED',
  );
});

test('DEVICE_REVOKED_BLOCK: a revoked device\'s otherwise-perfectly-valid signed envelope is rejected', async () => {
  const { devices, transport } = buildHarness();
  const { publicKeyPem, privateKeyPem } = generateDeviceKeypair();
  const device = devices.enroll({ tenantId: TENANT_A, ownerId: OWNER_X, publicKey: publicKeyPem, agentVersion: '1.0.0' });
  devices.revoke(device.deviceId, TENANT_A, OWNER_X);

  const payload = { action: 'OBSERVE' };
  const issuedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const envelope = signEnvelope({ deviceId: device.deviceId, tenantId: TENANT_A, ownerId: OWNER_X, messageId: 'msg_revoked', sequence: 1, issuedAt, expiresAt }, payload, privateKeyPem);

  await assert.rejects(
    (async () => transport.verify(envelope, payload, 'req_revoked'))(),
    (err: unknown) => err instanceof NagexError && err.code === 'DEVICE_TRANSPORT_REJECTED',
  );
});

// ── 10: uniform rejection — indistinguishability across every failure mode ─

test('all transport rejection modes throw the identical DEVICE_TRANSPORT_REJECTED/POLICY error, never revealing which check failed', async () => {
  const { devices, transport } = buildHarness();
  const { publicKeyPem, privateKeyPem } = generateDeviceKeypair();
  const device = devices.enroll({ tenantId: TENANT_A, ownerId: OWNER_X, publicKey: publicKeyPem, agentVersion: '1.0.0' });
  const payload = { action: 'OBSERVE' };

  const capture = async (fn: () => unknown): Promise<NagexError> => {
    try {
      await fn();
      throw new Error('expected rejection');
    } catch (err) {
      assert.ok(err instanceof NagexError);
      return err as NagexError;
    }
  };

  const validEnvelope = signEnvelope({ deviceId: device.deviceId, tenantId: TENANT_A, ownerId: OWNER_X, messageId: 'msg_uniform', sequence: 1, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() }, payload, privateKeyPem);

  const unknownDeviceErr = await capture(() => transport.verify({ ...validEnvelope, deviceId: 'dev_ghost' }, payload, 'r1'));
  const wrongTenantErr = await capture(() => transport.verify({ ...validEnvelope, tenantId: TENANT_B }, payload, 'r2'));
  const expiredErr = await capture(() => transport.verify({ ...validEnvelope, expiresAt: new Date(Date.now() - 1000).toISOString() }, payload, 'r3'));

  assert.equal(unknownDeviceErr.code, 'DEVICE_TRANSPORT_REJECTED');
  assert.equal(unknownDeviceErr.category, 'POLICY');
  assert.equal(unknownDeviceErr.code, wrongTenantErr.code);
  assert.equal(unknownDeviceErr.category, wrongTenantErr.category);
  assert.equal(unknownDeviceErr.code, expiredErr.code);
});

// ── 11: private key never touches the server ────────────────────────────

test('DEVICE_PRIVATE_KEY_NEVER_SERVER_PERSISTED: no private key material ever appears in the persisted device record or on disk', async () => {
  const { dir, devices } = buildHarness();
  const { publicKeyPem, privateKeyPem } = generateDeviceKeypair();
  const record = devices.enroll({ tenantId: TENANT_A, ownerId: OWNER_X, publicKey: publicKeyPem, agentVersion: '1.0.0' });

  // Structural: the type itself has no privateKey field.
  assert.equal((record as unknown as Record<string, unknown>).privateKey, undefined);
  assert.equal((record as unknown as Record<string, unknown>).privateKeyPem, undefined);

  // Behavioral: scan every file this store wrote and confirm the real
  // private key string is nowhere in it.
  const files = fs.readdirSync(path.join(dir, 'devices')).filter((f) => f.endsWith('.json'));
  assert.ok(files.length > 0);
  for (const file of files) {
    const contents = fs.readFileSync(path.join(dir, 'devices', file), 'utf8');
    assert.ok(!contents.includes(privateKeyPem), `${file} must never contain the private key`);
    assert.ok(!contents.includes('PRIVATE KEY'), `${file} must never contain any PEM private-key marker`);
  }
});

// ── 12: no inbound port requirement — architectural source check ────────

test('DEVICE_NO_PUBLIC_INBOUND_PORT_REQUIRED: no device-agent source file opens a listening socket/HTTP server', () => {
  const deviceAgentDir = path.join(process.cwd(), 'src', 'device-agent');
  const files = fs.readdirSync(deviceAgentDir).filter((f) => f.endsWith('.ts'));
  assert.ok(files.length > 0);
  for (const file of files) {
    const contents = fs.readFileSync(path.join(deviceAgentDir, file), 'utf8');
    assert.ok(!/\.listen\s*\(/.test(contents), `${file} must never open a listening socket`);
    assert.ok(!/createServer/.test(contents), `${file} must never create a server`);
  }
});

// ── 13-15: desktop execution session ownership ───────────────────────────

test('DESKTOP_SESSION_RIGHTFUL / DESKTOP_SESSION_CROSS_TENANT_BLOCK / DESKTOP_SESSION_CROSS_OWNER_BLOCK', async () => {
  const { devices, sessions } = buildHarness();
  const { publicKeyPem } = generateDeviceKeypair();
  const device = devices.enroll({ tenantId: TENANT_A, ownerId: OWNER_X, publicKey: publicKeyPem, agentVersion: '1.0.0' });

  const record = sessions.create({
    deviceId: device.deviceId,
    tenantId: TENANT_A,
    ownerId: OWNER_X,
    mode: 'BACKGROUND',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  assert.equal(record.state, 'ACTIVE');
  assert.equal(record.mode, 'BACKGROUND');

  const rightful = sessions.getOwned(record.executionSessionId, TENANT_A, OWNER_X);
  assert.equal(rightful?.executionSessionId, record.executionSessionId);

  const crossTenant = sessions.getOwned(record.executionSessionId, TENANT_B, OWNER_X);
  const crossOwner = sessions.getOwned(record.executionSessionId, TENANT_A, OWNER_Y);
  assert.equal(crossTenant, null, 'DESKTOP_SESSION_CROSS_TENANT_BLOCK');
  assert.equal(crossOwner, null, 'DESKTOP_SESSION_CROSS_OWNER_BLOCK');

  // Rightful close still works after both blocked attempts, and the
  // blocked attempts never mutated the session.
  assert.equal(sessions.getOwned(record.executionSessionId, TENANT_A, OWNER_X)?.state, 'ACTIVE');
  const closed = sessions.close(record.executionSessionId, TENANT_A, OWNER_X);
  assert.equal(closed?.state, 'CLOSED');
});

// ── 16: capability inventory / last-seen bookkeeping (real, minor coverage) ─

test('capability inventory update and last-seen touch are ownership-scoped and persist real values', async () => {
  const { devices } = buildHarness();
  const { publicKeyPem } = generateDeviceKeypair();
  const device = devices.enroll({ tenantId: TENANT_A, ownerId: OWNER_X, publicKey: publicKeyPem, agentVersion: '1.0.0', capabilityInventory: [] });

  assert.equal(devices.updateCapabilityInventory(device.deviceId, TENANT_B, OWNER_X, ['uia.invoke']), null, 'cross-tenant capability update must be blocked');
  const updated = devices.updateCapabilityInventory(device.deviceId, TENANT_A, OWNER_X, ['uia.invoke', 'process.launch']);
  assert.deepEqual(updated?.capabilityInventory, ['uia.invoke', 'process.launch']);

  const before = device.lastSeenAt;
  await new Promise((r) => setTimeout(r, 5));
  const touched = devices.touchLastSeen(device.deviceId, TENANT_A, OWNER_X);
  assert.notEqual(touched?.lastSeenAt, before);
});
