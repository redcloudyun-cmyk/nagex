export type CallIntentOrigin = 'EXPLICIT_USER_COMMAND' | 'PROACTIVE_SUGGESTION';
export type ContactResolutionState = 'UNRESOLVED' | 'NONE' | 'AMBIGUOUS' | 'UNIQUE_VERIFIED';
export type PhoneResolutionState = 'UNRESOLVED' | 'NONE' | 'MULTIPLE_NEEDS_SELECTION' | 'PREFERRED_VERIFIED' | 'UNIQUE_VERIFIED';
export type CallPopupState =
  | 'NONE'
  | 'COMPACT_CONFIRMATION_COUNTDOWN'
  | 'CANDIDATE_SELECTION'
  | 'PHONE_NUMBER_SELECTION'
  | 'EXPLICIT_CONFIRMATION_REQUIRED'
  | 'BLOCKED';

export interface BackgroundCallInput {
  origin: CallIntentOrigin;
  explicitCallIntentVerified: boolean;
  contactResolution: ContactResolutionState;
  phoneResolution: PhoneResolutionState;
  countdownSeconds?: number;
  cancelledDuringCountdown?: boolean;
  voiceCancelDetected?: boolean;
  targetRevalidated?: boolean;
  phoneTargetRevalidated?: boolean;
}

export interface BackgroundCallDecision {
  captureMode: 'BACKGROUND';
  fullScreenVoiceUiAllowed: false;
  popupState: CallPopupState;
  countdownSeconds: number | null;
  countdownStarts: boolean;
  cancelWindowVisible: boolean;
  callNowVisible: boolean;
  voiceCancelSupported: boolean;
  silenceIsApproval: boolean;
  finalRevalidationRequired: boolean;
  executeCall: boolean;
  reason: string;
}

export class BackgroundVoiceCallUxPolicy {
  public decide(input: BackgroundCallInput): BackgroundCallDecision {
    const base = this.base();
    if (!input.explicitCallIntentVerified) {
      return {
        ...base,
        popupState: input.origin === 'PROACTIVE_SUGGESTION' ? 'EXPLICIT_CONFIRMATION_REQUIRED' : 'BLOCKED',
        reason: input.origin === 'PROACTIVE_SUGGESTION' ? 'PROACTIVE_CALL_REQUIRES_POSITIVE_CONFIRMATION' : 'CALL_INTENT_NOT_VERIFIED',
      };
    }

    if (input.origin === 'PROACTIVE_SUGGESTION') {
      return {
        ...base,
        popupState: 'EXPLICIT_CONFIRMATION_REQUIRED',
        reason: 'PROACTIVE_CALL_SILENCE_IS_NOT_APPROVAL',
      };
    }

    if (input.contactResolution === 'AMBIGUOUS') {
      return { ...base, popupState: 'CANDIDATE_SELECTION', reason: 'AMBIGUOUS_CONTACT_REQUIRES_SELECTION' };
    }
    if (input.contactResolution !== 'UNIQUE_VERIFIED') {
      return { ...base, popupState: 'BLOCKED', reason: 'CONTACT_NOT_VERIFIED' };
    }

    if (input.phoneResolution === 'MULTIPLE_NEEDS_SELECTION') {
      return { ...base, popupState: 'PHONE_NUMBER_SELECTION', reason: 'MULTIPLE_PHONE_NUMBERS_REQUIRE_SELECTION' };
    }
    if (input.phoneResolution !== 'PREFERRED_VERIFIED' && input.phoneResolution !== 'UNIQUE_VERIFIED') {
      return { ...base, popupState: 'BLOCKED', reason: 'PHONE_TARGET_NOT_VERIFIED' };
    }

    const countdownSeconds = input.countdownSeconds ?? 5;
    const countdownDecision: BackgroundCallDecision = {
      ...base,
      popupState: 'COMPACT_CONFIRMATION_COUNTDOWN',
      countdownSeconds,
      countdownStarts: true,
      cancelWindowVisible: true,
      callNowVisible: true,
      voiceCancelSupported: true,
      finalRevalidationRequired: true,
      reason: input.phoneResolution === 'PREFERRED_VERIFIED' ? 'UNIQUE_TARGET_WITH_VERIFIED_PREFERRED_PHONE' : 'UNIQUE_TARGET_WITH_UNIQUE_PHONE',
    };

    if (input.cancelledDuringCountdown || input.voiceCancelDetected) {
      return { ...countdownDecision, executeCall: false, reason: 'CALL_CANCELLED_DURING_BUFFER' };
    }

    if (input.targetRevalidated && input.phoneTargetRevalidated) {
      return { ...countdownDecision, executeCall: true, reason: 'COUNTDOWN_EXPIRED_AND_FINAL_REVALIDATION_PASSED' };
    }

    return countdownDecision;
  }

  private base(): BackgroundCallDecision {
    return {
      captureMode: 'BACKGROUND',
      fullScreenVoiceUiAllowed: false,
      popupState: 'NONE',
      countdownSeconds: null,
      countdownStarts: false,
      cancelWindowVisible: false,
      callNowVisible: false,
      voiceCancelSupported: true,
      silenceIsApproval: false,
      finalRevalidationRequired: true,
      executeCall: false,
      reason: 'NO_ACTION',
    };
  }
}
