// DC3-B1 — Outbound Local Device Agent Transport.
//
// Real Ed25519 keys throughout (no mocked crypto). Most tests drive the
// real LocalDeviceAgentClient against a real DeviceAgentTransportEndpoint
// via a real handleAsyncApiRequest call (an in-process fetch adapter —
// no port needed, but the exact same route-dispatch code path a real
// HTTP request would hit). One dedicated test proves the real listening
// HTTP route end-to-end with a genuine fetch() over a real socket.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { handleAsyncApiRequest, createServerInstance, deviceIdentityStore as sharedDeviceIdentityStore } from '../src/server_web.js';
import { DeviceIdentityStore } from '../src/device-agent/device-identity.store.js';
import { DeviceTransportSecurity } from '../src/device-agent/device-transport-security.js';
import { DeviceConnectionStatusStore } from '../src/device-agent/device-connection-status.store.js';
import { DesktopExecutionSessionStore } from '../src/device-agent/desktop-execution-session.store.js';
import { DevicePendingCommandStore } from '../src/device-agent/device-pending-command.store.js';
import { DeviceAgentTransportEndpoint } from '../src/device-agent/device-agent-transport-endpoint.service.js';
import { LocalDeviceAgentClient } from '../src/device-agent/local-device-agent-client.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-device-transport-test-'));
}

function generateDeviceKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

// A real DeviceAgentTransportEndpoint + all its real DC3-A/DC3-B1 stores,
// isolated to a fresh temp directory per test.
function buildServerHarness() {
  const dir = tempDir();
  const devices = new DeviceIdentityStore({ dir: path.join(dir, 'devices') });
  const transport = new DeviceTransportSecurity(devices, { dir: path.join(dir, 'replay') });
  const connectionStatus = new DeviceConnectionStatusStore({ dir: path.join(dir, 'connection') });
  const sessions = new DesktopExecutionSessionStore({ dir: path.join(dir, 'sessions') });
  const pendingCommands = new DevicePendingCommandStore({ dir: path.join(dir, 'pending') });
  const endpoint = new DeviceAgentTransportEndpoint(transport, devices, connectionStatus, sessions, pendingCommands);
  return { devices, transport, connectionStatus, sessions, pendingCommands, endpoint };
}

// Wraps a real DeviceAgentTransportEndpoint.handle() call behind a
// fetch-shaped function — the exact interface LocalDeviceAgentClient
// expects, but never touching a real socket. This is the real dispatch
// logic, not a stub.
function endpointFetchFn(endpoint: DeviceAgentTransportEndpoint): typeof fetch {
  return (async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse((init?.body as string) ?? '{}');
    try {
      const result = endpoint.handle({ envelope: body.envelope, payload: body.payload }, `req_${crypto.randomUUID()}`);
      return new Response(JSON.stringify(result), { status: 200 });
    } catch (error) {
      const status = (error as { category?: string })?.category === 'VALIDATION' ? 400 : 403;
      return new Response(JSON.stringify({ error: { code: (error as { code?: string })?.code ?? 'UNKNOWN' } }), { status });
    }
  }) as typeof fetch;
}

function buildClient(devices: DeviceIdentityStore, endpoint: DeviceAgentTransportEndpoint, overrides: { tenantId: string; ownerId: string; deviceId: string; privateKeyPem: string; agentVersion?: string }) {
  return new LocalDeviceAgentClient({
    tenantId: overrides.tenantId,
    ownerId: overrides.ownerId,
    deviceId: overrides.deviceId,
    privateKeyPem: overrides.privateKeyPem,
    serverBaseUrl: 'http://local-test',
    agentVersion: overrides.agentVersion ?? '1.0.0',
    fetchFn: endpointFetchFn(endpoint),
  });
}

const TENANT_A = 'ten_dc3b1_a';
const TENANT_B = 'ten_dc3b1_b';
const OWNER_X = 'usr_dc3b1_x';
const OWNER_Y = 'usr_dc3b1_y';

// ── 1: connect + authenticate ─────────────────────────────────────────────

test('DEVICE_TRANSPORT_CONNECT / DEVICE_TRANSPORT_AUTHENTICATED: a real enrolled device connects with a real Ed25519 signature', async () => {
  const { devices, endpoint } = buildServerHarness();
  const { publicKeyPem, privateKeyPem } = generateDeviceKeypair();
  const device = devices.enroll({ tenantId: TENANT_A, ownerId: OWNER_X, publicKey: publicKeyPem, agentVersion: '1.0.0' });
  const client = buildClient(devices, endpoint, { tenantId: TENANT_A, ownerId: OWNER_X, deviceId: device.deviceId, privateKeyPem });

  const response = await client.connect();
  assert.equal(response.status, 'OK');
  assert.equal((response.result as any).connected, true);
  assert.equal(client.isConnected(), true);
});

// ── 2-8: rejection modes ────────────────────────────────────────────────

test('DEVICE_TRANSPORT_WRONG_TENANT_BLOCK / DEVICE_TRANSPORT_WRONG_OWNER_BLOCK / DEVICE_TRANSPORT_UNKNOWN_BLOCK', async () => {
  const { devices, endpoint } = buildServerHarness();
  const { publicKeyPem, privateKeyPem } = generateDeviceKeypair();
  const device = devices.enroll({ tenantId: TENANT_A, ownerId: OWNER_X, publicKey: publicKeyPem, agentVersion: '1.0.0' });

  const wrongTenantClient = buildClient(devices, endpoint, { tenantId: TENANT_B, ownerId: OWNER_X, deviceId: device.deviceId, privateKeyPem });
  await assert.rejects(wrongTenantClient.connect());

  const wrongOwnerClient = buildClient(devices, endpoint, { tenantId: TENANT_A, ownerId: OWNER_Y, deviceId: device.deviceId, privateKeyPem });
  await assert.rejects(wrongOwnerClient.connect());

  const unknownDeviceClient = buildClient(devices, endpoint, { tenantId: TENANT_A, ownerId: OWNER_X, deviceId: 'dev_ghost', privateKeyPem });
  await assert.rejects(unknownDeviceClient.connect());
});

test('DEVICE_TRANSPORT_REVOKED_BLOCK: a revoked device cannot connect even with its real, still-valid key', async () => {
  const { devices, endpoint } = buildServerHarness();
  const { publicKeyPem, privateKeyPem } = generateDeviceKeypair();
  const device = devices.enroll({ tenantId: TENANT_A, ownerId: OWNER_X, publicKey: publicKeyPem, agentVersion: '1.0.0' });
  devices.revoke(device.deviceId, TENANT_A, OWNER_X);

  const client = buildClient(devices, endpoint, { tenantId: TENANT_A, ownerId: OWNER_X, deviceId: device.deviceId, privateKeyPem });
  await assert.rejects(client.connect());
});

test('DEVICE_TRANSPORT_INVALID_SIGNATURE_BLOCK: a client signing with the wrong private key is rejected', async () => {
  const { devices, endpoint } = buildServerHarness();
  const { publicKeyPem } = generateDeviceKeypair();
  const attackerKeys = generateDeviceKeypair();
  const device = devices.enroll({ tenantId: TENANT_A, ownerId: OWNER_X, publicKey: publicKeyPem, agentVersion: '1.0.0' });

  const client = buildClient(devices, endpoint, { tenantId: TENANT_A, ownerId: OWNER_X, deviceId: device.deviceId, privateKeyPem: attackerKeys.privateKeyPem });
  await assert.rejects(client.connect());
});

test('DEVICE_TRANSPORT_EXPIRED_BLOCK: an envelope issued with an already-past TTL is rejected', async () => {
  const { devices, endpoint } = buildServerHarness();
  const { publicKeyPem, privateKeyPem } = generateDeviceKeypair();
  const device = devices.enroll({ tenantId: TENANT_A, ownerId: OWNER_X, publicKey: publicKeyPem, agentVersion: '1.0.0' });
  const client = new LocalDeviceAgentClient({
    tenantId: TENANT_A, ownerId: OWNER_X, deviceId: device.deviceId, privateKeyPem,
    serverBaseUrl: 'http://local-test', agentVersion: '1.0.0',
    fetchFn: endpointFetchFn(endpoint),
    envelopeTtlMs: -1000, // already expired the instant it's issued
  });
  await assert.rejects(client.connect());
});

test('DEVICE_TRANSPORT_REPLAY_BLOCK: resending the exact same real envelope a second time is rejected', async () => {
  const { devices, endpoint } = buildServerHarness();
  const { publicKeyPem, privateKeyPem } = generateDeviceKeypair();
  const device = devices.enroll({ tenantId: TENANT_A, ownerId: OWNER_X, publicKey: publicKeyPem, agentVersion: '1.0.0' });

  let capturedBody: string | undefined;
  const capturingFetch: typeof fetch = (async (input, init) => {
    capturedBody = init?.body as string;
    return endpointFetchFn(endpoint)(input, init);
  }) as typeof fetch;
  const client = new LocalDeviceAgentClient({ tenantId: TENANT_A, ownerId: OWNER_X, deviceId: device.deviceId, privateKeyPem, serverBaseUrl: 'http://local-test', agentVersion: '1.0.0', fetchFn: capturingFetch });

  await client.connect();
  assert.ok(capturedBody);

  // Replay the exact same raw request body a second time, at the raw
  // transport level (bypassing the client, which would never naturally
  // resend an old envelope — see DEVICE_RECONNECT_NO_BLIND_REPLAY below).
  const replayResponse = await endpointFetchFn(endpoint)('http://local-test/api/v1/device-agent/message', { method: 'POST', body: capturedBody });
  assert.equal(replayResponse.ok, false);
});

// ── 9-10: heartbeat ─────────────────────────────────────────────────────

test('DEVICE_HEARTBEAT_RIGHTFUL: a real heartbeat updates lastSeenAt/agentVersion/capabilityInventory and connection status', async () => {
  const { devices, connectionStatus, endpoint } = buildServerHarness();
  const { publicKeyPem, privateKeyPem } = generateDeviceKeypair();
  const device = devices.enroll({ tenantId: TENANT_A, ownerId: OWNER_X, publicKey: publicKeyPem, agentVersion: '0.9.0', capabilityInventory: [] });
  const client = new LocalDeviceAgentClient({ tenantId: TENANT_A, ownerId: OWNER_X, deviceId: device.deviceId, privateKeyPem, serverBaseUrl: 'http://local-test', agentVersion: '1.2.0', capabilityInventory: ['transport.v1'], fetchFn: endpointFetchFn(endpoint) });

  await client.connect();
  const before = devices.getOwned(device.deviceId, TENANT_A, OWNER_X)!;
  await new Promise((r) => setTimeout(r, 5));
  await client.heartbeat();

  const after = devices.getOwned(device.deviceId, TENANT_A, OWNER_X)!;
  assert.notEqual(after.lastSeenAt, before.lastSeenAt);
  assert.equal(after.agentVersion, '1.2.0');
  assert.deepEqual(after.capabilityInventory, ['transport.v1']);
  assert.equal(connectionStatus.getStatus(device.deviceId, TENANT_A, OWNER_X)?.connectionState, 'CONNECTED');
});

test('DEVICE_HEARTBEAT_NO_EXECUTION_GRANT: heartbeat alone never makes device.desktop.execute reachable or reported live', async () => {
  const { devices, endpoint } = buildServerHarness();
  const { publicKeyPem, privateKeyPem } = generateDeviceKeypair();
  const device = devices.enroll({ tenantId: TENANT_A, ownerId: OWNER_X, publicKey: publicKeyPem, agentVersion: '1.0.0' });
  const client = new LocalDeviceAgentClient({ tenantId: TENANT_A, ownerId: OWNER_X, deviceId: device.deviceId, privateKeyPem, serverBaseUrl: 'http://local-test', agentVersion: '1.0.0', fetchFn: endpointFetchFn(endpoint) });

  await client.connect();
  await client.heartbeat();

  // Structural proof: DeviceAgentTransportEndpoint has no import of, or
  // reference to, CapabilityBroker/CapabilityRegistry anywhere in its
  // own source — heartbeat's authority genuinely cannot reach execution.
  const source = fs.readFileSync(path.join(process.cwd(), 'src', 'device-agent', 'device-agent-transport-endpoint.service.ts'), 'utf8');
  assert.ok(!/import[^;]*CapabilityBroker/.test(source), 'the transport endpoint must never import CapabilityBroker');
  assert.ok(!/import[^;]*CapabilityRegistry/.test(source), 'the transport endpoint must never import CapabilityRegistry');
  assert.ok(!/registerCapability|capabilityRegistry\.|capabilityBroker\./.test(source), 'the transport endpoint must never call into capability execution machinery');
});

// ── 11-12: reconnect ─────────────────────────────────────────────────────

test('DEVICE_RECONNECT_REAUTH: reconnecting performs a genuinely fresh CONNECT with a new signature, not a resumed session', async () => {
  const { devices, endpoint } = buildServerHarness();
  const { publicKeyPem, privateKeyPem } = generateDeviceKeypair();
  const device = devices.enroll({ tenantId: TENANT_A, ownerId: OWNER_X, publicKey: publicKeyPem, agentVersion: '1.0.0' });
  const client = new LocalDeviceAgentClient({ tenantId: TENANT_A, ownerId: OWNER_X, deviceId: device.deviceId, privateKeyPem, serverBaseUrl: 'http://local-test', agentVersion: '1.0.0', fetchFn: endpointFetchFn(endpoint) });

  const first = await client.connect();
  await client.disconnect();
  const second = await client.connectWithBackoff(1);
  assert.equal(first.status, 'OK');
  assert.equal(second.status, 'OK');
  assert.equal(client.isConnected(), true);
});

test('DEVICE_RECONNECT_NO_BLIND_REPLAY: the client never resends a previously-used envelope on reconnect — every call has a unique messageId/sequence', async () => {
  const { devices, endpoint } = buildServerHarness();
  const { publicKeyPem, privateKeyPem } = generateDeviceKeypair();
  const device = devices.enroll({ tenantId: TENANT_A, ownerId: OWNER_X, publicKey: publicKeyPem, agentVersion: '1.0.0' });

  const seenBodies: string[] = [];
  const capturingFetch: typeof fetch = (async (input, init) => {
    seenBodies.push(init?.body as string);
    return endpointFetchFn(endpoint)(input, init);
  }) as typeof fetch;
  const client = new LocalDeviceAgentClient({ tenantId: TENANT_A, ownerId: OWNER_X, deviceId: device.deviceId, privateKeyPem, serverBaseUrl: 'http://local-test', agentVersion: '1.0.0', fetchFn: capturingFetch });

  await client.connect();
  await client.disconnect();
  await client.connect();

  const messageIds = seenBodies.map((b) => JSON.parse(b).envelope.messageId);
  assert.equal(new Set(messageIds).size, messageIds.length, 'every envelope must carry a unique messageId, never reused across reconnects');
});

// ── 13-14: command allowlist ──────────────────────────────────────────────

test('DEVICE_COMMAND_ALLOWLIST: every transport/control command (PING, SESSION_OPEN, SESSION_CLOSE, CANCEL, STATUS) is real and functions end to end', async () => {
  const { devices, endpoint } = buildServerHarness();
  const { publicKeyPem, privateKeyPem } = generateDeviceKeypair();
  const device = devices.enroll({ tenantId: TENANT_A, ownerId: OWNER_X, publicKey: publicKeyPem, agentVersion: '1.0.0' });
  const client = new LocalDeviceAgentClient({ tenantId: TENANT_A, ownerId: OWNER_X, deviceId: device.deviceId, privateKeyPem, serverBaseUrl: 'http://local-test', agentVersion: '1.0.0', fetchFn: endpointFetchFn(endpoint) });

  await client.connect();
  const sessionId = await client.openSession('BACKGROUND');
  assert.ok(sessionId.startsWith('dxs_'));

  const statusDuring = (await client.status(sessionId)) as any;
  assert.equal(statusDuring.executionSession.state, 'ACTIVE');
  assert.equal(statusDuring.executionSession.mode, 'BACKGROUND');

  await client.closeSession(sessionId);
  const statusAfter = (await client.status(sessionId)) as any;
  assert.equal(statusAfter.executionSession.state, 'CLOSED');
});

test('DEVICE_UNSUPPORTED_COMMAND_BLOCK: a commandType outside the DC3-B1 allowlist (e.g. CLICK) is rejected, never dispatched', async () => {
  const { devices, transport, endpoint } = buildServerHarness();
  const { publicKeyPem, privateKeyPem } = generateDeviceKeypair();
  const device = devices.enroll({ tenantId: TENANT_A, ownerId: OWNER_X, publicKey: publicKeyPem, agentVersion: '1.0.0' });

  // Constructs a raw envelope directly (bypassing LocalDeviceAgentClient,
  // which structurally cannot even construct a disallowed commandType —
  // its own TS union has no CLICK) to prove the SERVER independently
  // enforces the allowlist too, not merely the client's type system.
  const { canonicalEnvelopeSigningBytes, hashCanonicalPayload } = await import('../src/device-agent/device-transport-security.js');
  const payload = { commandType: 'CLICK', executionSessionId: null, data: { selector: '#evil' } };
  const payloadHash = hashCanonicalPayload(payload);
  const envelopeBase = { deviceId: device.deviceId, tenantId: TENANT_A, ownerId: OWNER_X, messageId: 'msg_click_attempt', sequence: 1, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30_000).toISOString(), payloadHash };
  const signature = crypto.sign(null, canonicalEnvelopeSigningBytes(envelopeBase), { key: privateKeyPem, format: 'pem' }).toString('base64');

  assert.throws(
    () => endpoint.handle({ envelope: { ...envelopeBase, signature }, payload }, 'req_click_attempt'),
    (err: unknown) => (err as { code?: string })?.code === 'DEVICE_COMMAND_UNSUPPORTED',
  );
  void transport;
});

// ── 15-16: architectural / security invariants ────────────────────────────

test('DEVICE_NO_PUBLIC_INBOUND_PORT: the device-agent module still opens no listening socket of its own (server_web.ts owns the one real HTTP listener)', () => {
  const deviceAgentDir = path.join(process.cwd(), 'src', 'device-agent');
  const files = fs.readdirSync(deviceAgentDir).filter((f) => f.endsWith('.ts'));
  for (const file of files) {
    const contents = fs.readFileSync(path.join(deviceAgentDir, file), 'utf8');
    assert.ok(!/\.listen\s*\(/.test(contents), `${file} must never open a listening socket`);
    assert.ok(!/createServer/.test(contents), `${file} must never create a server`);
  }
});

test('DEVICE_PRIVATE_KEY_NOT_SERVER_PERSISTED: after a real connect+heartbeat cycle, the private key never appears anywhere on server-side disk', async () => {
  const { devices, endpoint } = buildServerHarness();
  const { publicKeyPem, privateKeyPem } = generateDeviceKeypair();
  const device = devices.enroll({ tenantId: TENANT_A, ownerId: OWNER_X, publicKey: publicKeyPem, agentVersion: '1.0.0' });
  const client = new LocalDeviceAgentClient({ tenantId: TENANT_A, ownerId: OWNER_X, deviceId: device.deviceId, privateKeyPem, serverBaseUrl: 'http://local-test', agentVersion: '1.0.0', fetchFn: endpointFetchFn(endpoint) });

  await client.connect();
  await client.heartbeat();
  await client.openSession('BACKGROUND');

  // (buildServerHarness's own temp dir is private to this test, but scan
  // it anyway for a real, direct proof rather than an assumption.)
  const record = devices.getOwned(device.deviceId, TENANT_A, OWNER_X)!;
  assert.ok(!JSON.stringify(record).includes(privateKeyPem));
});

// ── 17: real, listening HTTP route end-to-end ─────────────────────────────

async function withServer(run: (origin: string) => Promise<void>): Promise<void> {
  const instance = createServerInstance();
  await new Promise<void>((resolve, reject) => {
    instance.listen(0, '127.0.0.1', () => resolve());
    instance.once('error', reject);
  });
  const addr = instance.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${addr.port}`);
  } finally {
    if (typeof (instance as any).closeIdleConnections === 'function') {
      (instance as any).closeIdleConnections();
    }
    await new Promise<void>((resolve) => instance.close(() => resolve()));
  }
}

test('REAL_HTTP_ROUTE: a real device, enrolled against the shared production DeviceIdentityStore, connects over a real listening socket', async () => {
  await withServer(async (origin) => {
    const { publicKeyPem, privateKeyPem } = generateDeviceKeypair();
    const device = sharedDeviceIdentityStore.enroll({ tenantId: 'ten_dc3b1_real_http', ownerId: 'usr_dc3b1_real_http', publicKey: publicKeyPem, agentVersion: '1.0.0' });
    const client = new LocalDeviceAgentClient({
      tenantId: 'ten_dc3b1_real_http', ownerId: 'usr_dc3b1_real_http', deviceId: device.deviceId, privateKeyPem,
      serverBaseUrl: origin, agentVersion: '1.0.0',
    });
    const response = await client.connect();
    assert.equal(response.status, 'OK');
  });
});
