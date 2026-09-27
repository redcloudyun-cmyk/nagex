// R23.6M Phase C — HTTP route-level certification for
// /api/v1/mobile/messages: every new Phase C mobile endpoint requires a
// real, validated session — never the spoofable x-nagex-tenant/
// x-principal-id headers — and recipientRef ownership is independently
// re-checked at the route layer (via MobileMessageRunService, which in
// turn goes through RecipientRefStore.getOwned), not just trusted from
// the request body.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleMobileMessageRoutes } from '../src/http/routes/mobile-message.routes.js';
import { SessionStore } from '../src/sessions/session.store.js';
import { DeviceIdentityStore } from '../src/device-agent/device-identity.store.js';
import { MobileMessageRunStore } from '../src/mobile/mobile-message-run.store.js';
import { MobileMessageRunService } from '../src/mobile/mobile-message-run.service.js';
import { RecipientRefStore } from '../src/mobile/recipient-ref.store.js';
import { ActionApprovalStore } from '../src/governance/action-approval.store.js';
import { NagexError } from '../src/common/errors.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-r23-6m-phase-c-routes-test-'));
}

function makeHarness() {
  const sessionStore = new SessionStore({ dir: tempDir() });
  const deviceIdentityStore = new DeviceIdentityStore({ dir: tempDir() });
  const runStore = new MobileMessageRunStore({ dir: tempDir() });
  const recipientRefStore = new RecipientRefStore({ dir: tempDir() });
  const approvals = new ActionApprovalStore();
  const mobileMessageRunService = new MobileMessageRunService(runStore, recipientRefStore, approvals);
  return { sessionStore, deviceIdentityStore, recipientRefStore, mobileMessageRunService };
}

function call(deps: ReturnType<typeof makeHarness>, method: string, pathname: string, body: Record<string, unknown>, headers: Record<string, string>) {
  return handleMobileMessageRoutes(method, pathname, body, headers, {}, {
    sessionStore: deps.sessionStore,
    deviceIdentityStore: deps.deviceIdentityStore,
    mobileMessageRunService: deps.mobileMessageRunService,
  });
}

test('R23.6M-C-routes 1. creating an SMS draft with no session is rejected, even with x-nagex-tenant/x-principal-id headers present', () => {
  const deps = makeHarness();
  assert.throws(
    () => call(deps, 'POST', '/api/v1/mobile/messages', { deviceId: 'dev_1', recipientRef: 'rcp_x', message: 'hi' }, { 'x-nagex-tenant': 'ten_victim', 'x-principal-id': 'usr_victim' }),
    (err: unknown) => err instanceof NagexError && err.code === 'MOBILE_MESSAGE_AUTH_REQUIRED',
  );
});

test('R23.6M-C-routes 2. a real session always determines tenant/owner, spoofed headers have zero effect', () => {
  const deps = makeHarness();
  const session = deps.sessionStore.createAuthSession('ten_a', 'usr_a');
  const device = deps.deviceIdentityStore.enroll({ tenantId: 'ten_a', ownerId: 'usr_a', publicKey: 'PK', agentVersion: '1.0.0' });
  const ref = deps.recipientRefStore.mintOrReuse({ tenantId: 'ten_a', ownerId: 'usr_a', deviceId: device.deviceId, androidContactId: 'c1', displayName: 'Alex' });

  const result = call(
    deps, 'POST', '/api/v1/mobile/messages',
    { deviceId: device.deviceId, recipientRef: ref.recipientRef, message: 'hi' },
    { authorization: `Bearer ${session.sessionId}`, 'x-nagex-tenant': 'ten_victim', 'x-principal-id': 'usr_victim' },
  );
  const run = result!.data as { tenantId: string; ownerId: string };
  assert.equal(run.tenantId, 'ten_a');
  assert.equal(run.ownerId, 'usr_a');
});

test('R23.6M-C-routes 3. a device belonging to a different tenant/owner cannot be used to create a draft', () => {
  const deps = makeHarness();
  const session = deps.sessionStore.createAuthSession('ten_a', 'usr_a');
  const otherDevice = deps.deviceIdentityStore.enroll({ tenantId: 'ten_b', ownerId: 'usr_b', publicKey: 'PK', agentVersion: '1.0.0' });

  assert.throws(
    () => call(deps, 'POST', '/api/v1/mobile/messages', { deviceId: otherDevice.deviceId, recipientRef: 'rcp_x', message: 'hi' }, { authorization: `Bearer ${session.sessionId}` }),
    (err: unknown) => err instanceof NagexError && err.code === 'MOBILE_MESSAGE_DEVICE_NOT_FOUND',
  );
});

test('R23.6M-C-routes 4. a revoked device is rejected at the route layer before any draft is created', () => {
  const deps = makeHarness();
  const session = deps.sessionStore.createAuthSession('ten_a', 'usr_a');
  const device = deps.deviceIdentityStore.enroll({ tenantId: 'ten_a', ownerId: 'usr_a', publicKey: 'PK', agentVersion: '1.0.0' });
  deps.deviceIdentityStore.revoke(device.deviceId, 'ten_a', 'usr_a');

  assert.throws(
    () => call(deps, 'POST', '/api/v1/mobile/messages', { deviceId: device.deviceId, recipientRef: 'rcp_x', message: 'hi' }, { authorization: `Bearer ${session.sessionId}` }),
    (err: unknown) => err instanceof NagexError && err.code === 'MOBILE_MESSAGE_DEVICE_REVOKED',
  );
});

test('R23.6M-C-routes 5. cross-tenant recipientRef is rejected', () => {
  const deps = makeHarness();
  const session = deps.sessionStore.createAuthSession('ten_a', 'usr_a');
  const device = deps.deviceIdentityStore.enroll({ tenantId: 'ten_a', ownerId: 'usr_a', publicKey: 'PK', agentVersion: '1.0.0' });
  const foreignRef = deps.recipientRefStore.mintOrReuse({ tenantId: 'ten_b', ownerId: 'usr_a', deviceId: device.deviceId, androidContactId: 'c1', displayName: 'Alex' });

  assert.throws(
    () => call(deps, 'POST', '/api/v1/mobile/messages', { deviceId: device.deviceId, recipientRef: foreignRef.recipientRef, message: 'hi' }, { authorization: `Bearer ${session.sessionId}` }),
    (err: unknown) => err instanceof NagexError && err.code === 'MOBILE_MESSAGE_RECIPIENT_INVALID',
  );
});

test('R23.6M-C-routes 6. cross-user recipientRef is rejected', () => {
  const deps = makeHarness();
  const session = deps.sessionStore.createAuthSession('ten_a', 'usr_a');
  const device = deps.deviceIdentityStore.enroll({ tenantId: 'ten_a', ownerId: 'usr_a', publicKey: 'PK', agentVersion: '1.0.0' });
  const foreignRef = deps.recipientRefStore.mintOrReuse({ tenantId: 'ten_a', ownerId: 'usr_other', deviceId: device.deviceId, androidContactId: 'c1', displayName: 'Alex' });

  assert.throws(
    () => call(deps, 'POST', '/api/v1/mobile/messages', { deviceId: device.deviceId, recipientRef: foreignRef.recipientRef, message: 'hi' }, { authorization: `Bearer ${session.sessionId}` }),
    (err: unknown) => err instanceof NagexError && err.code === 'MOBILE_MESSAGE_RECIPIENT_INVALID',
  );
});

test('R23.6M-C-routes 7. cross-device recipientRef (same tenant/owner, different device) is rejected', () => {
  const deps = makeHarness();
  const session = deps.sessionStore.createAuthSession('ten_a', 'usr_a');
  const deviceA = deps.deviceIdentityStore.enroll({ tenantId: 'ten_a', ownerId: 'usr_a', publicKey: 'PK_A', agentVersion: '1.0.0' });
  const deviceB = deps.deviceIdentityStore.enroll({ tenantId: 'ten_a', ownerId: 'usr_a', publicKey: 'PK_B', agentVersion: '1.0.0' });
  const refForB = deps.recipientRefStore.mintOrReuse({ tenantId: 'ten_a', ownerId: 'usr_a', deviceId: deviceB.deviceId, androidContactId: 'c1', displayName: 'Alex' });

  assert.throws(
    () => call(deps, 'POST', '/api/v1/mobile/messages', { deviceId: deviceA.deviceId, recipientRef: refForB.recipientRef, message: 'hi' }, { authorization: `Bearer ${session.sessionId}` }),
    (err: unknown) => err instanceof NagexError && err.code === 'MOBILE_MESSAGE_RECIPIENT_INVALID',
  );
});
