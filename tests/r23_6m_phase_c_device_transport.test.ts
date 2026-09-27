// R23.6M Phase C — real signed-transport dispatch for the three new
// MOBILE_MESSAGE_* command types. Real Ed25519 keys throughout, the exact
// same DeviceAgentTransportEndpoint.handle() dispatch path a real HTTP
// request hits — proves the wire-level integration (signature
// verification -> command routing -> MobileMessageRunService), not just
// the service-level logic already certified in
// r23_6m_phase_c_sms_execution.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DeviceIdentityStore } from '../src/device-agent/device-identity.store.js';
import { DeviceTransportSecurity, canonicalEnvelopeSigningBytes, hashCanonicalPayload as hashPayload } from '../src/device-agent/device-transport-security.js';
import { DeviceConnectionStatusStore } from '../src/device-agent/device-connection-status.store.js';
import { DesktopExecutionSessionStore } from '../src/device-agent/desktop-execution-session.store.js';
import { DevicePendingCommandStore } from '../src/device-agent/device-pending-command.store.js';
import { DeviceAgentTransportEndpoint } from '../src/device-agent/device-agent-transport-endpoint.service.js';
import { MobileMessageRunStore } from '../src/mobile/mobile-message-run.store.js';
import { MobileMessageRunService } from '../src/mobile/mobile-message-run.service.js';
import { RecipientRefStore } from '../src/mobile/recipient-ref.store.js';
import { ActionApprovalStore } from '../src/governance/action-approval.store.js';
import { NagexError } from '../src/common/errors.js';
import type { DeviceAgentCommandType } from '../src/device-agent/device-agent-protocol.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-r23-6m-phase-c-transport-test-'));
}

function generateDeviceKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey,
  };
}

function buildHarness() {
  const dir = tempDir();
  const devices = new DeviceIdentityStore({ dir: path.join(dir, 'devices') });
  const transport = new DeviceTransportSecurity(devices, { dir: path.join(dir, 'replay') });
  const connectionStatus = new DeviceConnectionStatusStore({ dir: path.join(dir, 'connection') });
  const sessions = new DesktopExecutionSessionStore({ dir: path.join(dir, 'sessions') });
  const pendingCommands = new DevicePendingCommandStore({ dir: path.join(dir, 'pending') });
  const runStore = new MobileMessageRunStore({ dir: path.join(dir, 'runs') });
  const recipientRefStore = new RecipientRefStore({ dir: path.join(dir, 'refs') });
  const approvals = new ActionApprovalStore();
  const mobileMessages = new MobileMessageRunService(runStore, recipientRefStore, approvals);
  const endpoint = new DeviceAgentTransportEndpoint(transport, devices, connectionStatus, sessions, pendingCommands, mobileMessages);
  return { devices, recipientRefStore, approvals, mobileMessages, endpoint };
}

let sequenceCounter = 0;

function sendSigned(
  endpoint: DeviceAgentTransportEndpoint,
  deviceId: string,
  tenantId: string,
  ownerId: string,
  privateKey: crypto.KeyObject,
  commandType: DeviceAgentCommandType,
  data: Record<string, unknown>,
) {
  const payload = { commandType, executionSessionId: null, data };
  const payloadHash = hashPayload(payload);
  const envelopeCore = {
    deviceId,
    tenantId,
    ownerId,
    messageId: `msg_${crypto.randomUUID()}`,
    sequence: ++sequenceCounter,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    payloadHash,
  };
  const signature = crypto.sign(null, canonicalEnvelopeSigningBytes(envelopeCore), privateKey).toString('base64');
  const envelope = { ...envelopeCore, signature };
  return endpoint.handle({ envelope, payload }, `req_${crypto.randomUUID()}`);
}

test('R23.6M-C-transport 1. a real signed PREPARE -> EXECUTE -> STATUS(SENT_CONFIRMED) flow works end to end', () => {
  const { devices, recipientRefStore, approvals, mobileMessages, endpoint } = buildHarness();
  const { publicKeyPem, privateKey } = generateDeviceKeypair();
  const device = devices.enroll({ tenantId: 'ten_a', ownerId: 'usr_a', publicKey: publicKeyPem, agentVersion: '1.0.0' });

  const ref = recipientRefStore.mintOrReuse({ tenantId: 'ten_a', ownerId: 'usr_a', deviceId: device.deviceId, androidContactId: 'c1', displayName: 'Alex' });
  let run = mobileMessages.createDraft({ tenantId: 'ten_a', ownerId: 'usr_a', deviceId: device.deviceId, requestId: 'req_1', recipientRef: ref.recipientRef, message: 'Running late' });
  run = mobileMessages.requestApproval(run.runId, 'ten_a', 'usr_a', 'req_2');
  approvals.approve(run.approvalId!, 'ten_a', 'usr_a', 'req_3');
  run = mobileMessages.confirmApproval(run.runId, 'ten_a', 'usr_a', 'req_4');
  assert.equal(run.status, 'APPROVED');

  const prepareResult = sendSigned(endpoint, device.deviceId, 'ten_a', 'usr_a', privateKey, 'MOBILE_MESSAGE_PREPARE', { runId: run.runId });
  assert.deepEqual(prepareResult.result, { recipientRef: ref.recipientRef, message: 'Running late' });

  const executeResult = sendSigned(endpoint, device.deviceId, 'ten_a', 'usr_a', privateKey, 'MOBILE_MESSAGE_EXECUTE', { runId: run.runId });
  assert.equal((executeResult.result as any).status, 'SEND_ATTEMPTED');

  const statusResult = sendSigned(endpoint, device.deviceId, 'ten_a', 'usr_a', privateKey, 'MOBILE_MESSAGE_STATUS', { runId: run.runId, result: 'SENT_CONFIRMED' });
  assert.equal((statusResult.result as any).status, 'SENT_CONFIRMED');
});

test('R23.6M-C-transport 2. a revoked device cannot PREPARE or EXECUTE, even with a real valid signature', () => {
  const { devices, recipientRefStore, approvals, mobileMessages, endpoint } = buildHarness();
  const { publicKeyPem, privateKey } = generateDeviceKeypair();
  const device = devices.enroll({ tenantId: 'ten_a', ownerId: 'usr_a', publicKey: publicKeyPem, agentVersion: '1.0.0' });

  const ref = recipientRefStore.mintOrReuse({ tenantId: 'ten_a', ownerId: 'usr_a', deviceId: device.deviceId, androidContactId: 'c1', displayName: 'Alex' });
  let run = mobileMessages.createDraft({ tenantId: 'ten_a', ownerId: 'usr_a', deviceId: device.deviceId, requestId: 'req_1', recipientRef: ref.recipientRef, message: 'hi' });
  run = mobileMessages.requestApproval(run.runId, 'ten_a', 'usr_a', 'req_2');
  approvals.approve(run.approvalId!, 'ten_a', 'usr_a', 'req_3');
  run = mobileMessages.confirmApproval(run.runId, 'ten_a', 'usr_a', 'req_4');

  devices.revoke(device.deviceId, 'ten_a', 'usr_a');

  assert.throws(
    () => sendSigned(endpoint, device.deviceId, 'ten_a', 'usr_a', privateKey, 'MOBILE_MESSAGE_PREPARE', { runId: run.runId }),
    (err: unknown) => err instanceof NagexError && err.code === 'DEVICE_TRANSPORT_REJECTED',
  );
  assert.throws(
    () => sendSigned(endpoint, device.deviceId, 'ten_a', 'usr_a', privateKey, 'MOBILE_MESSAGE_EXECUTE', { runId: run.runId }),
    (err: unknown) => err instanceof NagexError && err.code === 'DEVICE_TRANSPORT_REJECTED',
  );

  // The run itself is untouched by the rejected attempts.
  const stillApproved = mobileMessages.getOwnedRun(run.runId, 'ten_a', 'usr_a')!;
  assert.equal(stillApproved.status, 'APPROVED');
});

test('R23.6M-C-transport 3. a forged signature (wrong key) is rejected before any run state is touched', () => {
  const { devices, recipientRefStore, mobileMessages, endpoint } = buildHarness();
  const { publicKeyPem } = generateDeviceKeypair();
  const { privateKey: wrongPrivateKey } = generateDeviceKeypair();
  const device = devices.enroll({ tenantId: 'ten_a', ownerId: 'usr_a', publicKey: publicKeyPem, agentVersion: '1.0.0' });
  const ref = recipientRefStore.mintOrReuse({ tenantId: 'ten_a', ownerId: 'usr_a', deviceId: device.deviceId, androidContactId: 'c1', displayName: 'Alex' });
  const run = mobileMessages.createDraft({ tenantId: 'ten_a', ownerId: 'usr_a', deviceId: device.deviceId, requestId: 'req_1', recipientRef: ref.recipientRef, message: 'hi' });

  assert.throws(
    () => sendSigned(endpoint, device.deviceId, 'ten_a', 'usr_a', wrongPrivateKey, 'MOBILE_MESSAGE_PREPARE', { runId: run.runId }),
    (err: unknown) => err instanceof NagexError && err.code === 'DEVICE_TRANSPORT_REJECTED',
  );
});
