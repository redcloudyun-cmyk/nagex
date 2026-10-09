export type VoiceIntentTone = 'ACKNOWLEDGEMENT' | 'INFORMATION' | 'APPROVAL_REQUEST' | 'SUCCESS' | 'WARNING' | 'UNCERTAINTY';

export interface ProsodyPlan {
  tone: VoiceIntentTone;
  speakingRate: 'SLOW_CLEAR' | 'NORMAL' | 'BRISK';
  pitch: 'LOW_MID' | 'NEUTRAL';
  pauseMs: number;
  emphasis: string[];
}

export class ProsodyPlanner {
  public plan(tone: VoiceIntentTone, emphasis: string[] = []): ProsodyPlan {
    if (tone === 'WARNING' || tone === 'APPROVAL_REQUEST') {
      return { tone, speakingRate: 'SLOW_CLEAR', pitch: 'NEUTRAL', pauseMs: 320, emphasis };
    }
    if (tone === 'ACKNOWLEDGEMENT') {
      return { tone, speakingRate: 'BRISK', pitch: 'NEUTRAL', pauseMs: 120, emphasis };
    }
    return { tone, speakingRate: 'NORMAL', pitch: 'LOW_MID', pauseMs: 220, emphasis };
  }
}
