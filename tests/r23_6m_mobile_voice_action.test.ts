// R23.6M Phase B — Android Companion Foundation + Contact Resolution.
//
// Phase B scope is explicitly narrow (per the R23.6M design directive):
// device enrollment/identity, and contact candidate resolution into an
// opaque recipientRef. NO SMS send, NO KakaoTalk send, and NO mobile
// execution of any kind exists yet — this file certifies that boundary
// holds, not just the individual pieces.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DeviceIdentityStore } from '../src/device-agent/device-identity.store.js';
import { RecipientRefStore } from '../src/mobile/recipient-ref.store.js';
import { ContactResolver } from '../src/mobile/contact-resolver.service.js';
import { handleDeviceAgentRoutes } from '../src/http/routes/device-agent.routes.js';
import { handleMobileDeviceRoutes } from '../src/http/routes/mobile-device.routes.js';
import { DeviceTransportSecurity } from '../src/device-agent/device-transport-security.js';
import { DeviceConnectionStatusStore } from '../src/device-agent/device-connection-status.store.js';
import { DesktopExecutionSessionStore } from '../src/device-agent/desktop-execution-session.store.js';
import { DevicePendingCommandStore } from '../src/device-agent/device-pending-command.store.js';
import { DeviceAgentTransportEndpoint } from '../src/device-agent/device-agent-transport-endpoint.service.js';
import { SessionStore } from '../src/sessions/session.store.js';
import { NagexError } from '../src/common/errors.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-r23-6m-test-'));
}

function makeDeviceIdentityStore(): DeviceIdentityStore {
  return new DeviceIdentityStore({ dir: tempDir() });
}

function makeRecipientRefStore(): RecipientRefStore {
  return new RecipientRefStore({ dir: tempDir() });
}

function makeSessionStore(): SessionStore {
  return new SessionStore({ dir: tempDir() });
}

async function callDeviceAgentEnroll(
  deviceIdentityStore: DeviceIdentityStore,
  sessionStore: SessionStore,
  headers: Record<string, string>,
  body: Record<string, unknown>,
) {
  const deviceAgentTransportEndpoint = new DeviceAgentTransportEndpoint(
    new DeviceTransportSecurity(deviceIdentityStore),
    deviceIdentityStore,
    new DeviceConnectionStatusStore({ dir: tempDir() }),
    new DesktopExecutionSessionStore({ dir: tempDir() }),
    new DevicePendingCommandStore(),
  );
  return handleDeviceAgentRoutes('POST', '/api/v1/device-agent/enroll', body, headers, {}, { deviceAgentTransportEndpoint, deviceIdentityStore, sessionStore });
}

function callContactResolve(
  deviceIdentityStore: DeviceIdentityStore,
  contactResolver: ContactResolver,
  headers: Record<string, string>,
  body: Record<string, unknown>,
) {
  return handleMobileDeviceRoutes('POST', '/api/v1/mobile/contacts/resolve', body, headers, {}, { deviceIdentityStore, contactResolver });
}

// ─── 1. Android device enrollment is tenant/user scoped ─────────────────

test('R23.6M 1. Android device enrollment is tenant/user scoped, derived from a real session', async () => {
  const deviceIdentityStore = makeDeviceIdentityStore();
  const sessionStore = makeSessionStore();
  const session = sessionStore.createAuthSession('ten_a', 'usr_a');
  const result = await callDeviceAgentEnroll(
    deviceIdentityStore,
    sessionStore,
    { authorization: `Bearer ${session.sessionId}` },
    { publicKey: 'PEM_PUBLIC_KEY_A', agentVersion: 'android-1.0.0' },
  );
  assert.ok(result);
  assert.equal(result!.status, 201);
  const device = result!.data as { deviceId: string; tenantId: string; ownerId: string; status: string };
  assert.equal(device.tenantId, 'ten_a');
  assert.equal(device.ownerId, 'usr_a');
  assert.equal(device.status, 'ACTIVE');

  // The enrolled device is retrievable ONLY under its own tenant/owner.
  const owned = deviceIdentityStore.getOwned(device.deviceId, 'ten_a', 'usr_a');
  assert.ok(owned);
  assert.equal(deviceIdentityStore.getOwned(device.deviceId, 'ten_b', 'usr_a'), null);
  assert.equal(deviceIdentityStore.getOwned(device.deviceId, 'ten_a', 'usr_b'), null);
});

// ─── Phase B4 security audit — enrollment cannot be spoofed via headers ──

test('R23.6M 1a. enrollment with NO session is rejected, even if x-nagex-tenant/x-principal-id headers are present', async () => {
  const deviceIdentityStore = makeDeviceIdentityStore();
  const sessionStore = makeSessionStore();
  await assert.rejects(
    () => callDeviceAgentEnroll(
      deviceIdentityStore,
      sessionStore,
      { 'x-nagex-tenant': 'ten_victim', 'x-principal-id': 'usr_victim' },
      { publicKey: 'PK', agentVersion: 'android-1.0.0' },
    ),
    (err: unknown) => err instanceof NagexError && err.code === 'DEVICE_ENROLL_AUTH_REQUIRED',
  );
});

test('R23.6M 1b. a caller cannot enroll a device for an arbitrary tenant/principal by setting headers — the real session always wins', async () => {
  const deviceIdentityStore = makeDeviceIdentityStore();
  const sessionStore = makeSessionStore();
  // A real, legitimately authenticated session for ten_a/usr_a...
  const session = sessionStore.createAuthSession('ten_a', 'usr_a');
  // ...but the caller ALSO sets spoofed headers claiming to be a different
  // tenant/user entirely. The session must win completely; the headers
  // must have zero effect.
  const result = await callDeviceAgentEnroll(
    deviceIdentityStore,
    sessionStore,
    {
      authorization: `Bearer ${session.sessionId}`,
      'x-nagex-tenant': 'ten_victim',
      'x-principal-id': 'usr_victim',
    },
    { publicKey: 'PK', agentVersion: 'android-1.0.0' },
  );
  const device = result!.data as { tenantId: string; ownerId: string };
  assert.equal(device.tenantId, 'ten_a');
  assert.equal(device.ownerId, 'usr_a');
  assert.notEqual(device.tenantId, 'ten_victim');
  assert.notEqual(device.ownerId, 'usr_victim');
});

test('R23.6M 1c. a revoked/expired/unknown session cannot enroll a device', async () => {
  const deviceIdentityStore = makeDeviceIdentityStore();
  const sessionStore = makeSessionStore();
  const session = sessionStore.createAuthSession('ten_a', 'usr_a');
  sessionStore.revokeSession(session.sessionId);

  await assert.rejects(
    () => callDeviceAgentEnroll(
      deviceIdentityStore,
      sessionStore,
      { authorization: `Bearer ${session.sessionId}` },
      { publicKey: 'PK', agentVersion: 'android-1.0.0' },
    ),
    (err: unknown) => err instanceof NagexError && err.code === 'DEVICE_ENROLL_AUTH_REQUIRED',
  );

  await assert.rejects(
    () => callDeviceAgentEnroll(
      deviceIdentityStore,
      sessionStore,
      { authorization: 'Bearer sess_totally_made_up' },
      { publicKey: 'PK', agentVersion: 'android-1.0.0' },
    ),
    (err: unknown) => err instanceof NagexError && err.code === 'DEVICE_ENROLL_AUTH_REQUIRED',
  );
});

test('R23.6M 1d. the device public key is stored server-side; no private key material ever appears in the enrollment response or record', async () => {
  const deviceIdentityStore = makeDeviceIdentityStore();
  const sessionStore = makeSessionStore();
  const session = sessionStore.createAuthSession('ten_a', 'usr_a');
  const result = await callDeviceAgentEnroll(
    deviceIdentityStore,
    sessionStore,
    { authorization: `Bearer ${session.sessionId}` },
    { publicKey: 'PEM_PUBLIC_KEY_ONLY', agentVersion: 'android-1.0.0' },
  );
  const device = result!.data as Record<string, unknown>;
  assert.equal(device.publicKey, 'PEM_PUBLIC_KEY_ONLY');
  assert.equal('privateKey' in device, false);
});

// ─── 2. revoked device cannot act ────────────────────────────────────────

test('R23.6M 2. a revoked device cannot resolve contacts', () => {
  const deviceIdentityStore = makeDeviceIdentityStore();
  const contactResolver = new ContactResolver(makeRecipientRefStore());
  const device = deviceIdentityStore.enroll({ tenantId: 'ten_a', ownerId: 'usr_a', publicKey: 'PK', agentVersion: 'android-1.0.0' });
  deviceIdentityStore.revoke(device.deviceId, 'ten_a', 'usr_a');

  assert.throws(
    () => callContactResolve(
      deviceIdentityStore,
      contactResolver,
      { 'x-nagex-tenant': 'ten_a', 'x-principal-id': 'usr_a' },
      { deviceId: device.deviceId, spokenName: 'Alex', candidates: [{ contactId: 'c1', displayName: 'Alex Kim' }] },
    ),
    (err: unknown) => err instanceof NagexError && err.code === 'MOBILE_DEVICE_REVOKED',
  );
});

// ─── 3. cross-user device access blocked ─────────────────────────────────

test('R23.6M 3. cross-user device access is blocked for contact resolution', () => {
  const deviceIdentityStore = makeDeviceIdentityStore();
  const contactResolver = new ContactResolver(makeRecipientRefStore());
  const device = deviceIdentityStore.enroll({ tenantId: 'ten_a', ownerId: 'usr_a', publicKey: 'PK', agentVersion: 'android-1.0.0' });

  assert.throws(
    () => callContactResolve(
      deviceIdentityStore,
      contactResolver,
      { 'x-nagex-tenant': 'ten_a', 'x-principal-id': 'usr_b' },
      { deviceId: device.deviceId, spokenName: 'Alex', candidates: [{ contactId: 'c1', displayName: 'Alex Kim' }] },
    ),
    (err: unknown) => err instanceof NagexError && err.code === 'MOBILE_DEVICE_NOT_FOUND',
  );
});

// ─── 4. cross-tenant device access blocked ───────────────────────────────

test('R23.6M 4. cross-tenant device access is blocked for contact resolution', () => {
  const deviceIdentityStore = makeDeviceIdentityStore();
  const contactResolver = new ContactResolver(makeRecipientRefStore());
  const device = deviceIdentityStore.enroll({ tenantId: 'ten_a', ownerId: 'usr_a', publicKey: 'PK', agentVersion: 'android-1.0.0' });

  assert.throws(
    () => callContactResolve(
      deviceIdentityStore,
      contactResolver,
      { 'x-nagex-tenant': 'ten_b', 'x-principal-id': 'usr_a' },
      { deviceId: device.deviceId, spokenName: 'Alex', candidates: [{ contactId: 'c1', displayName: 'Alex Kim' }] },
    ),
    (err: unknown) => err instanceof NagexError && err.code === 'MOBILE_DEVICE_NOT_FOUND',
  );
});

// ─── 5. contact candidate list is scoped ─────────────────────────────────

test('R23.6M 5. a resolved recipientRef is scoped to tenant/owner/device and invisible to another device', () => {
  const deviceIdentityStore = makeDeviceIdentityStore();
  const recipientRefStore = makeRecipientRefStore();
  const contactResolver = new ContactResolver(recipientRefStore);
  const deviceA = deviceIdentityStore.enroll({ tenantId: 'ten_a', ownerId: 'usr_a', publicKey: 'PK_A', agentVersion: 'android-1.0.0' });
  const deviceB = deviceIdentityStore.enroll({ tenantId: 'ten_a', ownerId: 'usr_a', publicKey: 'PK_B', agentVersion: 'android-1.0.0' });

  const result = contactResolver.resolve({
    tenantId: 'ten_a', ownerId: 'usr_a', deviceId: deviceA.deviceId, spokenName: '김대진',
    candidates: [{ contactId: 'android_c1', displayName: '김대진 대표' }],
    requestId: 'req_1',
  });
  assert.equal(result.status, 'UNIQUE');
  const ref = result.recipientRef!;

  assert.ok(recipientRefStore.getOwned(ref, 'ten_a', 'usr_a', deviceA.deviceId));
  // Same tenant/owner, but a DIFFERENT device — must not resolve.
  assert.equal(recipientRefStore.getOwned(ref, 'ten_a', 'usr_a', deviceB.deviceId), null);
});

// ─── 6. unique contact creates canonical recipientRef ────────────────────

test('R23.6M 6. a unique matching candidate creates a canonical recipientRef', () => {
  const contactResolver = new ContactResolver(makeRecipientRefStore());
  const result = contactResolver.resolve({
    tenantId: 'ten_a', ownerId: 'usr_a', deviceId: 'dev_1', spokenName: 'Alex',
    candidates: [{ contactId: 'c1', displayName: 'Alex Kim' }],
    requestId: 'req_1',
  });
  assert.equal(result.status, 'UNIQUE');
  assert.equal(typeof result.recipientRef, 'string');
  assert.ok(result.recipientRef!.startsWith('rcp_'));
  assert.equal(result.displayName, 'Alex Kim');

  // Resolving the exact same contact again reuses the same ref rather than
  // minting a new one.
  const again = contactResolver.resolve({
    tenantId: 'ten_a', ownerId: 'usr_a', deviceId: 'dev_1', spokenName: 'Alex',
    candidates: [{ contactId: 'c1', displayName: 'Alex Kim' }],
    requestId: 'req_2',
  });
  assert.equal(again.recipientRef, result.recipientRef);
});

// ─── 7. duplicate names require clarification ────────────────────────────

test('R23.6M 7. two distinct matching contacts are AMBIGUOUS, never auto-picked', () => {
  const contactResolver = new ContactResolver(makeRecipientRefStore());
  const result = contactResolver.resolve({
    tenantId: 'ten_a', ownerId: 'usr_a', deviceId: 'dev_1', spokenName: '김대진',
    candidates: [
      { contactId: 'c1', displayName: '김대진 (주식회사 A)' },
      { contactId: 'c2', displayName: '김대진 (주식회사 B)' },
    ],
    requestId: 'req_1',
  });
  assert.equal(result.status, 'AMBIGUOUS');
  assert.equal(result.candidates?.length, 2);
  assert.equal(result.recipientRef, undefined);
});

// ─── 8. no candidate fails closed ────────────────────────────────────────

test('R23.6M 8. zero matching candidates is NOT_FOUND, never a guessed match', () => {
  const contactResolver = new ContactResolver(makeRecipientRefStore());
  const noneAtAll = contactResolver.resolve({
    tenantId: 'ten_a', ownerId: 'usr_a', deviceId: 'dev_1', spokenName: '김대진', candidates: [], requestId: 'req_1',
  });
  assert.equal(noneAtAll.status, 'NOT_FOUND');

  // Candidates exist, but none actually match the spoken name — the
  // resolver must not fall back to "well, there's one candidate anyway".
  const noMatch = contactResolver.resolve({
    tenantId: 'ten_a', ownerId: 'usr_a', deviceId: 'dev_1', spokenName: '박민수',
    candidates: [{ contactId: 'c1', displayName: '이철수' }],
    requestId: 'req_2',
  });
  assert.equal(noMatch.status, 'NOT_FOUND');
});

// ─── 9. raw voice text cannot directly become recipientRef ───────────────

test('R23.6M 9. spoken text alone, without a genuinely matching device candidate, never becomes a recipientRef', () => {
  const recipientRefStore = makeRecipientRefStore();
  const contactResolver = new ContactResolver(recipientRefStore);
  // A malicious/buggy device sends a candidate whose displayName has
  // nothing to do with the spoken name.
  const result = contactResolver.resolve({
    tenantId: 'ten_a', ownerId: 'usr_a', deviceId: 'dev_1', spokenName: '김대진',
    candidates: [{ contactId: 'c1', displayName: 'Completely Unrelated Name' }],
    requestId: 'req_1',
  });
  assert.equal(result.status, 'NOT_FOUND');
  assert.equal(result.recipientRef, undefined);
});

// ─── 10. LLM cannot fabricate recipientRef ────────────────────────────────

test('R23.6M 10. a recipientRef is only ever produced by RecipientRefStore.mintOrReuse — an arbitrary string is never accepted as a valid one', () => {
  const recipientRefStore = makeRecipientRefStore();
  // Simulates an LLM or any other caller fabricating a plausible-looking
  // recipientRef string rather than going through resolution.
  const fabricated = 'rcp_fabricated0000000000000000';
  assert.equal(recipientRefStore.getOwned(fabricated, 'ten_a', 'usr_a', 'dev_1'), null);
});

// ─── 11. approval infrastructure remains unchanged ───────────────────────

test('R23.6M 11. ActionApprovalStore is untouched by R23.6M — same public surface as before', async () => {
  const { ActionApprovalStore } = await import('../src/governance/action-approval.store.js');
  const store = new ActionApprovalStore();
  // Exercises the exact same request/approve/consume surface R23.6E relied
  // on — R23.6M adds no new approval primitives, no parallel store.
  const record = store.request({ toolId: 'mobile.send_sms', tenantId: 'ten_a', principalId: 'usr_a', payload: { recipientRef: 'rcp_x', message: 'hi' } });
  assert.equal(record.status, 'PENDING');
  const approved = store.approve(record.approvalId, 'ten_a', 'usr_a', 'req_1');
  assert.equal(approved.status, 'APPROVED');
});

// ─── 12. no mobile execution occurs in Phase B ───────────────────────────

test('R23.6M 12. no SMS/KakaoTalk execution path exists in any Phase B file (structural check)', () => {
  // Historical note: this test originally also asserted that
  // device-agent-protocol.ts had gained no MOBILE_MESSAGE_* command types
  // at all — true for Phase B, and it caught the exact moment Phase C
  // legitimately added exactly three of them (MOBILE_MESSAGE_PREPARE/
  // EXECUTE/STATUS, never a generic vocabulary — see
  // r23_6m_phase_c_sms_execution.test.ts and
  // r23_6m_phase_c_device_transport.test.ts for what now certifies that
  // boundary). That assertion is retired here, not weakened: the Phase B
  // files themselves — contact resolution only, never message
  // execution — remain exactly as constrained as before.
  const filesToCheck = [
    'src/mobile/contact-resolution.types.ts',
    'src/mobile/recipient-ref.store.ts',
    'src/mobile/contact-resolver.service.ts',
    'src/http/routes/mobile-device.routes.ts',
  ];
  for (const rel of filesToCheck) {
    const content = fs.readFileSync(rel, 'utf8').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(content, /SmsManager|sendTextMessage|kakaotalk.*send|MOBILE_MESSAGE_EXECUTE/i, `${rel} must not contain any message-execution logic`);
  }
});
