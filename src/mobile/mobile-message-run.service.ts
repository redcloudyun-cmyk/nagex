// R23.6M Phase C — one complete real SMS execution flow:
// Voice -> contact resolution (Phase B3, unchanged) -> immutable execution
// payload -> human approval (reuses ActionApprovalStore unchanged) ->
// Android SMS execution -> real device-reported result -> audit.
//
// Consequential execution (SmsManager.sendTextMessage()) can only ever
// happen ON THE DEVICE — the server never sees a phone number. This
// service is therefore split at APPROVED: prepareForExecution() is a pure
// read (server hands the device its own approved recipientRef+message so
// the device can resolve a phone number locally BEFORE anything
// consequential happens); executeApproved() is the one moment the
// approval is actually consumed (mirroring R23.6E's crash-safe "consume
// before the risky external action" ordering) and the run moves to
// SEND_ATTEMPTED — never further until the device reports back a real
// result via reportSendResult().
import crypto from 'node:crypto';
import { NagexError } from '../common/errors.js';
import { generateResourceId } from '../common/utils.js';
import type { MobileMessageRunStore } from './mobile-message-run.store.js';
import { assertLegalMobileMessageRunTransition } from './mobile-message-run.state.js';
import { buildApprovalPayload, MOBILE_SEND_SMS_TOOL_ID, type MobileMessageApprovalPayload, type MobileMessageRunRecord, type MobileMessageRunStatus, type MobileMessageSendResult } from './mobile-message.types.js';

export interface RecipientRefLookupPort {
  getOwned(recipientRef: string, tenantId: string, ownerId: string, deviceId: string): { recipientRef: string; displayName: string } | null;
}

// Method names/signatures match ActionApprovalStore's real, existing
// public API exactly (request/get/consume) — the real store can be passed
// directly with no adapter. Never re-implemented here.
export interface MobileApprovalPort {
  request(input: { toolId: string; tenantId: string; principalId: string; payload: Record<string, unknown> }): { approvalId: string };
  get(approvalId: string, tenantId: string, principalId: string): { status: string } | undefined;
  consume(approvalId: string, tenantId: string, principalId: string, toolId: string, payload: Record<string, unknown>, requestId: string, executionId: string): { executionId: string | null };
}

export interface AuditLogPort {
  logEvent(event: { actor: { type: string; id: string }; tenant_id: string; action: string; resource: { type: string; id: string }; result: 'SUCCESS' | 'DENIED' | 'PENDING_APPROVAL' | 'FAILED'; request_id: string; details?: Record<string, unknown> }): unknown;
}

// Never the raw message — only enough to correlate/detect-drift in audit
// records without ever storing recoverable content.
function messageDigest(message: string): string {
  return crypto.createHash('sha256').update(message).digest('hex').slice(0, 16);
}

export class MobileMessageRunService {
  constructor(
    private readonly runStore: MobileMessageRunStore,
    private readonly recipientRefs: RecipientRefLookupPort,
    private readonly approvals: MobileApprovalPort,
    private readonly auditLogger?: AuditLogPort,
  ) {}

  public createDraft(input: { tenantId: string; ownerId: string; deviceId: string; requestId: string; recipientRef: string; message: string }): MobileMessageRunRecord {
    const message = input.message.trim();
    if (!message) {
      throw new NagexError({ code: 'MOBILE_MESSAGE_REQUIRED', category: 'VALIDATION', message: 'message is required.', request_id: input.requestId });
    }
    // Fail closed: a recipientRef not owned by this exact tenant+owner+device
    // is indistinguishable from a nonexistent one — never guessed, never
    // silently reassigned to "the closest owned ref".
    const recipient = this.recipientRefs.getOwned(input.recipientRef, input.tenantId, input.ownerId, input.deviceId);
    if (!recipient) {
      throw new NagexError({ code: 'MOBILE_MESSAGE_RECIPIENT_INVALID', category: 'VALIDATION', message: 'recipientRef is not owned by this tenant/owner/device.', request_id: input.requestId });
    }

    const run = this.runStore.create({
      tenantId: input.tenantId,
      ownerId: input.ownerId,
      deviceId: input.deviceId,
      requestId: input.requestId,
      recipientRef: input.recipientRef,
      message,
    });
    this.audit('sms.draft_created', run, input.requestId, 'SUCCESS');
    return run;
  }

  public getOwnedRun(runId: string, tenantId: string, ownerId: string): MobileMessageRunRecord | undefined {
    return this.runStore.getOwned(runId, tenantId, ownerId);
  }

  // Editable any time before SEND_ATTEMPTED — including after approval was
  // already requested/granted. This is both the real "let the user fix a
  // typo before sending" UX and the one place a payload-drift scenario can
  // originate: editing here never itself invalidates run.status, but the
  // next executeApproved() call will recompute the payload hash and the
  // mismatch will be caught by ActionApprovalStore.consume() — one single
  // authoritative enforcement point, not scattered ad hoc checks.
  public updateDraftMessage(runId: string, tenantId: string, ownerId: string, requestId: string, newMessage: string): MobileMessageRunRecord {
    const run = this.requireOwnedRun(runId, tenantId, ownerId, requestId);
    if (run.status === 'SEND_ATTEMPTED' || run.status === 'SENT_CONFIRMED' || run.status === 'DELIVERY_CONFIRMED' || run.status === 'FAILED' || run.status === 'BLOCKED') {
      throw new NagexError({ code: 'MOBILE_MESSAGE_NOT_EDITABLE', category: 'CONFLICT', message: `Run ${runId} is ${run.status} and can no longer be edited.`, request_id: requestId });
    }
    const message = newMessage.trim();
    if (!message) {
      throw new NagexError({ code: 'MOBILE_MESSAGE_REQUIRED', category: 'VALIDATION', message: 'message is required.', request_id: requestId });
    }
    const updated = this.runStore.save({ ...run, message });
    this.audit('sms.draft_updated', updated, requestId, 'SUCCESS');
    return updated;
  }

  public requestApproval(runId: string, tenantId: string, ownerId: string, requestId: string): MobileMessageRunRecord {
    const run = this.requireOwnedRun(runId, tenantId, ownerId, requestId);
    assertLegalMobileMessageRunTransition(run.status, 'APPROVAL_REQUIRED', requestId);
    const approval = this.approvals.request({
      toolId: MOBILE_SEND_SMS_TOOL_ID,
      tenantId,
      principalId: ownerId,
      payload: buildApprovalPayload(run) as unknown as Record<string, unknown>,
    });
    const updated = this.transitionTo(run, 'APPROVAL_REQUIRED', requestId, { approvalId: approval.approvalId });
    this.audit('sms.approval_requested', updated, requestId, 'PENDING_APPROVAL');
    return updated;
  }

  // Never auto-approves — only ever reflects the real, existing
  // ActionApprovalStore's own state, reached via the unchanged
  // POST /api/v1/approvals/:id/approve|reject routes.
  public confirmApproval(runId: string, tenantId: string, ownerId: string, requestId: string): MobileMessageRunRecord {
    const run = this.requireOwnedRun(runId, tenantId, ownerId, requestId);
    if (run.status !== 'APPROVAL_REQUIRED' || !run.approvalId) return run;

    const approval = this.approvals.get(run.approvalId, tenantId, ownerId);
    if (!approval) return run;

    if (approval.status === 'APPROVED') {
      const updated = this.transitionTo(run, 'APPROVED', requestId, {});
      this.audit('sms.approved', updated, requestId, 'SUCCESS');
      return updated;
    }
    if (approval.status === 'REJECTED') {
      const updated = this.transitionTo(run, 'BLOCKED', requestId, { failureReason: 'APPROVAL_REJECTED' });
      this.audit('sms.approval_rejected', updated, requestId, 'DENIED');
      return updated;
    }
    if (approval.status === 'EXPIRED') {
      const updated = this.transitionTo(run, 'BLOCKED', requestId, { failureReason: 'APPROVAL_EXPIRED' });
      this.audit('sms.approval_expired', updated, requestId, 'DENIED');
      return updated;
    }
    return run; // still PENDING
  }

  // Pure read — the device calls this (via the signed MOBILE_MESSAGE_PREPARE
  // command) to learn the exact approved recipientRef+message BEFORE
  // resolving a local phone number or doing anything consequential. Never
  // consumes the approval; never returns anything if this device is not
  // the one the run/approval is bound to.
  public prepareForExecution(runId: string, tenantId: string, ownerId: string, deviceId: string, requestId: string): { recipientRef: string; message: string } {
    const run = this.requireOwnedRun(runId, tenantId, ownerId, requestId);
    this.requireBoundDevice(run, deviceId, requestId);
    if (run.status !== 'APPROVED') {
      throw new NagexError({ code: 'MOBILE_MESSAGE_NOT_APPROVED', category: 'POLICY', message: `Run ${runId} is ${run.status}, not APPROVED.`, request_id: requestId });
    }
    return { recipientRef: run.recipientRef, message: run.message };
  }

  // The one moment the approval is consumed. Layer 1 duplicate-send guard:
  // only legal from APPROVED (the state graph itself has no self-transition
  // on SEND_ATTEMPTED) — a second call for the same run is rejected here,
  // before the approval store is even consulted again. Layer 2: the
  // approval store's own one-time CONSUMED status, defense in depth.
  public executeApproved(runId: string, tenantId: string, ownerId: string, deviceId: string, requestId: string): MobileMessageRunRecord {
    const run = this.requireOwnedRun(runId, tenantId, ownerId, requestId);
    this.requireBoundDevice(run, deviceId, requestId);

    if (run.status !== 'APPROVED' || !run.approvalId) {
      throw new NagexError({ code: 'MOBILE_MESSAGE_EXECUTE_REJECTED', category: 'CONFLICT', message: `Run ${runId} is ${run.status}; only an APPROVED run can be executed.`, request_id: requestId });
    }

    const currentPayload = buildApprovalPayload(run) as unknown as Record<string, unknown>;
    const executionId = generateResourceId('exe');

    try {
      this.approvals.consume(run.approvalId, tenantId, ownerId, MOBILE_SEND_SMS_TOOL_ID, currentPayload, requestId, executionId);
    } catch (error) {
      if (error instanceof NagexError && error.code === 'APPROVAL_PAYLOAD_MISMATCH') {
        // The run's live content no longer matches what was approved —
        // never execute against a mismatched payload. Mint a fresh
        // approval for the CURRENT payload and re-enter APPROVAL_REQUIRED;
        // the old approval is left exactly as it was (still APPROVED,
        // untouched, simply no longer usable for this run).
        const freshApproval = this.approvals.request({
          toolId: MOBILE_SEND_SMS_TOOL_ID,
          tenantId,
          principalId: ownerId,
          payload: currentPayload,
        });
        const updated = this.transitionTo(run, 'APPROVAL_REQUIRED', requestId, { approvalId: freshApproval.approvalId });
        this.audit('sms.payload_drift_detected', updated, requestId, 'DENIED');
        throw new NagexError({ code: 'MOBILE_MESSAGE_PAYLOAD_DRIFT', category: 'CONFLICT', message: 'The message no longer matches what was approved; a fresh approval is required.', request_id: requestId });
      }
      if (error instanceof NagexError && error.code === 'APPROVAL_ALREADY_CONSUMED') {
        // Layer 2 — should be unreachable given the Layer 1 state guard
        // above, but never treated as a fresh success if it is somehow hit.
        this.audit('sms.duplicate_execute_blocked', run, requestId, 'DENIED');
        throw new NagexError({ code: 'MOBILE_MESSAGE_EXECUTE_REJECTED', category: 'CONFLICT', message: 'This approval has already been used.', request_id: requestId });
      }
      throw error;
    }

    const updated = this.transitionTo(run, 'SEND_ATTEMPTED', requestId, { executionId });
    this.audit('sms.execute_authorized', updated, requestId, 'SUCCESS');
    return updated;
  }

  // The device's real, honest report of what SmsManager actually did.
  // Invoking the API is never treated as success by itself — only this
  // call, carrying the device's real sent/delivered broadcast outcome,
  // can move the run past SEND_ATTEMPTED.
  public reportSendResult(runId: string, tenantId: string, ownerId: string, deviceId: string, requestId: string, result: MobileMessageSendResult): MobileMessageRunRecord {
    const run = this.requireOwnedRun(runId, tenantId, ownerId, requestId);
    this.requireBoundDevice(run, deviceId, requestId);
    if (run.status !== 'SEND_ATTEMPTED') {
      throw new NagexError({ code: 'MOBILE_MESSAGE_STATUS_REJECTED', category: 'CONFLICT', message: `Run ${runId} is ${run.status}; a send result can only be reported for SEND_ATTEMPTED.`, request_id: requestId });
    }

    if (result === 'SENT_CONFIRMED') {
      const updated = this.transitionTo(run, 'SENT_CONFIRMED', requestId, {});
      this.audit('sms.sent_confirmed', updated, requestId, 'SUCCESS');
      return updated;
    }
    if (result === 'SEND_FAILED') {
      const updated = this.transitionTo(run, 'FAILED', requestId, { failureReason: 'SEND_FAILED' });
      this.audit('sms.send_failed', updated, requestId, 'FAILED');
      return updated;
    }
    // SEND_STATUS_UNKNOWN — deliberately never guessed into success or
    // failure. The run stays at SEND_ATTEMPTED forever unless the device
    // later reports a real result; no automatic retry, ever (would risk a
    // duplicate real-world SMS for an ambiguous crash-window outcome).
    const unchanged = this.runStore.save(run);
    this.audit('sms.send_status_unknown', unchanged, requestId, 'PENDING_APPROVAL');
    return unchanged;
  }

  public reportDeliveryConfirmed(runId: string, tenantId: string, ownerId: string, deviceId: string, requestId: string): MobileMessageRunRecord {
    const run = this.requireOwnedRun(runId, tenantId, ownerId, requestId);
    this.requireBoundDevice(run, deviceId, requestId);
    if (run.status !== 'SENT_CONFIRMED') {
      throw new NagexError({ code: 'MOBILE_MESSAGE_STATUS_REJECTED', category: 'CONFLICT', message: `Run ${runId} is ${run.status}; delivery can only be confirmed from SENT_CONFIRMED.`, request_id: requestId });
    }
    const updated = this.transitionTo(run, 'DELIVERY_CONFIRMED', requestId, { deliveryConfirmed: true });
    this.audit('sms.delivery_confirmed', updated, requestId, 'SUCCESS');
    return updated;
  }

  private requireBoundDevice(run: MobileMessageRunRecord, deviceId: string, requestId: string): void {
    if (run.deviceId !== deviceId) {
      throw new NagexError({ code: 'MOBILE_MESSAGE_DEVICE_MISMATCH', category: 'AUTHORIZATION', message: 'This run is not bound to the requesting device.', request_id: requestId });
    }
  }

  private requireOwnedRun(runId: string, tenantId: string, ownerId: string, requestId: string): MobileMessageRunRecord {
    const run = this.runStore.getOwned(runId, tenantId, ownerId);
    if (!run) {
      throw new NagexError({ code: 'MOBILE_MESSAGE_RUN_NOT_FOUND', category: 'NOT_FOUND', message: `Run ${runId} was not found.`, request_id: requestId });
    }
    return run;
  }

  private transitionTo(run: MobileMessageRunRecord, to: MobileMessageRunStatus, requestId: string, patch: Partial<MobileMessageRunRecord>): MobileMessageRunRecord {
    assertLegalMobileMessageRunTransition(run.status, to, requestId);
    return this.runStore.save({ ...run, ...patch, status: to });
  }

  private audit(action: string, run: MobileMessageRunRecord, requestId: string, result: 'SUCCESS' | 'DENIED' | 'PENDING_APPROVAL' | 'FAILED'): void {
    this.auditLogger?.logEvent({
      actor: { type: 'user', id: run.ownerId },
      tenant_id: run.tenantId,
      action,
      resource: { type: 'mobile_message_run', id: run.runId },
      result,
      request_id: requestId,
      details: {
        deviceId: run.deviceId,
        recipientRef: run.recipientRef,
        channel: run.channel,
        messageDigest: messageDigest(run.message),
        messageLength: run.message.length,
        approvalId: run.approvalId,
        executionId: run.executionId,
        status: run.status,
      },
    });
  }
}

export type { MobileMessageApprovalPayload };
