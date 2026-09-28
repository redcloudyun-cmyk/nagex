import { NagexError } from '../common/errors.js';
import { generateResourceId } from '../common/utils.js';
import type { AuditLogger } from '../governance/audit.logger.js';
import type { MobileApprovalPort, RecipientRefLookupPort } from '../mobile/mobile-message-run.service.js';
import { buildMessagingHandoffApprovalPayload, KAKAOTALK_HANDOFF_TOOL_ID, type MessagingHandoffRun } from './messaging-handoff.types.js';
import type { MessagingHandoffRunStore } from './messaging-handoff-run.store.js';
import type { SendMessageAction } from './send-message-action.types.js';

export const KAKAOTALK_SHARE_CAPABILITIES = Object.freeze({ executionMode: 'HUMAN_HANDOFF' as const, recipientEnforced: false, messageEnforced: false, completionVerifiable: false, requiresHumanCompletion: true });

export class MessagingHandoffService {
  constructor(private readonly store: MessagingHandoffRunStore, private readonly approvals: MobileApprovalPort, private readonly recipients: RecipientRefLookupPort, private readonly audit?: AuditLogger) {}
  createReady(action: SendMessageAction): MessagingHandoffRun {
    if (action.preferredChannel !== 'KAKAOTALK') throw new NagexError({ code: 'MESSAGING_HANDOFF_CHANNEL_INVALID', category: 'VALIDATION', message: 'A KakaoTalk handoff requires an explicit KAKAOTALK channel.', request_id: action.requestId });
    const message = action.message.trim();
    if (!message) throw new NagexError({ code: 'MESSAGING_MESSAGE_REQUIRED', category: 'VALIDATION', message: 'message is required.', request_id: action.requestId });
    if (!this.recipients.getOwned(action.recipientRef, action.tenantId, action.ownerId, action.deviceId)) throw new NagexError({ code: 'MESSAGING_HANDOFF_INTENDED_RECIPIENT_INVALID', category: 'VALIDATION', message: 'intendedRecipientRef is not owned by this tenant/owner/device.', request_id: action.requestId });
    const run = this.store.create({ tenantId: action.tenantId, ownerId: action.ownerId, deviceId: action.deviceId, requestId: action.requestId, intendedRecipientRef: action.recipientRef, message, routeCapabilities: KAKAOTALK_SHARE_CAPABILITIES });
    this.log(run, 'messaging.handoff.ready', 'SUCCESS');
    return run;
  }
  getOwned(runId: string, tenantId: string, ownerId: string, requestId: string): MessagingHandoffRun { const run = this.store.getOwned(runId, tenantId, ownerId); if (!run) throw new NagexError({ code: 'MESSAGING_HANDOFF_RUN_NOT_FOUND', category: 'NOT_FOUND', message: 'Messaging handoff run was not found.', request_id: requestId }); return run; }
  requestApproval(runId: string, tenantId: string, ownerId: string, requestId: string): MessagingHandoffRun {
    const run = this.getOwned(runId, tenantId, ownerId, requestId); if (run.status !== 'READY') throw this.invalid(run, requestId);
    const approval = this.approvals.request({ toolId: KAKAOTALK_HANDOFF_TOOL_ID, tenantId, principalId: ownerId, payload: buildMessagingHandoffApprovalPayload(run) as unknown as Record<string, unknown> });
    const saved = this.store.save({ ...run, status: 'APPROVAL_REQUIRED', approvalId: approval.approvalId });
    this.log(saved, 'messaging.handoff.approval_requested', 'PENDING_APPROVAL');
    return saved;
  }
  confirmApproval(runId: string, tenantId: string, ownerId: string, requestId: string): MessagingHandoffRun {
    const run = this.getOwned(runId, tenantId, ownerId, requestId); if (run.status !== 'APPROVAL_REQUIRED' || !run.approvalId) return run;
    const approval = this.approvals.get(run.approvalId, tenantId, ownerId);
    if (approval?.status === 'APPROVED') return this.store.save({ ...run, status: 'APPROVED' });
    if (approval?.status === 'REJECTED' || approval?.status === 'EXPIRED') return this.store.save({ ...run, status: 'FAILED', failureReason: approval.status });
    return run;
  }
  authorizeHandoff(runId: string, tenantId: string, ownerId: string, deviceId: string, requestId: string): { runId: string; message: string; executionId: string; executionRoute: 'KAKAOTALK_SHARE' } {
    const run = this.getOwned(runId, tenantId, ownerId, requestId); if (run.deviceId !== deviceId || run.status !== 'APPROVED' || !run.approvalId) throw this.invalid(run, requestId);
    const executionId = generateResourceId('exe');
    try { this.approvals.consume(run.approvalId, tenantId, ownerId, KAKAOTALK_HANDOFF_TOOL_ID, buildMessagingHandoffApprovalPayload(run) as unknown as Record<string, unknown>, requestId, executionId); }
    catch (error) {
      if (error instanceof NagexError && error.code === 'APPROVAL_PAYLOAD_MISMATCH') {
        const fresh = this.approvals.request({ toolId: KAKAOTALK_HANDOFF_TOOL_ID, tenantId, principalId: ownerId, payload: buildMessagingHandoffApprovalPayload(run) as unknown as Record<string, unknown> });
        this.store.save({ ...run, status: 'APPROVAL_REQUIRED', approvalId: fresh.approvalId });
        throw new NagexError({ code: 'MESSAGING_HANDOFF_PAYLOAD_DRIFT', category: 'CONFLICT', message: 'Handoff payload changed; reapproval is required.', request_id: requestId });
      } throw error;
    }
    const authorized = this.store.save({ ...run, executionId });
    this.log(authorized, 'messaging.handoff.authorized', 'SUCCESS');
    return { runId, message: run.message, executionId, executionRoute: 'KAKAOTALK_SHARE' };
  }
  reportHandoffStarted(runId: string, tenantId: string, ownerId: string, deviceId: string, requestId: string): MessagingHandoffRun {
    const run = this.getOwned(runId, tenantId, ownerId, requestId); if (run.deviceId !== deviceId || run.status !== 'APPROVED' || !run.executionId) throw this.invalid(run, requestId);
    const started = this.store.save({ ...run, status: 'HANDOFF_STARTED' });
    this.log(started, 'messaging.handoff.started', 'SUCCESS');
    const needsHuman = this.store.save({ ...run, status: 'NEEDS_HUMAN' });
    this.log(needsHuman, 'messaging.handoff.needs_human', 'SUCCESS');
    return needsHuman;
  }
  markUnavailable(runId: string, tenantId: string, ownerId: string, deviceId: string, requestId: string): MessagingHandoffRun { const run = this.getOwned(runId, tenantId, ownerId, requestId); if (run.deviceId !== deviceId) throw this.invalid(run, requestId); const unavailable = this.store.save({ ...run, status: 'UNAVAILABLE', failureReason: 'KAKAOTALK_SHARE_UNAVAILABLE' }); this.log(unavailable, 'messaging.handoff.unavailable', 'FAILED', 'KAKAOTALK_SHARE_UNAVAILABLE'); return unavailable; }
  private log(run: MessagingHandoffRun, action: string, result: 'SUCCESS' | 'PENDING_APPROVAL' | 'FAILED', reason_code?: string): void {
    this.audit?.logEvent({ actor: { type: 'user', id: run.ownerId }, tenant_id: run.tenantId, action, resource: { type: 'MessagingHandoffRun', id: run.runId }, result, reason_code, request_id: run.requestId, details: { channel: run.channel, executionRoute: run.executionRoute, intendedRecipientRef: run.intendedRecipientRef, ...run.routeCapabilities } });
  }
  private invalid(run: MessagingHandoffRun, requestId: string) { return new NagexError({ code: 'MESSAGING_HANDOFF_STATE_INVALID', category: 'CONFLICT', message: `Handoff run ${run.runId} is ${run.status}.`, request_id: requestId }); }
}
