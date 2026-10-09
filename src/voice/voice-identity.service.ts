import {
  DEFAULT_WAKE_PHRASE,
  DISABLED_WAKE_PHRASE,
  LEGACY_AGEX_DEFAULT_WAKE_PHRASE,
  LEGACY_AGEX_SHORT_WAKE_PHRASE,
  SHORT_WAKE_PHRASE,
  type InputTrustLevel,
  type LivenessResult,
  type SpeakerVerificationState,
  type VoiceAuthorityDecision,
  type VoiceEnrollmentDraft,
  type VoiceIdentityPolicy,
  type VoiceProfile,
  type VoiceRiskTier,
  type VoiceSession,
  type VoiceVerificationInput,
  type VoiceVerificationResult,
  type WakePhraseMode,
} from './voice-identity.types.js';

export class VoiceIdentityService {
  public readonly policy: VoiceIdentityPolicy = {
    defaultWakePhrase: DEFAULT_WAKE_PHRASE,
    shortWakePhrase: SHORT_WAKE_PHRASE,
    disabledWakePhrase: DISABLED_WAKE_PHRASE,
    okNagexDefault: false,
    rawEnrollmentAudioRetention: 'EPHEMERAL',
    voiceProfileDeviceLocalDefault: true,
    rawAudioSyncDefault: false,
    developmentTrustModeProductionAllowed: false,
  };

  public wakePhraseForMode(mode: WakePhraseMode): string | null {
    if (mode === 'DEFAULT') return DEFAULT_WAKE_PHRASE;
    if (mode === 'SHORT') return SHORT_WAKE_PHRASE;
    return null;
  }

  public normalizeWakePhraseSelection(value: string | WakePhraseMode | null | undefined): WakePhraseMode {
    if (!value) return 'DEFAULT';
    if (value === 'DEFAULT' || value === DEFAULT_WAKE_PHRASE || value === LEGACY_AGEX_DEFAULT_WAKE_PHRASE) return 'DEFAULT';
    if (value === 'SHORT' || value === SHORT_WAKE_PHRASE || value === LEGACY_AGEX_SHORT_WAKE_PHRASE) return 'SHORT';
    if (value === 'DISABLED' || value === DISABLED_WAKE_PHRASE) return 'DISABLED';
    return 'DEFAULT';
  }

  public createEnrollmentDraft(): VoiceEnrollmentDraft {
    return {
      minimumAcceptedSamples: 4,
      rawAudioRetention: 'EPHEMERAL',
      secureProfileStorage: 'PLATFORM_KEYSTORE_REQUIRED_WHEN_AVAILABLE',
      prompts: [
        { id: 'wake-default', text: DEFAULT_WAKE_PHRASE, kind: 'WAKE_PHRASE' },
        { id: 'schedule-today', text: '\uC624\uB298 \uC77C\uC815 \uC54C\uB824\uC918', kind: 'COMMAND_LIKE' },
        { id: 'morning-tomorrow', text: '\uB0B4\uC77C \uC544\uCE68\uC5D0 \uC54C\uB824\uC918', kind: 'PHONETIC_VARIATION' },
        { id: 'call-command', text: '\uC870\uBBFC\uD615\uC5D0\uAC8C \uC804\uD654 \uAC78\uC5B4\uC918', kind: 'COMMAND_LIKE' },
      ],
    };
  }

  public createDeviceLocalProfile(params: { tenantId: string; ownerId: string; deviceId: string; sampleCount: number }): VoiceProfile {
    if (params.sampleCount < this.createEnrollmentDraft().minimumAcceptedSamples) {
      throw new Error('VOICE_ENROLLMENT_REQUIRES_MULTIPLE_SAMPLES');
    }
    return {
      profileId: `vpr_${params.deviceId}_${params.ownerId}`,
      tenantId: params.tenantId,
      ownerId: params.ownerId,
      deviceId: params.deviceId,
      status: 'ENROLLED',
      storageScope: 'DEVICE_LOCAL',
      rawAudioRetained: false,
    };
  }

  public verify(input: VoiceVerificationInput): VoiceVerificationResult {
    const livenessResult: LivenessResult = input.livenessResult || 'UNKNOWN';
    if (!input.wakePhraseDetected) {
      return this.result(false, 'UNCERTAIN', null, livenessResult, 'UNTRUSTED');
    }
    if (input.developmentTrustMode) {
      if (input.production) return this.result(true, 'NOT_ENROLLED', null, livenessResult, 'UNTRUSTED');
      return this.result(true, input.profile ? 'UNCERTAIN' : 'NOT_ENROLLED', null, livenessResult, 'DEVELOPMENT_TRUST');
    }
    if (!input.profile || input.profile.status !== 'ENROLLED') {
      return this.result(true, 'NOT_ENROLLED', null, livenessResult, 'UNTRUSTED');
    }
    if (!input.speakerMatchesProfile) {
      return this.result(true, 'MISMATCH', 0.12, livenessResult, 'UNTRUSTED');
    }
    if (livenessResult === 'REPLAY_SUSPECTED' || livenessResult === 'SYNTHETIC_SUSPECTED') {
      return this.result(true, 'VERIFIED', 0.82, livenessResult, 'LIMITED');
    }
    return this.result(true, 'VERIFIED', 0.82, livenessResult, livenessResult === 'LIVE_LIKELY' ? 'TRUSTED' : 'LIMITED');
  }

  public decideAuthority(riskTier: VoiceRiskTier, verification: VoiceVerificationResult): VoiceAuthorityDecision {
    if (!verification.wakeWordMatch) return 'BLOCK';
    if (verification.inputTrustLevel === 'UNTRUSTED') return 'BLOCK';
    if (riskTier === 'HIGH') return 'REQUIRE_APPROVAL';
    if (riskTier === 'MEDIUM') return verification.speakerMatch === 'VERIFIED' ? 'REQUIRE_APPROVAL' : 'BLOCK';
    return verification.speakerMatch === 'VERIFIED' || verification.inputTrustLevel === 'DEVELOPMENT_TRUST' ? 'ALLOW' : 'BLOCK';
  }

  public startSession(now = Date.now()): VoiceSession {
    void now;
    return { state: 'IDLE', wakePhraseRequired: true, continuationUntil: null, trustLevel: 'UNTRUSTED' };
  }

  public enterContinuationWindow(session: VoiceSession, trustLevel: InputTrustLevel, now = Date.now(), durationMs = 45_000): VoiceSession {
    return { ...session, state: 'CONTINUATION_WINDOW', wakePhraseRequired: false, continuationUntil: now + durationMs, trustLevel };
  }

  public acceptFollowUpWithoutWake(session: VoiceSession, now = Date.now()): boolean {
    return session.state === 'CONTINUATION_WINDOW' && session.continuationUntil !== null && now <= session.continuationUntil && session.trustLevel !== 'UNTRUSTED';
  }

  public invalidateForDeviceLock(session: VoiceSession): VoiceSession {
    return { ...session, state: 'IDLE', wakePhraseRequired: true, continuationUntil: null, trustLevel: 'UNTRUSTED' };
  }

  private result(
    wakeWordMatch: boolean,
    speakerMatch: SpeakerVerificationState,
    speakerConfidence: number | null,
    livenessResult: LivenessResult,
    inputTrustLevel: InputTrustLevel,
  ): VoiceVerificationResult {
    return { wakeWordMatch, speakerMatch, speakerConfidence, livenessResult, inputTrustLevel };
  }
}
