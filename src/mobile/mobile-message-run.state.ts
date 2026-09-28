// R23.6M Phase C — the canonical mobile-message run state graph, same
// pattern as competitor-pricing-run.state.ts (R23.6E): a pure function
// independent of storage/approval/device-transport, so the policy itself
// is directly testable.
import { NagexError } from '../common/errors.js';
import type { MobileMessageRunStatus } from './mobile-message.types.js';

// APPROVED -> APPROVAL_REQUIRED is the one back-edge: a payload changed
// after approval (message/recipient/channel/device/executionRoute) must
// re-enter approval rather than the run silently proceeding or dying.
// SEND_ATTEMPTED has no legal self-transition — this is Layer 1 of the
// duplicate-send protection (mirrors R23.6E): a second EXECUTE attempt for
// the same run is rejected by the state graph alone, before the approval
// store is even consulted again.
const LEGAL_TRANSITIONS: Record<MobileMessageRunStatus, MobileMessageRunStatus[]> = {
  DRAFT_CREATED: ['APPROVAL_REQUIRED', 'BLOCKED'],
  APPROVAL_REQUIRED: ['APPROVED', 'BLOCKED'],
  APPROVED: ['SEND_ATTEMPTED', 'APPROVAL_REQUIRED'],
  SEND_ATTEMPTED: ['SENT_CONFIRMED', 'FAILED'],
  SENT_CONFIRMED: ['DELIVERY_CONFIRMED'],
  DELIVERY_CONFIRMED: [],
  FAILED: [],
  BLOCKED: [],
};

export function isLegalMobileMessageRunTransition(from: MobileMessageRunStatus, to: MobileMessageRunStatus): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

export function assertLegalMobileMessageRunTransition(from: MobileMessageRunStatus, to: MobileMessageRunStatus, requestId: string): void {
  if (!isLegalMobileMessageRunTransition(from, to)) {
    throw new NagexError({
      code: 'MOBILE_MESSAGE_RUN_ILLEGAL_TRANSITION',
      category: 'CONFLICT',
      message: `Cannot move a mobile message run from ${from} to ${to}.`,
      request_id: requestId,
    });
  }
}
