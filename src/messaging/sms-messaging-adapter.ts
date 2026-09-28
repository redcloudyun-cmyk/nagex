// R23.6M Phase D1 — SmsMessagingAdapter. A thin, async-wrapped passthrough
// to the certified, unchanged MobileMessageRunService — no approval logic,
// no payload-hash/drift logic, no state-transition logic, no send logic
// of its own. MobileMessageRunService remains the single source of truth
// for all of that; this class exists only so the canonical
// ExecutionRouteResolver/MessagingAdapterRegistry boundary has a real,
// registered SMS entry to resolve to.
import type { MobileMessageRunService } from '../mobile/mobile-message-run.service.js';
import type { MessagingExecutionAdapter } from './messaging-execution-adapter.js';
import type { CapabilityResult, ExecutionOutcome, ExecutionRoute, PreparedMessage, RunSnapshot, SendMessageAction, SendResult } from './send-message-action.types.js';

export class SmsMessagingAdapter implements MessagingExecutionAdapter {
  public readonly channel = 'SMS' as const;

  constructor(private readonly mobileMessageRunService: MobileMessageRunService) {}

  // Server-side capability is intentionally minimal: recipientRef
  // ownership is already validated by createDraft() itself (unchanged,
  // called separately by the route handler); real phone-number
  // availability can only be discovered device-side (Phase B3/C's
  // established privacy boundary — the server never has a phone number).
  // This never fabricates a stronger guarantee than that.
  public async checkCapability(_action: SendMessageAction): Promise<CapabilityResult> {
    return { available: true };
  }

  public resolveExecutionRoute(_action: SendMessageAction): ExecutionRoute {
    return 'ANDROID_SMS_MANAGER';
  }

  public async prepare(runId: string, tenantId: string, ownerId: string, deviceId: string, requestId: string): Promise<PreparedMessage> {
    return this.mobileMessageRunService.prepareForExecution(runId, tenantId, ownerId, deviceId, requestId);
  }

  public async executeApproved(runId: string, tenantId: string, ownerId: string, deviceId: string, requestId: string): Promise<ExecutionOutcome> {
    return this.mobileMessageRunService.executeApproved(runId, tenantId, ownerId, deviceId, requestId);
  }

  public async reportResult(runId: string, tenantId: string, ownerId: string, deviceId: string, requestId: string, result: SendResult): Promise<RunSnapshot> {
    return this.mobileMessageRunService.reportSendResult(runId, tenantId, ownerId, deviceId, requestId, result);
  }
}
