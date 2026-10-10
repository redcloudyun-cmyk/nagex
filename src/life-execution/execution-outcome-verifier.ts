import type { ExecutionEvidence, ExecutionOutcome, PaymentRequirement } from './life-execution.types.js';

export class ExecutionOutcomeVerifier {
  verify(evidence: ExecutionEvidence, paymentRequirement: PaymentRequirement): ExecutionOutcome {
    if (evidence.confirmationVerified && evidence.confirmationId) {
      return {
        status: 'BOOKED_VERIFIED',
        lifecycleState: 'CONFIRMATION_VERIFIED',
        approvalConsumed: true,
        bookingState: 'VERIFIED',
        paymentState: paymentRequirement === 'NONE' || paymentRequirement === 'PAY_LATER' ? 'NOT_REQUIRED' : 'UNKNOWN',
        evidenceRefs: evidence.evidenceRefs,
        reason: 'External confirmation evidence was observed and verified.',
      };
    }

    if (evidence.providerAccepted && evidence.outcomeObserved) {
      return {
        status: 'BOOKED_UNVERIFIED',
        lifecycleState: 'OUTCOME_OBSERVED',
        approvalConsumed: true,
        bookingState: 'SUBMITTED',
        paymentState: paymentRequirement === 'NONE' ? 'NOT_REQUIRED' : 'UNKNOWN',
        evidenceRefs: evidence.evidenceRefs,
        reason: 'Provider accepted the action, but completion confirmation is not verified.',
      };
    }

    if (evidence.actionSubmitted) {
      return {
        status: 'ACTION_TRIGGERED',
        lifecycleState: 'OUTCOME_UNCERTAIN',
        approvalConsumed: true,
        bookingState: 'UNCERTAIN',
        paymentState: paymentRequirement === 'NONE' ? 'NOT_REQUIRED' : 'UNKNOWN',
        evidenceRefs: evidence.evidenceRefs,
        reason: 'A UI action or request was triggered; this is not sufficient proof of completion.',
      };
    }

    return {
      status: 'PREPARED_ONLY',
      lifecycleState: 'PREPARED',
      approvalConsumed: false,
      bookingState: 'PREPARED',
      paymentState: paymentRequirement === 'NONE' ? 'NOT_REQUIRED' : 'REQUIRED_NOT_PAID',
      evidenceRefs: evidence.evidenceRefs,
      reason: 'Reservation is prepared but no consequential execution has occurred.',
    };
  }
}
