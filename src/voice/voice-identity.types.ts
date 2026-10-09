export const DEFAULT_WAKE_PHRASE = '\uD5E4\uC774 \uB124\uC774\uC81D\uC2A4' as const;
export const SHORT_WAKE_PHRASE = '\uB124\uC774\uC81D\uC2A4' as const;
export const DISABLED_WAKE_PHRASE = '\uC74C\uC131 \uD638\uCD9C \uC0AC\uC6A9 \uC548 \uD568' as const;

export const LEGACY_AGEX_DEFAULT_WAKE_PHRASE = '\uD5E4\uC774 \uC5D0\uC774\uC81D\uC2A4' as const;
export const LEGACY_AGEX_SHORT_WAKE_PHRASE = '\uC5D0\uC774\uC81D\uC2A4' as const;
export const FORBIDDEN_OK_NAGEX_DEFAULT_WAKE_PHRASE = '\uC624\uCF00\uC774 \uB124\uC774\uC81D\uC2A4' as const;

export type WakePhraseMode = 'DEFAULT' | 'SHORT' | 'DISABLED';
export type SpeakerVerificationState = 'VERIFIED' | 'UNCERTAIN' | 'MISMATCH' | 'NOT_ENROLLED';
export type LivenessResult = 'LIVE_LIKELY' | 'REPLAY_SUSPECTED' | 'SYNTHETIC_SUSPECTED' | 'UNKNOWN';
export type InputTrustLevel = 'TRUSTED' | 'LIMITED' | 'UNTRUSTED' | 'DEVELOPMENT_TRUST';
export type VoiceSessionState = 'IDLE' | 'WAKE_DETECTED' | 'USER_VERIFIED' | 'LISTENING' | 'PROCESSING' | 'RESPONDING' | 'CONTINUATION_WINDOW';
export type VoiceRiskTier = 'LOW' | 'MEDIUM' | 'HIGH';
export type VoiceAuthorityDecision = 'ALLOW' | 'REQUIRE_APPROVAL' | 'BLOCK';

export interface VoiceIdentityPolicy {
  defaultWakePhrase: typeof DEFAULT_WAKE_PHRASE;
  shortWakePhrase: typeof SHORT_WAKE_PHRASE;
  disabledWakePhrase: typeof DISABLED_WAKE_PHRASE;
  okNagexDefault: false;
  rawEnrollmentAudioRetention: 'EPHEMERAL';
  voiceProfileDeviceLocalDefault: true;
  rawAudioSyncDefault: false;
  developmentTrustModeProductionAllowed: false;
}

export interface VoiceEnrollmentPrompt {
  id: string;
  text: string;
  kind: 'WAKE_PHRASE' | 'COMMAND_LIKE' | 'PHONETIC_VARIATION';
}

export interface VoiceEnrollmentDraft {
  prompts: VoiceEnrollmentPrompt[];
  minimumAcceptedSamples: number;
  rawAudioRetention: 'EPHEMERAL';
  secureProfileStorage: 'PLATFORM_KEYSTORE_REQUIRED_WHEN_AVAILABLE';
}

export interface VoiceProfile {
  profileId: string;
  tenantId: string;
  ownerId: string;
  deviceId: string;
  status: 'ENROLLED' | 'NOT_ENROLLED';
  storageScope: 'DEVICE_LOCAL';
  rawAudioRetained: false;
}

export interface VoiceVerificationInput {
  wakePhraseDetected: boolean;
  profile?: VoiceProfile | null;
  speakerMatchesProfile?: boolean;
  livenessResult?: LivenessResult;
  developmentTrustMode?: boolean;
  production?: boolean;
}

export interface VoiceVerificationResult {
  wakeWordMatch: boolean;
  speakerMatch: SpeakerVerificationState;
  speakerConfidence: number | null;
  livenessResult: LivenessResult;
  inputTrustLevel: InputTrustLevel;
}

export interface VoiceSession {
  state: VoiceSessionState;
  wakePhraseRequired: boolean;
  continuationUntil: number | null;
  trustLevel: InputTrustLevel;
}
