// DC3-B2 Production — DesktopActivityAdapter.
//
// The only bridge between desktop-execution lifecycle events and the
// real, existing ActivityStore. Raw UIA/worker events never become one
// Activity item each — every call here is a grouped, human-readable
// projection of one execution session's current phase, using the store's
// real ActivityStatus vocabulary (RUNNING/COMPLETED/FAILED/
// NEEDS_ATTENTION — the richer STARTED/ACTION/VERIFYING/SUCCEEDED/
// CANCELLED/WAITING_FOR_APPROVAL vocabulary from the canonical Activity
// & Execution Transparency Amendment lives at the audit/machine-event
// level, not as new values added to this shared store's status enum).
// dedupeKey is always `${executionSessionId}:desktop_execution` so every
// phase of one execution overwrites the same Activity item rather than
// spawning a new one per event — audit/machine trail is where the full
// history belongs.
import { ActivityStore, type ActivityStatus } from '../governance/activity.store.js';
import { toMutationActivitySummary, formatMutationActivityText, type ActionKind } from './desktop-automation-activity-summary.js';
import { toSafeTextEvidence } from './sensitive-text-redaction.js';

export type DesktopExecutionPhase = 'STARTED' | 'ACTION' | 'VERIFYING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'WAITING_FOR_APPROVAL';

const PHASE_TO_ACTIVITY_STATUS: Record<DesktopExecutionPhase, ActivityStatus> = {
  STARTED: 'RUNNING',
  ACTION: 'RUNNING',
  VERIFYING: 'RUNNING',
  SUCCEEDED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'FAILED',
  WAITING_FOR_APPROVAL: 'NEEDS_ATTENTION',
};

export interface DesktopExecutionActivityInput {
  tenantId: string;
  principalId: string;
  executionSessionId: string;
  phase: DesktopExecutionPhase;
  appLabel: string; // human label, e.g. "NAgex 테스트 하네스" — never a raw appId/path
  action?: ActionKind;
  before?: string | null;
  after?: string | null;
  verified?: boolean;
  approvalId?: string;
}

export class DesktopActivityAdapter {
  constructor(private readonly activityStore: ActivityStore) {}

  public record(input: DesktopExecutionActivityInput): void {
    const status = PHASE_TO_ACTIVITY_STATUS[input.phase];
    const title = `NAgex가 백그라운드에서 작업 중입니다 — ${input.appLabel}`;
    let description: string | undefined;

    if (input.phase === 'WAITING_FOR_APPROVAL') {
      description = '이 작업은 승인이 필요합니다.';
    } else if (input.phase === 'CANCELLED') {
      description = '사용자 요청으로 중지되었습니다.';
    } else if (input.action) {
      const summary = toMutationActivitySummary({
        action: input.action,
        targetLabel: input.appLabel,
        before: toSafeTextEvidence(input.before ?? null),
        after: toSafeTextEvidence(input.after ?? null),
        verified: Boolean(input.verified),
      });
      description = formatMutationActivityText(summary);
    } else {
      description = input.phase === 'STARTED' ? '작업을 시작했습니다.' : undefined;
    }

    this.activityStore.record({
      tenantId: input.tenantId,
      principalId: input.principalId,
      type: 'desktop_execution',
      title,
      description,
      status,
      source: { executionId: input.executionSessionId, approvalId: input.approvalId },
      dedupeKey: `${input.executionSessionId}:desktop_execution`,
    });
  }
}
