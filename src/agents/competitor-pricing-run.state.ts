// R23.6E — the canonical, small, explicit run-state graph (Section 15 /
// Phase B). A pure function, independent of storage/research/Gmail, so the
// policy itself ("research cannot skip straight to sent-confirmed", "a
// rejected approval can never resume toward send") is directly testable
// without any of the real integrations Phase C-E will add.
import { NagexError } from '../common/errors.js';
import type { E2EAgentRunStatus } from './competitor-pricing-email.types.js';

// APPROVED -> APPROVAL_REQUIRED is the one back-edge: Section 13's payload
// drift path ("PAYLOAD_DRIFT -> BLOCK -> RE-APPROVAL REQUIRED") re-enters
// approval rather than terminating the run.
const LEGAL_TRANSITIONS: Record<E2EAgentRunStatus, E2EAgentRunStatus[]> = {
  RESEARCHING: ['REPORT_READY', 'FAILED'],
  // Phase D Section 9 — REPORT_READY/DRAFT_CREATED can each fail closed to
  // either FAILED (a technical/provider failure) or BLOCKED (a policy-level
  // stop, e.g. no valid recipient could be resolved — never guessed).
  REPORT_READY: ['DRAFT_CREATED', 'FAILED', 'BLOCKED'],
  DRAFT_CREATED: ['APPROVAL_REQUIRED', 'FAILED', 'BLOCKED'],
  APPROVAL_REQUIRED: ['APPROVED', 'BLOCKED'],
  APPROVED: ['SEND_ATTEMPTED', 'APPROVAL_REQUIRED'],
  SEND_ATTEMPTED: ['SENT_CONFIRMED', 'FAILED'],
  SENT_CONFIRMED: [],
  FAILED: [],
  BLOCKED: [],
};

export function isLegalRunTransition(from: E2EAgentRunStatus, to: E2EAgentRunStatus): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

// Fail-closed: an illegal transition (e.g. RESEARCHING -> SENT_CONFIRMED,
// or any transition out of a terminal state) throws rather than silently
// applying, so the orchestration service itself can never be the thing
// that lets a run's real status skip a required gate.
export function assertLegalRunTransition(from: E2EAgentRunStatus, to: E2EAgentRunStatus, requestId: string): void {
  if (!isLegalRunTransition(from, to)) {
    throw new NagexError({
      code: 'AGENT_RUN_ILLEGAL_TRANSITION',
      category: 'CONFLICT',
      message: `Cannot move a competitor-pricing-email run from ${from} to ${to}.`,
      request_id: requestId,
    });
  }
}
