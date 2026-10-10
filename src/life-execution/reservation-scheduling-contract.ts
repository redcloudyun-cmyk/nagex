import type { ExecutionOutcome, ReservationProposal, SchedulingIntent } from './life-execution.types.js';

export interface SchedulingProposal {
  readonly schedulingProposalId: string;
  readonly reservationId: string;
  readonly provider: string;
  readonly location?: string;
  readonly start?: string;
  readonly end?: string;
  readonly confirmationRef?: string;
  readonly travelBufferProposal: {
    readonly beforeMinutes: number;
    readonly afterMinutes: number;
  };
  readonly calendarWriteState: 'PROPOSED_ONLY' | 'AWAITING_APPROVAL' | 'WRITTEN';
}

export function buildSchedulingProposalFromReservation(
  proposal: ReservationProposal,
  outcome: ExecutionOutcome,
  schedulingIntent: SchedulingIntent,
): SchedulingProposal {
  return {
    schedulingProposalId: `schedule-${proposal.proposalId}`,
    reservationId: proposal.proposalId,
    provider: proposal.materialTerms.provider,
    location: proposal.candidate.location,
    start: proposal.materialTerms.date && proposal.materialTerms.timeWindow
      ? `${proposal.materialTerms.date} ${proposal.materialTerms.timeWindow.split('-')[0]}`
      : schedulingIntent.date,
    end: schedulingIntent.durationMinutes ? undefined : proposal.materialTerms.timeWindow?.split('-')[1],
    confirmationRef: outcome.evidenceRefs.find((ref) => ref.includes('confirmation')),
    travelBufferProposal: {
      beforeMinutes: 30,
      afterMinutes: 15,
    },
    calendarWriteState: 'PROPOSED_ONLY',
  };
}
