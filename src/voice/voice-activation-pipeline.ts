export type VoiceActivationMode = 'WAKE_WORD' | 'PUSH_TO_TALK';

export type VoicePipelineState =
  | 'IDLE'
  | 'WAKE_LISTENING'
  | 'WAKE_DETECTED'
  | 'COMMAND_LISTENING'
  | 'PROCESSING'
  | 'RESPONDING'
  | 'CONTINUATION_WINDOW';

export interface WakeDetectorResult {
  executed: boolean;
  detected: boolean;
  phrase: string | null;
  confidence: number | null;
  timestampMs: number | null;
  detectorType: 'ON_DEVICE_WAKE_DETECTOR' | 'TRANSCRIPT_DIAGNOSTIC' | 'UNAVAILABLE';
}

export interface VoiceSessionContext {
  id: string;
  mode: VoiceActivationMode;
  state: VoicePipelineState;
  wakeDetectorResult?: WakeDetectorResult | null;
  speakerVerified: boolean;
  livenessCertified: boolean;
  continuationUntilMs?: number | null;
}

export interface CommandAcceptanceInput {
  session: VoiceSessionContext;
  sttText: string;
  nowMs?: number;
  wakePhraseInTranscript?: boolean;
}

export interface CommandAcceptanceResult {
  accepted: boolean;
  reason: 'PUSH_TO_TALK_INPUT' | 'WAKE_DETECTED' | 'CONTINUATION_WINDOW' | 'NO_VALID_ACTIVATION';
  state: VoicePipelineState;
  speakerAuthorityGranted: false;
  commandText: string;
}

export interface AudioFrame {
  id: string;
  payload: string;
  capturedAtMs: number;
}

export class EphemeralAudioPrerollBuffer {
  private readonly frames: AudioFrame[] = [];

  public constructor(private readonly maxFrames: number) {
    if (!Number.isInteger(maxFrames) || maxFrames < 1) {
      throw new Error('AUDIO_PREROLL_REQUIRES_POSITIVE_FRAME_LIMIT');
    }
  }

  public add(frame: AudioFrame): void {
    this.frames.push(frame);
    while (this.frames.length > this.maxFrames) this.frames.shift();
  }

  public commandSegment(postWakeFrames: readonly AudioFrame[]): AudioFrame[] {
    return [...this.frames, ...postWakeFrames];
  }

  public clear(): void {
    this.frames.length = 0;
  }

  public persisted(): false {
    return false;
  }

  public size(): number {
    return this.frames.length;
  }
}

export class VoiceActivationPipeline {
  public startWakeListening(sessionId: string): VoiceSessionContext {
    return {
      id: sessionId,
      mode: 'WAKE_WORD',
      state: 'WAKE_LISTENING',
      speakerVerified: false,
      livenessCertified: false,
      continuationUntilMs: null,
    };
  }

  public startPushToTalk(sessionId: string): VoiceSessionContext {
    return {
      id: sessionId,
      mode: 'PUSH_TO_TALK',
      state: 'COMMAND_LISTENING',
      speakerVerified: false,
      livenessCertified: false,
      continuationUntilMs: null,
    };
  }

  public onWakeDetection(session: VoiceSessionContext, wake: WakeDetectorResult): VoiceSessionContext {
    if (session.mode !== 'WAKE_WORD' || !wake.executed || !wake.detected) {
      return { ...session, wakeDetectorResult: wake };
    }
    return { ...session, wakeDetectorResult: wake, state: 'COMMAND_LISTENING' };
  }

  public enterContinuationWindow(session: VoiceSessionContext, nowMs: number, durationMs = 45_000): VoiceSessionContext {
    return {
      ...session,
      state: 'CONTINUATION_WINDOW',
      continuationUntilMs: nowMs + durationMs,
    };
  }

  public acceptCommand(input: CommandAcceptanceInput): CommandAcceptanceResult {
    const nowMs = input.nowMs ?? Date.now();
    const commandText = input.sttText.trim();

    if (input.session.mode === 'PUSH_TO_TALK') {
      return this.accept('PUSH_TO_TALK_INPUT', commandText);
    }

    if (
      input.session.state === 'CONTINUATION_WINDOW' &&
      input.session.continuationUntilMs !== null &&
      input.session.continuationUntilMs !== undefined &&
      nowMs <= input.session.continuationUntilMs
    ) {
      return this.accept('CONTINUATION_WINDOW', commandText);
    }

    if (input.session.wakeDetectorResult?.executed === true && input.session.wakeDetectorResult.detected === true) {
      return this.accept('WAKE_DETECTED', commandText);
    }

    void input.wakePhraseInTranscript;
    return {
      accepted: false,
      reason: 'NO_VALID_ACTIVATION',
      state: input.session.state,
      speakerAuthorityGranted: false,
      commandText,
    };
  }

  private accept(reason: CommandAcceptanceResult['reason'], commandText: string): CommandAcceptanceResult {
    return {
      accepted: true,
      reason,
      state: 'PROCESSING',
      speakerAuthorityGranted: false,
      commandText,
    };
  }
}
