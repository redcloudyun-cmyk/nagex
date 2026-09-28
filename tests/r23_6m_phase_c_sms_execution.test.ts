// R23.6M Phase C — one complete real SMS execution flow: server-side
// orchestration, approval binding/drift protection, duplicate-send
// protection, and device-binding. Real device SmsManager execution and
// phone-number resolution are certified separately on physical hardware
// (this file never sees, and the server never holds, a phone number at
// all — recipientRef only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MobileMessageRunStore } from '../src/mobile/mobile-message-run.store.js';
import { MobileMessageRunService } from '../src/mobile/mobile-message-run.service.js';
import { RecipientRefStore } from '../src/mobile/recipient-ref.store.js';
import { ActionApprovalStore, hashCanonicalPayload } from '../src/governance/action-approval.store.js';
import { NagexError } from '../src/common/errors.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-r23-6m-phase-c-test-'));
}

function makeHarness() {
  const runStore = new MobileMessageRunStore({ dir: tempDir() });
  const recipientRefStore = new RecipientRefStore({ dir: tempDir() });
  const approvals = new ActionApprovalStore();
  const auditEvents: any[] = [];
  const auditLogger = { logEvent: (event: any) => { auditEvents.push(event); return event; } };
  const service = new MobileMessageRunService(runStore, recipientRefStore, approvals, auditLogger);
  return { runStore, recipientRefStore, approvals, auditEvents, service };
}

function mintRecipientRef(recipientRefStore: RecipientRefStore, overrides: Partial<{ tenantId: string; ownerId: string; deviceId: string }> = {}) {
  return recipientRefStore.mintOrReuse({
    tenantId: overrides.tenantId ?? 'ten_a',
    ownerId: overrides.ownerId ?? 'usr_a',
    deviceId: overrides.deviceId ?? 'dev_1',
    androidContactId: 'android_c1',
    displayName: 'Alex Kim',
  });
}

// ─── 1. Full happy path ───────────────────────────────────────────────────

test('R23.6M-C 1. full happy path: draft -> approve -> prepare -> execute -> sent -> delivered', () => {
  const { recipientRefStore, approvals, service } = makeHarness();
  const ref = mintRecipientRef(recipientRefStore);

  let run = service.createDraft({ tenantId: 'ten_a', ownerId: 'usr_a', deviceId: 'dev_1', requestId: 'req_1', recipientRef: ref.recipientRef, message: 'Running 10 minutes late.' });
  assert.equal(run.status, 'DRAFT_CREATED');

  run = service.requestApproval(run.runId, 'ten_a', 'usr_a', 'req_2');
  assert.equal(run.status, 'APPROVAL_REQUIRED');
  assert.ok(run.approvalId);

  approvals.approve(run.approvalId!, 'ten_a', 'usr_a', 'req_3');
  run = service.confirmApproval(run.runId, 'ten_a', 'usr_a', 'req_4');
  assert.equal(run.status, 'APPROVED');

  const prepared = service.prepareForExecution(run.runId, 'ten_a', 'usr_a', 'dev_1', 'req_5');
  assert.equal(prepared.recipientRef, ref.recipientRef);
  assert.equal(prepared.message, 'Running 10 minutes late.');

  run = service.executeApproved(run.runId, 'ten_a', 'usr_a', 'dev_1', 'req_6');
  assert.equal(run.status, 'SEND_ATTEMPTED');
  assert.ok(run.executionId);

  run = service.reportSendResult(run.runId, 'ten_a', 'usr_a', 'dev_1', 'req_7', 'SENT_CONFIRMED');
  assert.equal(run.status, 'SENT_CONFIRMED');

  run = service.reportDeliveryConfirmed(run.runId, 'ten_a', 'usr_a', 'dev_1', 'req_8');
  assert.equal(run.status, 'DELIVERY_CONFIRMED');
  assert.equal(run.deliveryConfirmed, true);
});

// ─── 2. Reject -> zero SMS ─────────────────────────────────────────────────

test('R23.6M-C 2. approval reject blocks the run; execute is never reachable', () => {
  const { recipientRefStore, approvals, service } = makeHarness();
  const ref = mintRecipientRef(recipientRefStore);
  let run = service.createDraft({ tenantId: 'ten_a', ownerId: 'usr_a', deviceId: 'dev_1', requestId: 'req_1', recipientRef: ref.recipientRef, message: 'hi' });
  run = service.requestApproval(run.runId, 'ten_a', 'usr_a', 'req_2');
  approvals.reject(run.approvalId!, 'ten_a', 'usr_a', 'req_3');
  run = service.confirmApproval(run.runId, 'ten_a', 'usr_a', 'req_4');
  assert.equal(run.status, 'BLOCKED');
  assert.equal(run.failureReason, 'APPROVAL_REJECTED');

  assert.throws(
    () => service.executeApproved(run.runId, 'ten_a', 'usr_a', 'dev_1', 'req_5'),
    (err: unknown) => err instanceof NagexError && err.code === 'MOBILE_MESSAGE_EXECUTE_REJECTED',
  );
});

// ─── 3. Message changed after approval -> blocked ─────────────────────────

test('R23.6M-C 3. message changed after approval is caught at execute time and blocked', () => {
  const { recipientRefStore, approvals, service } = makeHarness();
  const ref = mintRecipientRef(recipientRefStore);
  let run = service.createDraft({ tenantId: 'ten_a', ownerId: 'usr_a', deviceId: 'dev_1', requestId: 'req_1', recipientRef: ref.recipientRef, message: 'Original message' });
  run = service.requestApproval(run.runId, 'ten_a', 'usr_a', 'req_2');
  approvals.approve(run.approvalId!, 'ten_a', 'usr_a', 'req_3');
  run = service.confirmApproval(run.runId, 'ten_a', 'usr_a', 'req_4');
  assert.equal(run.status, 'APPROVED');

  service.updateDraftMessage(run.runId, 'ten_a', 'usr_a', 'req_5', 'A completely different message');

  assert.throws(
    () => service.executeApproved(run.runId, 'ten_a', 'usr_a', 'dev_1', 'req_6'),
    (err: unknown) => err instanceof NagexError && err.code === 'MOBILE_MESSAGE_PAYLOAD_DRIFT',
  );

  const afterDrift = service.getOwnedRun(run.runId, 'ten_a', 'usr_a')!;
  assert.equal(afterDrift.status, 'APPROVAL_REQUIRED');
  assert.notEqual(afterDrift.approvalId, run.approvalId, 'a fresh approval must be minted for the new payload');

  // The stale approval must never be usable for anything else either.
  assert.throws(
    () => approvals.consume(run.approvalId!, 'ten_a', 'usr_a', 'mobile.send_sms', {} as any, 'req_7', 'exe_x'),
    (err: unknown) => err instanceof NagexError,
  );
});

// ─── 4. Recipient changed after approval -> blocked ───────────────────────

test('R23.6M-C 4. recipient changed after approval is caught by the same hash-binding, never silently sent to the new recipient', () => {
  const { runStore, recipientRefStore, approvals, service } = makeHarness();
  const refA = mintRecipientRef(recipientRefStore);
  const refB = recipientRefStore.mintOrReuse({ tenantId: 'ten_a', ownerId: 'usr_a', deviceId: 'dev_1', androidContactId: 'android_c2', displayName: 'Someone Else' });

  let run = service.createDraft({ tenantId: 'ten_a', ownerId: 'usr_a', deviceId: 'dev_1', requestId: 'req_1', recipientRef: refA.recipientRef, message: 'hi' });
  run = service.requestApproval(run.runId, 'ten_a', 'usr_a', 'req_2');
  approvals.approve(run.approvalId!, 'ten_a', 'usr_a', 'req_3');
  run = service.confirmApproval(run.runId, 'ten_a', 'usr_a', 'req_4');

  // No public API changes a run's recipient after creation (by design —
  // a different recipient is a different run in the real product). This
  // directly proves the underlying defense (payload-hash binding covers
  // recipientRef, not just message) rather than exercising a feature that
  // deliberately does not exist.
  runStore.save({ ...run, recipientRef: refB.recipientRef });

  assert.throws(
    () => service.executeApproved(run.runId, 'ten_a', 'usr_a', 'dev_1', 'req_5'),
    (err: unknown) => err instanceof NagexError && err.code === 'MOBILE_MESSAGE_PAYLOAD_DRIFT',
  );
});

// ─── 5. The approval hash genuinely covers channel/deviceId/executionRoute,
// not just message/recipientRef ────────────────────────────────────────────
//
// Phase C only ever constructs channel='SMS'/executionRoute=
// 'ANDROID_SMS_MANAGER' (compile-time-fixed literals — there is no second
// legitimate value to "change" one to, so this cannot be exercised through
// the store the way message/recipientRef drift can without writing a
// record the store's own validator correctly refuses to read back as
// unrecognized/invalid). Instead this proves the same property directly:
// the approval's bound payload — and therefore its hash — genuinely
// includes channel/deviceId/executionRoute, so ANY future channel this
// milestone adds is automatically covered by the exact same drift
// protection without further code changes.

test('R23.6M-C 5. the approved payload hash covers channel, deviceId, and executionRoute, not only message/recipientRef', () => {
  const { recipientRefStore, approvals, service } = makeHarness();
  const ref = mintRecipientRef(recipientRefStore);
  let run = service.createDraft({ tenantId: 'ten_a', ownerId: 'usr_a', deviceId: 'dev_1', requestId: 'req_1', recipientRef: ref.recipientRef, message: 'hi' });
  run = service.requestApproval(run.runId, 'ten_a', 'usr_a', 'req_2');

  const approval = approvals.get(run.approvalId!, 'ten_a', 'usr_a')!;
  assert.equal(approval.canonicalPayload.channel, 'SMS');
  assert.equal(approval.canonicalPayload.deviceId, 'dev_1');
  assert.equal(approval.canonicalPayload.executionRoute, 'ANDROID_SMS_MANAGER');

  // A payload missing/altering any one of these three fields must hash
  // differently and therefore fail consume()'s comparison — proving they
  // are load-bearing, not decorative.
  const tamperedChannel = hashCanonicalPayload({ ...approval.canonicalPayload, channel: 'KAKAOTALK' });
  const tamperedDevice = hashCanonicalPayload({ ...approval.canonicalPayload, deviceId: 'dev_intruder' });
  const tamperedRoute = hashCanonicalPayload({ ...approval.canonicalPayload, executionRoute: 'OTHER' });
  assert.notEqual(tamperedChannel, approval.payloadHash);
  assert.notEqual(tamperedDevice, approval.payloadHash);
  assert.notEqual(tamperedRoute, approval.payloadHash);
});

// ─── 6. Duplicate execution attempt -> blocked ────────────────────────────

test('R23.6M-C 6. a second execute attempt for the same run is rejected (Layer 1: state graph)', () => {
  const { recipientRefStore, approvals, service } = makeHarness();
  const ref = mintRecipientRef(recipientRefStore);
  let run = service.createDraft({ tenantId: 'ten_a', ownerId: 'usr_a', deviceId: 'dev_1', requestId: 'req_1', recipientRef: ref.recipientRef, message: 'hi' });
  run = service.requestApproval(run.runId, 'ten_a', 'usr_a', 'req_2');
  approvals.approve(run.approvalId!, 'ten_a', 'usr_a', 'req_3');
  run = service.confirmApproval(run.runId, 'ten_a', 'usr_a', 'req_4');

  run = service.executeApproved(run.runId, 'ten_a', 'usr_a', 'dev_1', 'req_5');
  assert.equal(run.status, 'SEND_ATTEMPTED');

  assert.throws(
    () => service.executeApproved(run.runId, 'ten_a', 'usr_a', 'dev_1', 'req_6'),
    (err: unknown) => err instanceof NagexError && err.code === 'MOBILE_MESSAGE_EXECUTE_REJECTED',
  );
  // The approval store's own one-time consumption is Layer 2 defense in
  // depth — confirm it independently also rejects replay.
  assert.throws(
    () => approvals.consume(run.approvalId!, 'ten_a', 'usr_a', 'mobile.send_sms', {} as any, 'req_7', 'exe_replay'),
    (err: unknown) => err instanceof NagexError && err.code === 'APPROVAL_ALREADY_CONSUMED',
  );
});

// ─── 7. Device mismatch -> blocked ────────────────────────────────────────

test('R23.6M-C 7. a different device cannot prepare or execute a run bound to another device', () => {
  const { recipientRefStore, approvals, service } = makeHarness();
  const ref = mintRecipientRef(recipientRefStore);
  let run = service.createDraft({ tenantId: 'ten_a', ownerId: 'usr_a', deviceId: 'dev_1', requestId: 'req_1', recipientRef: ref.recipientRef, message: 'hi' });
  run = service.requestApproval(run.runId, 'ten_a', 'usr_a', 'req_2');
  approvals.approve(run.approvalId!, 'ten_a', 'usr_a', 'req_3');
  run = service.confirmApproval(run.runId, 'ten_a', 'usr_a', 'req_4');

  assert.throws(
    () => service.prepareForExecution(run.runId, 'ten_a', 'usr_a', 'dev_2_intruder', 'req_5'),
    (err: unknown) => err instanceof NagexError && err.code === 'MOBILE_MESSAGE_DEVICE_MISMATCH',
  );
  assert.throws(
    () => service.executeApproved(run.runId, 'ten_a', 'usr_a', 'dev_2_intruder', 'req_6'),
    (err: unknown) => err instanceof NagexError && err.code === 'MOBILE_MESSAGE_DEVICE_MISMATCH',
  );
  // The legitimate device is untouched by the intruder's rejected attempts.
  const stillApproved = service.getOwnedRun(run.runId, 'ten_a', 'usr_a')!;
  assert.equal(stillApproved.status, 'APPROVED');
});

// ─── 8. Invalid/missing recipient -> no send ──────────────────────────────

test('R23.6M-C 8. an unowned/nonexistent recipientRef cannot start a draft', () => {
  const { service } = makeHarness();
  assert.throws(
    () => service.createDraft({ tenantId: 'ten_a', ownerId: 'usr_a', deviceId: 'dev_1', requestId: 'req_1', recipientRef: 'rcp_fabricated', message: 'hi' }),
    (err: unknown) => err instanceof NagexError && err.code === 'MOBILE_MESSAGE_RECIPIENT_INVALID',
  );
});

// ─── 9. Send failure surfaced truthfully ──────────────────────────────────

test('R23.6M-C 9. a real device-reported send failure is recorded truthfully, never silently retried', () => {
  const { recipientRefStore, approvals, service } = makeHarness();
  const ref = mintRecipientRef(recipientRefStore);
  let run = service.createDraft({ tenantId: 'ten_a', ownerId: 'usr_a', deviceId: 'dev_1', requestId: 'req_1', recipientRef: ref.recipientRef, message: 'hi' });
  run = service.requestApproval(run.runId, 'ten_a', 'usr_a', 'req_2');
  approvals.approve(run.approvalId!, 'ten_a', 'usr_a', 'req_3');
  run = service.confirmApproval(run.runId, 'ten_a', 'usr_a', 'req_4');
  run = service.executeApproved(run.runId, 'ten_a', 'usr_a', 'dev_1', 'req_5');

  run = service.reportSendResult(run.runId, 'ten_a', 'usr_a', 'dev_1', 'req_6', 'SEND_FAILED');
  assert.equal(run.status, 'FAILED');
  assert.equal(run.failureReason, 'SEND_FAILED');

  // No automatic retry mechanism exists — the run is terminal.
  assert.throws(
    () => service.executeApproved(run.runId, 'ten_a', 'usr_a', 'dev_1', 'req_7'),
    (err: unknown) => err instanceof NagexError,
  );
});

// ─── 10. SEND_STATUS_UNKNOWN — never guessed, never auto-retried ─────────

test('R23.6M-C 10. an ambiguous send result leaves the run at SEND_ATTEMPTED forever, never guessed into success or failure', () => {
  const { recipientRefStore, approvals, service } = makeHarness();
  const ref = mintRecipientRef(recipientRefStore);
  let run = service.createDraft({ tenantId: 'ten_a', ownerId: 'usr_a', deviceId: 'dev_1', requestId: 'req_1', recipientRef: ref.recipientRef, message: 'hi' });
  run = service.requestApproval(run.runId, 'ten_a', 'usr_a', 'req_2');
  approvals.approve(run.approvalId!, 'ten_a', 'usr_a', 'req_3');
  run = service.confirmApproval(run.runId, 'ten_a', 'usr_a', 'req_4');
  run = service.executeApproved(run.runId, 'ten_a', 'usr_a', 'dev_1', 'req_5');

  run = service.reportSendResult(run.runId, 'ten_a', 'usr_a', 'dev_1', 'req_6', 'SEND_STATUS_UNKNOWN');
  assert.equal(run.status, 'SEND_ATTEMPTED');
  assert.equal(run.failureReason, null);

  // A genuinely new send attempt requires a brand-new run and approval —
  // never reusing the consumed one, exactly like R23.6E's own precedent.
  assert.throws(
    () => service.executeApproved(run.runId, 'ten_a', 'usr_a', 'dev_1', 'req_7'),
    (err: unknown) => err instanceof NagexError && err.code === 'MOBILE_MESSAGE_EXECUTE_REJECTED',
  );
});

// ─── 11. No raw phone number ever appears anywhere ────────────────────────

test('R23.6M-C 11. no raw phone number field exists in the run record, approval payload, or audit details', () => {
  const { recipientRefStore, approvals, service, auditEvents } = makeHarness();
  const ref = mintRecipientRef(recipientRefStore);
  let run = service.createDraft({ tenantId: 'ten_a', ownerId: 'usr_a', deviceId: 'dev_1', requestId: 'req_1', recipientRef: ref.recipientRef, message: 'Call me at 010-1234-5678' });
  run = service.requestApproval(run.runId, 'ten_a', 'usr_a', 'req_2');
  approvals.approve(run.approvalId!, 'ten_a', 'usr_a', 'req_3');
  run = service.confirmApproval(run.runId, 'ten_a', 'usr_a', 'req_4');
  run = service.executeApproved(run.runId, 'ten_a', 'usr_a', 'dev_1', 'req_5');
  service.reportSendResult(run.runId, 'ten_a', 'usr_a', 'dev_1', 'req_6', 'SENT_CONFIRMED');

  assert.equal('phoneNumber' in run, false);
  assert.equal('phone' in run, false);

  const approval = approvals.get(run.approvalId!, 'ten_a', 'usr_a');
  assert.equal('phoneNumber' in (approval?.canonicalPayload ?? {}), false);

  // The message MAY happen to contain a phone number as ordinary content
  // (the user's own message text) — that is fine and expected. What must
  // never happen is the raw message text leaking into audit metadata: only
  // a digest + length ever appear there.
  for (const event of auditEvents) {
    assert.equal('message' in (event.details ?? {}), false);
    assert.equal('phoneNumber' in (event.details ?? {}), false);
    if (event.details?.messageDigest) {
      assert.notEqual(event.details.messageDigest, run.message);
    }
  }
});

// ─── 12. Cross-tenant/owner isolation ─────────────────────────────────────

test('R23.6M-C 12. cross-tenant and cross-owner access to a run is indistinguishable from nonexistent', () => {
  const { recipientRefStore, service } = makeHarness();
  const ref = mintRecipientRef(recipientRefStore);
  const run = service.createDraft({ tenantId: 'ten_a', ownerId: 'usr_a', deviceId: 'dev_1', requestId: 'req_1', recipientRef: ref.recipientRef, message: 'hi' });

  assert.equal(service.getOwnedRun(run.runId, 'ten_b', 'usr_a'), undefined);
  assert.equal(service.getOwnedRun(run.runId, 'ten_a', 'usr_b'), undefined);
});

// ─── 13. ActionApprovalStore is reused completely unchanged ──────────────

test('R23.6M-C 13. mobile SMS approvals flow through the exact same ActionApprovalStore as every other consequential action', () => {
  const { recipientRefStore, approvals, service } = makeHarness();
  const ref = mintRecipientRef(recipientRefStore);
  let run = service.createDraft({ tenantId: 'ten_a', ownerId: 'usr_a', deviceId: 'dev_1', requestId: 'req_1', recipientRef: ref.recipientRef, message: 'hi' });
  run = service.requestApproval(run.runId, 'ten_a', 'usr_a', 'req_2');

  const approval = approvals.get(run.approvalId!, 'ten_a', 'usr_a');
  assert.equal(approval?.toolId, 'mobile.send_sms');
  assert.equal(approval?.status, 'PENDING');
  assert.deepEqual(approval?.canonicalPayload, {
    canonicalAction: 'SEND_MESSAGE',
    recipientRef: ref.recipientRef,
    channel: 'SMS',
    message: 'hi',
    environment: 'ANDROID',
    provider: 'DEVICE_NATIVE',
    deviceId: 'dev_1',
    executionRoute: 'ANDROID_SMS_MANAGER',
  });
});

// ─── 15. Expired approval blocks execution ────────────────────────────────

test('R23.6M-C 15. an expired approval blocks the run, execute is never reachable', () => {
  const runStore = new MobileMessageRunStore({ dir: tempDir() });
  const recipientRefStore = new RecipientRefStore({ dir: tempDir() });
  let now = 1_000_000;
  const approvals = new ActionApprovalStore(() => now, 5_000); // 5s TTL
  const service = new MobileMessageRunService(runStore, recipientRefStore, approvals);
  const ref = mintRecipientRef(recipientRefStore);

  let run = service.createDraft({ tenantId: 'ten_a', ownerId: 'usr_a', deviceId: 'dev_1', requestId: 'req_1', recipientRef: ref.recipientRef, message: 'hi' });
  run = service.requestApproval(run.runId, 'ten_a', 'usr_a', 'req_2');

  now += 10_000; // past the 5s TTL — the approval is now live-expired
  run = service.confirmApproval(run.runId, 'ten_a', 'usr_a', 'req_3');
  assert.equal(run.status, 'BLOCKED');
  assert.equal(run.failureReason, 'APPROVAL_EXPIRED');

  assert.throws(
    () => service.executeApproved(run.runId, 'ten_a', 'usr_a', 'dev_1', 'req_4'),
    (err: unknown) => err instanceof NagexError && err.code === 'MOBILE_MESSAGE_EXECUTE_REJECTED',
  );
});

// ─── 16. Illegal status transitions are rejected ──────────────────────────

test('R23.6M-C 16. a send result can only be reported for a run actually at SEND_ATTEMPTED', () => {
  const { recipientRefStore, service } = makeHarness();
  const ref = mintRecipientRef(recipientRefStore);
  const run = service.createDraft({ tenantId: 'ten_a', ownerId: 'usr_a', deviceId: 'dev_1', requestId: 'req_1', recipientRef: ref.recipientRef, message: 'hi' });

  // DRAFT_CREATED — nowhere near SEND_ATTEMPTED yet.
  assert.throws(
    () => service.reportSendResult(run.runId, 'ten_a', 'usr_a', 'dev_1', 'req_2', 'SENT_CONFIRMED'),
    (err: unknown) => err instanceof NagexError && err.code === 'MOBILE_MESSAGE_STATUS_REJECTED',
  );
  // Delivery cannot be confirmed before the run even reaches SENT_CONFIRMED.
  assert.throws(
    () => service.reportDeliveryConfirmed(run.runId, 'ten_a', 'usr_a', 'dev_1', 'req_3'),
    (err: unknown) => err instanceof NagexError && err.code === 'MOBILE_MESSAGE_STATUS_REJECTED',
  );
});

// ─── 17. executionId identifies exactly one real attempt — never reused,
// never client-supplied ─────────────────────────────────────────────────
//
// This service deliberately never accepts a client-supplied idempotency
// key: the server always mints its own executionId, and the run's own
// state graph (Layer 1 — no legal re-entry into SEND_ATTEMPTED) combined
// with ActionApprovalStore's one-time consumption (Layer 2) together mean
// a retried/duplicated EXECUTE request can never reach a second
// executionId being minted at all — there is no "same executionId
// replayed twice" case to defend against, because there is no second
// executionId to begin with.

test('R23.6M-C 17. each real execution attempt gets its own unique executionId, and a rejected duplicate attempt never gets one at all', () => {
  const { recipientRefStore, approvals, service } = makeHarness();
  const ref = mintRecipientRef(recipientRefStore);
  let run = service.createDraft({ tenantId: 'ten_a', ownerId: 'usr_a', deviceId: 'dev_1', requestId: 'req_1', recipientRef: ref.recipientRef, message: 'hi' });
  run = service.requestApproval(run.runId, 'ten_a', 'usr_a', 'req_2');
  approvals.approve(run.approvalId!, 'ten_a', 'usr_a', 'req_3');
  run = service.confirmApproval(run.runId, 'ten_a', 'usr_a', 'req_4');

  run = service.executeApproved(run.runId, 'ten_a', 'usr_a', 'dev_1', 'req_5');
  const firstExecutionId = run.executionId;
  assert.ok(firstExecutionId);

  assert.throws(() => service.executeApproved(run.runId, 'ten_a', 'usr_a', 'dev_1', 'req_6'), NagexError);
  const afterDuplicate = service.getOwnedRun(run.runId, 'ten_a', 'usr_a')!;
  assert.equal(afterDuplicate.executionId, firstExecutionId, 'a rejected duplicate attempt must never mint or overwrite the real executionId');
});

// ─── 14. No scope creep — KakaoTalk/calls/Accessibility/iOS/generic
// automation are absent from every Phase C server file ──────────────────

test('R23.6M-C 14. no KakaoTalk, phone-call, Accessibility, iOS, or generic-app-automation logic exists anywhere in Phase C', async () => {
  const fs = await import('node:fs');
  const filesToCheck = [
    'src/mobile/mobile-message.types.ts',
    'src/mobile/mobile-message-run.state.ts',
    'src/mobile/mobile-message-run.store.ts',
    'src/mobile/mobile-message-run.service.ts',
    // The shared HTTP route is intentionally excluded after D1/D2 added
    // channel-neutral routing; the four src/mobile files remain the frozen
    // Phase C executable boundary and must stay Kakao-free.
  ];
  for (const rel of filesToCheck) {
    const content = fs.readFileSync(rel, 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(content, /kakao/i, `${rel} must not reference KakaoTalk in Phase C`);
    assert.doesNotMatch(content, /phone.?call|dialer|ACTION_CALL/i, `${rel} must not reference phone calls`);
    assert.doesNotMatch(content, /Accessibility/i, `${rel} must not reference Accessibility automation`);
    assert.doesNotMatch(content, /\bios\b/i, `${rel} must not reference iOS`);
    assert.doesNotMatch(content, /CLICK|TYPE_TEXT|OPEN_APP|ARBITRARY/i, `${rel} must not reference generic app-automation commands`);
  }
});
