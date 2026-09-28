// R23.6M Phase D1 — the canonical adapter boundary. Async by design
// (Promise-returning) even though every D1 implementation (SmsMessagingAdapter)
// is a synchronous passthrough wrapped in a resolved Promise — future
// channels (KakaoTalk device-app detection, WhatsApp API round-trips) may
// genuinely need real async I/O, and the canonical contract must not be
// retrofitted later to add that. No adapter method may contain approval
// logic, payload-hash/drift logic, or state-transition logic of its own —
// MobileMessageRunService (or its future per-channel equivalent) remains
// the single source of truth for all of that; an adapter only ever calls
// through to it.
import type {
  CapabilityResult,
  ExecutionOutcome,
  ExecutionRoute,
  MessagingChannel,
  MessagingRouteCapabilities,
  PreparedMessage,
  RunSnapshot,
  SendMessageAction,
  SendResult,
} from './send-message-action.types.js';

export interface MessagingExecutionAdapter {
  readonly channel: MessagingChannel;

  // Can this adapter even attempt this action right now? Never a fake
  // "available" answer for a channel/route this adapter cannot actually
  // execute.
  checkCapability(action: SendMessageAction): Promise<CapabilityResult>;

  // Pure selection among THIS adapter's own possible execution routes —
  // never assumes one channel maps to exactly one route. SMS's
  // implementation always returns 'ANDROID_SMS_MANAGER' today, but the
  // method exists so a future KakaoTalk adapter can choose among its own
  // multiple routes without changing this interface.
  resolveExecutionRoute(action: SendMessageAction): ExecutionRoute;
  getRouteCapabilities(action: SendMessageAction): MessagingRouteCapabilities;

  prepare(runId: string, tenantId: string, ownerId: string, deviceId: string, requestId: string): Promise<PreparedMessage>;

  executeApproved(runId: string, tenantId: string, ownerId: string, deviceId: string, requestId: string): Promise<ExecutionOutcome>;

  reportResult(runId: string, tenantId: string, ownerId: string, deviceId: string, requestId: string, result: SendResult): Promise<RunSnapshot>;
}
