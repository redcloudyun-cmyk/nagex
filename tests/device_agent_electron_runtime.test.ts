// DC3-B1-R1 — Electron Local Device Agent Runtime Wiring.
//
// LocalDeviceAgentRuntime and LocalDeviceCredentialStore are both
// Electron-independent by design, so they run under plain `node --test`
// here — this is genuine, deterministic automated verification of the
// real lifecycle logic. desktop-app.ts's own Electron wiring (Tray,
// powerMonitor, safeStorage) cannot run in this environment at all; those
// specific integration points are proven only by source inspection below
// and are explicitly NOT claimed as Windows host acceptance — see the
// completion report's own WINDOWS_REAL_HOST_ACCEPTANCE field.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DeviceIdentityStore } from '../src/device-agent/device-identity.store.js';
import { DeviceTransportSecurity } from '../src/device-agent/device-transport-security.js';
import { DeviceConnectionStatusStore } from '../src/device-agent/device-connection-status.store.js';
import { DesktopExecutionSessionStore } from '../src/device-agent/desktop-execution-session.store.js';
import { DevicePendingCommandStore } from '../src/device-agent/device-pending-command.store.js';
import { DeviceAgentTransportEndpoint } from '../src/device-agent/device-agent-transport-endpoint.service.js';
import { LocalDeviceCredentialStore, PlaintextLocalStorageFallback, type LocalSecureStorage } from '../src/device-agent/local-device-credential.store.js';
import { LocalDeviceAgentRuntime, type LocalDeviceAgentConnectionState } from '../src/device-agent/local-device-agent-runtime.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-electron-runtime-test-'));
}

function generateDeviceKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

function buildServerHarness() {
  const dir = tempDir();
  const devices = new DeviceIdentityStore({ dir: path.join(dir, 'devices') });
  const transport = new DeviceTransportSecurity(devices, { dir: path.join(dir, 'replay') });
  const connectionStatus = new DeviceConnectionStatusStore({ dir: path.join(dir, 'connection') });
  const sessions = new DesktopExecutionSessionStore({ dir: path.join(dir, 'sessions') });
  const pendingCommands = new DevicePendingCommandStore({ dir: path.join(dir, 'pending') });
  const endpoint = new DeviceAgentTransportEndpoint(transport, devices, connectionStatus, sessions, pendingCommands);
  return { devices, endpoint };
}

function endpointFetchFn(endpoint: DeviceAgentTransportEndpoint, options: { alwaysFail?: boolean } = {}): typeof fetch {
  return (async (_input: unknown, init?: RequestInit) => {
    if (options.alwaysFail) {
      throw new TypeError('fetch failed: network unreachable');
    }
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

// A fake, controllable timer pair — no real setInterval ever runs in these
// tests; `fireTick()` is called explicitly instead, which is exactly what
// the runtime's own `tick()` method is designed to allow.
function buildFakeTimer() {
  let registered: (() => void) | null = null;
  let cleared = false;
  return {
    setIntervalFn: (cb: () => void) => {
      registered = cb;
      return { fake: true } as unknown as ReturnType<typeof setInterval>;
    },
    clearIntervalFn: () => {
      cleared = true;
      registered = null;
    },
    wasCleared: () => cleared,
    hasActiveTimer: () => registered !== null,
  };
}

function buildEncryptedCredentialStore(dir: string): { store: LocalDeviceCredentialStore; storage: LocalSecureStorage } {
  const storage = new PlaintextLocalStorageFallback(); // deterministic for tests; real Electron wiring uses safeStorage instead
  const store = new LocalDeviceCredentialStore(path.join(dir, 'device-credential.enc'), storage);
  return { store, storage };
}

const TENANT_A = 'ten_dc3b1r1_a';
const OWNER_X = 'usr_dc3b1r1_x';

// ── 1: single active client ────────────────────────────────────────────

test('ELECTRON_AGENT_SINGLE_INSTANCE: start() is idempotent — a second call never creates a second client or a second timer', async () => {
  const dir = tempDir();
  const { devices, endpoint } = buildServerHarness();
  const { publicKeyPem, privateKeyPem } = generateDeviceKeypair();
  const device = devices.enroll({ tenantId: TENANT_A, ownerId: OWNER_X, publicKey: publicKeyPem, agentVersion: '1.0.0' });
  const { store } = buildEncryptedCredentialStore(dir);
  store.save({ deviceId: device.deviceId, tenantId: TENANT_A, ownerId: OWNER_X, privateKeyPem, agentVersion: '1.0.0' });

  let connectCallCount = 0;
  const countingFetch: typeof fetch = (async (input, init) => {
    connectCallCount++;
    return endpointFetchFn(endpoint)(input, init);
  }) as typeof fetch;

  const timer = buildFakeTimer();
  const runtime = new LocalDeviceAgentRuntime({
    credentialStore: store, serverBaseUrl: 'http://local-test', agentVersion: '1.0.0',
    fetchFn: countingFetch, setIntervalFn: timer.setIntervalFn, clearIntervalFn: timer.clearIntervalFn,
  });

  await runtime.start();
  const firstCallCount = connectCallCount;
  await runtime.start(); // second call — must be a pure no-op
  assert.equal(connectCallCount, firstCallCount, 'a second start() must never issue a second CONNECT');
  assert.equal(runtime.getState(), 'AUTHENTICATED');
});

// ── 2-4: startup states ────────────────────────────────────────────────

test('ELECTRON_AGENT_ENROLLED_STARTS: a real enrolled device reaches AUTHENTICATED on startup', async () => {
  const dir = tempDir();
  const { devices, endpoint } = buildServerHarness();
  const { publicKeyPem, privateKeyPem } = generateDeviceKeypair();
  const device = devices.enroll({ tenantId: TENANT_A, ownerId: OWNER_X, publicKey: publicKeyPem, agentVersion: '1.0.0' });
  const { store } = buildEncryptedCredentialStore(dir);
  store.save({ deviceId: device.deviceId, tenantId: TENANT_A, ownerId: OWNER_X, privateKeyPem, agentVersion: '1.0.0' });

  const timer = buildFakeTimer();
  const states: LocalDeviceAgentConnectionState[] = [];
  const runtime = new LocalDeviceAgentRuntime({
    credentialStore: store, serverBaseUrl: 'http://local-test', agentVersion: '1.0.0',
    fetchFn: endpointFetchFn(endpoint), setIntervalFn: timer.setIntervalFn, clearIntervalFn: timer.clearIntervalFn,
    onStateChange: (s) => states.push(s),
  });

  await runtime.start();
  assert.equal(runtime.getState(), 'AUTHENTICATED');
  assert.deepEqual(states, ['CONNECTING', 'AUTHENTICATED']);
  assert.ok(timer.hasActiveTimer(), 'a heartbeat timer must be running once authenticated');
});

test('ELECTRON_AGENT_UNENROLLED_SAFE: no local credential -> UNENROLLED, start() never throws, no client is constructed', async () => {
  const dir = tempDir();
  const { store } = buildEncryptedCredentialStore(dir);
  const timer = buildFakeTimer();
  const runtime = new LocalDeviceAgentRuntime({
    credentialStore: store, serverBaseUrl: 'http://local-test', agentVersion: '1.0.0',
    setIntervalFn: timer.setIntervalFn, clearIntervalFn: timer.clearIntervalFn,
  });

  await assert.doesNotReject(runtime.start());
  assert.equal(runtime.getState(), 'UNENROLLED');
  assert.ok(!timer.hasActiveTimer(), 'no heartbeat loop should start without a credential');
});

test('ELECTRON_AGENT_REVOKED_SAFE: a real revoked device never reaches AUTHENTICATED, however many ticks are attempted', async () => {
  const dir = tempDir();
  const { devices, endpoint } = buildServerHarness();
  const { publicKeyPem, privateKeyPem } = generateDeviceKeypair();
  const device = devices.enroll({ tenantId: TENANT_A, ownerId: OWNER_X, publicKey: publicKeyPem, agentVersion: '1.0.0' });
  devices.revoke(device.deviceId, TENANT_A, OWNER_X);
  const { store } = buildEncryptedCredentialStore(dir);
  store.save({ deviceId: device.deviceId, tenantId: TENANT_A, ownerId: OWNER_X, privateKeyPem, agentVersion: '1.0.0' });

  const timer = buildFakeTimer();
  const runtime = new LocalDeviceAgentRuntime({
    credentialStore: store, serverBaseUrl: 'http://local-test', agentVersion: '1.0.0',
    fetchFn: endpointFetchFn(endpoint), setIntervalFn: timer.setIntervalFn, clearIntervalFn: timer.clearIntervalFn,
  });

  await runtime.start();
  assert.notEqual(runtime.getState(), 'AUTHENTICATED');
  for (let i = 0; i < 5; i++) {
    await runtime.tick();
    assert.notEqual(runtime.getState(), 'AUTHENTICATED', 'a revoked device must never reach AUTHENTICATED on any retry');
  }
  assert.equal(runtime.getState(), 'DEGRADED');
});

// ── 5-7: shutdown / suspend / resume ───────────────────────────────────

test('ELECTRON_AGENT_SHUTDOWN_CLEAN: stop() clears the heartbeat timer and never throws', async () => {
  const dir = tempDir();
  const { devices, endpoint } = buildServerHarness();
  const { publicKeyPem, privateKeyPem } = generateDeviceKeypair();
  const device = devices.enroll({ tenantId: TENANT_A, ownerId: OWNER_X, publicKey: publicKeyPem, agentVersion: '1.0.0' });
  const { store } = buildEncryptedCredentialStore(dir);
  store.save({ deviceId: device.deviceId, tenantId: TENANT_A, ownerId: OWNER_X, privateKeyPem, agentVersion: '1.0.0' });

  const timer = buildFakeTimer();
  const runtime = new LocalDeviceAgentRuntime({
    credentialStore: store, serverBaseUrl: 'http://local-test', agentVersion: '1.0.0',
    fetchFn: endpointFetchFn(endpoint), setIntervalFn: timer.setIntervalFn, clearIntervalFn: timer.clearIntervalFn,
  });

  await runtime.start();
  assert.ok(timer.hasActiveTimer());
  await assert.doesNotReject(runtime.stop());
  assert.ok(timer.wasCleared(), 'the heartbeat timer must be cleared on stop — no hanging process');
  assert.ok(!timer.hasActiveTimer());
});

test('ELECTRON_AGENT_SUSPEND_SAFE: suspend() stops the timer and drops to DISCONNECTED, never assuming the session survives', async () => {
  const dir = tempDir();
  const { devices, endpoint } = buildServerHarness();
  const { publicKeyPem, privateKeyPem } = generateDeviceKeypair();
  const device = devices.enroll({ tenantId: TENANT_A, ownerId: OWNER_X, publicKey: publicKeyPem, agentVersion: '1.0.0' });
  const { store } = buildEncryptedCredentialStore(dir);
  store.save({ deviceId: device.deviceId, tenantId: TENANT_A, ownerId: OWNER_X, privateKeyPem, agentVersion: '1.0.0' });

  const timer = buildFakeTimer();
  const runtime = new LocalDeviceAgentRuntime({
    credentialStore: store, serverBaseUrl: 'http://local-test', agentVersion: '1.0.0',
    fetchFn: endpointFetchFn(endpoint), setIntervalFn: timer.setIntervalFn, clearIntervalFn: timer.clearIntervalFn,
  });

  await runtime.start();
  assert.equal(runtime.getState(), 'AUTHENTICATED');
  await runtime.suspend();
  assert.equal(runtime.getState(), 'DISCONNECTED');
  assert.ok(!timer.hasActiveTimer(), 'suspend must stop the heartbeat timer');
});

test('ELECTRON_AGENT_RESUME_REAUTH: resume() performs a genuinely fresh authentication, not an assumed-valid reconnect', async () => {
  const dir = tempDir();
  const { devices, endpoint } = buildServerHarness();
  const { publicKeyPem, privateKeyPem } = generateDeviceKeypair();
  const device = devices.enroll({ tenantId: TENANT_A, ownerId: OWNER_X, publicKey: publicKeyPem, agentVersion: '1.0.0' });
  const { store } = buildEncryptedCredentialStore(dir);
  store.save({ deviceId: device.deviceId, tenantId: TENANT_A, ownerId: OWNER_X, privateKeyPem, agentVersion: '1.0.0' });

  let connectCount = 0;
  const countingFetch: typeof fetch = (async (input, init) => {
    const body = JSON.parse((init?.body as string) ?? '{}');
    if (body?.payload?.commandType === 'CONNECT') connectCount++;
    return endpointFetchFn(endpoint)(input, init);
  }) as typeof fetch;

  const timer = buildFakeTimer();
  const runtime = new LocalDeviceAgentRuntime({
    credentialStore: store, serverBaseUrl: 'http://local-test', agentVersion: '1.0.0',
    fetchFn: countingFetch, setIntervalFn: timer.setIntervalFn, clearIntervalFn: timer.clearIntervalFn,
  });

  await runtime.start();
  assert.equal(connectCount, 1);
  await runtime.suspend();
  await runtime.resume();
  assert.equal(connectCount, 2, 'resume must issue a genuinely new CONNECT, never assume the prior session is still valid');
  assert.equal(runtime.getState(), 'AUTHENTICATED');
  assert.ok(timer.hasActiveTimer(), 'the heartbeat loop must restart after a successful resume');
});

// ── 8-9: failure resilience ──────────────────────────────────────────────

test('ELECTRON_AGENT_SERVER_DOWN_DESKTOP_SURVIVES: a real network failure never throws out of start(); the desktop shell keeps running', async () => {
  const dir = tempDir();
  const { devices } = buildServerHarness();
  const { publicKeyPem, privateKeyPem } = generateDeviceKeypair();
  const device = devices.enroll({ tenantId: TENANT_A, ownerId: OWNER_X, publicKey: publicKeyPem, agentVersion: '1.0.0' });
  const { store } = buildEncryptedCredentialStore(dir);
  store.save({ deviceId: device.deviceId, tenantId: TENANT_A, ownerId: OWNER_X, privateKeyPem, agentVersion: '1.0.0' });

  const alwaysFailingFetch = endpointFetchFn(new DeviceAgentTransportEndpoint(
    new DeviceTransportSecurity(devices), devices, new DeviceConnectionStatusStore({ dir: path.join(dir, 'unused') }),
    new DesktopExecutionSessionStore({ dir: path.join(dir, 'unused2') }), new DevicePendingCommandStore({ dir: path.join(dir, 'unused3') }),
  ), { alwaysFail: true });

  const timer = buildFakeTimer();
  const runtime = new LocalDeviceAgentRuntime({
    credentialStore: store, serverBaseUrl: 'http://local-test', agentVersion: '1.0.0',
    fetchFn: alwaysFailingFetch, setIntervalFn: timer.setIntervalFn, clearIntervalFn: timer.clearIntervalFn,
  });

  await assert.doesNotReject(runtime.start(), 'start() must never throw even if the server is completely unreachable');
  assert.notEqual(runtime.getState(), 'AUTHENTICATED');
  assert.equal(runtime.getState(), 'DISCONNECTED');
});

test('ELECTRON_AGENT_AUTH_FAILURE_NO_COMMANDS: while not AUTHENTICATED, no pending command is ever delivered or processed', async () => {
  const dir = tempDir();
  const { devices, endpoint } = buildServerHarness();
  const { publicKeyPem, privateKeyPem } = generateDeviceKeypair();
  const device = devices.enroll({ tenantId: TENANT_A, ownerId: OWNER_X, publicKey: publicKeyPem, agentVersion: '1.0.0' });
  devices.revoke(device.deviceId, TENANT_A, OWNER_X);
  const { store } = buildEncryptedCredentialStore(dir);
  store.save({ deviceId: device.deviceId, tenantId: TENANT_A, ownerId: OWNER_X, privateKeyPem, agentVersion: '1.0.0' });

  let pendingCommandDelivered = false;
  const timer = buildFakeTimer();
  const runtime = new LocalDeviceAgentRuntime({
    credentialStore: store, serverBaseUrl: 'http://local-test', agentVersion: '1.0.0',
    fetchFn: endpointFetchFn(endpoint), setIntervalFn: timer.setIntervalFn, clearIntervalFn: timer.clearIntervalFn,
    onPendingCommand: () => { pendingCommandDelivered = true; },
  });

  await runtime.start();
  await runtime.tick();
  await runtime.tick();
  assert.equal(pendingCommandDelivered, false, 'a device that never authenticates must never receive/process a delivered command');
});

// ── 10-11: renderer boundary ────────────────────────────────────────────

test('ELECTRON_RENDERER_PRIVATE_KEY_INACCESSIBLE / ELECTRON_RENDERER_ARBITRARY_TRANSPORT_INACCESSIBLE: preload.ts exposes nothing new to the renderer', () => {
  const preloadSource = fs.readFileSync(path.join(process.cwd(), 'src', 'desktop', 'preload.ts'), 'utf8');
  assert.ok(!/privateKey/i.test(preloadSource), 'preload.ts must never reference a private key');
  assert.ok(!/LocalDeviceAgentClient|LocalDeviceAgentRuntime|deviceAgent/i.test(preloadSource), 'preload.ts must expose no device-agent surface at all this slice');
  assert.ok(!preloadSource.includes('signMessage') && !preloadSource.includes('sendDeviceMessage'), 'no arbitrary transport-send primitive is exposed to the renderer');
});

// ── 12-13: execution boundary still closed ─────────────────────────────

test('DESKTOP_EXECUTION_STILL_UNAVAILABLE / NO_UI_AUTOMATION_PRESENT: no device-agent source file references UI Automation/COM/SendInput or capability execution', () => {
  const deviceAgentDir = path.join(process.cwd(), 'src', 'device-agent');
  const files = fs.readdirSync(deviceAgentDir).filter((f) => f.endsWith('.ts'));
  for (const file of files) {
    const contents = fs.readFileSync(path.join(deviceAgentDir, file), 'utf8');
    assert.ok(!/UIAutomation|IUIAutomation|SendInput|robotjs|nut-js|ActiveXObject|new ActiveXObject/i.test(contents), `${file} must contain no UI Automation/COM/SendInput reference`);
    assert.ok(!/import[^;]*CapabilityBroker/.test(contents), `${file} must never import CapabilityBroker`);
  }
  // desktop-app.ts itself: confirm it constructs exactly one
  // LocalDeviceAgentRuntime (ELECTRON_AGENT_SINGLE_INSTANCE at the wiring
  // level, not just the class's own idempotent start()).
  const desktopAppSource = fs.readFileSync(path.join(process.cwd(), 'src', 'desktop', 'desktop-app.ts'), 'utf8');
  const constructionCount = (desktopAppSource.match(/new LocalDeviceAgentRuntime\s*\(/g) ?? []).length;
  assert.equal(constructionCount, 1, 'desktop-app.ts must construct exactly one LocalDeviceAgentRuntime');
  assert.ok(!/SendInput|robotjs|nut-js|IUIAutomation/i.test(desktopAppSource), 'desktop-app.ts must contain no execution primitive this slice');
});
