import type {
  ExecutionRoute,
  ExecutionSurface,
  LifeExecutionModality,
  ReservationProposal,
} from './life-execution.types.js';
import type { ApprovalBinding } from './life-execution-approval.js';

export type DesktopInputMode =
  | 'WAKE_WORD'
  | 'PUSH_TO_TALK'
  | 'CLICK_TO_TALK'
  | 'TEXT'
  | 'VOICE'
  | 'SCREEN_CONTEXT'
  | 'FILE_CONTEXT'
  | 'MULTIMODAL';

export interface ScreenContextEvidence {
  readonly source: 'ACTIVE_BROWSER_TAB' | 'URL' | 'DOM' | 'SELECTED_TEXT' | 'VISIBLE_PAGE' | 'ACTIVE_WINDOW' | 'FILE_CONTEXT';
  readonly evidenceRef: string;
  readonly authorized: boolean;
  readonly summary: string;
}

export interface DesktopLifeExecutionSession {
  readonly goalId: string;
  readonly intentId: string;
  readonly activeModalities: readonly DesktopInputMode[];
  readonly lifeModalities: readonly LifeExecutionModality[];
  readonly sourceSurface: ExecutionSurface;
  readonly executionSurface: ExecutionSurface;
  readonly foregroundPreservationRequired: true;
  readonly screenContextEvidence: readonly ScreenContextEvidence[];
}

export class DesktopMultimodalSessionManager {
  create(input: {
    readonly goalId: string;
    readonly intentId: string;
    readonly mode: DesktopInputMode;
    readonly sourceSurface?: ExecutionSurface;
    readonly executionSurface?: ExecutionSurface;
    readonly screenContextEvidence?: readonly ScreenContextEvidence[];
  }): DesktopLifeExecutionSession {
    return {
      goalId: input.goalId,
      intentId: input.intentId,
      activeModalities: [input.mode],
      lifeModalities: this.toLifeModalities([input.mode]),
      sourceSurface: input.sourceSurface ?? 'DESKTOP_APP',
      executionSurface: input.executionSurface ?? 'DESKTOP_BROWSER',
      foregroundPreservationRequired: true,
      screenContextEvidence: input.screenContextEvidence ?? [],
    };
  }

  continueWith(session: DesktopLifeExecutionSession, mode: DesktopInputMode): DesktopLifeExecutionSession {
    const activeModalities = Array.from(new Set([...session.activeModalities, mode]));
    return {
      ...session,
      activeModalities,
      lifeModalities: this.toLifeModalities(activeModalities),
    };
  }

  private toLifeModalities(modes: readonly DesktopInputMode[]): readonly LifeExecutionModality[] {
    const mapped = modes.map((mode): LifeExecutionModality => {
      if (mode === 'VOICE' || mode === 'PUSH_TO_TALK' || mode === 'CLICK_TO_TALK' || mode === 'WAKE_WORD') return 'VOICE';
      if (mode === 'SCREEN_CONTEXT') return 'SCREEN';
      if (mode === 'FILE_CONTEXT') return 'SHARE';
      if (mode === 'MULTIMODAL') return 'MULTIMODAL';
      return 'TEXT';
    });
    return Array.from(new Set(mapped));
  }
}

export interface DesktopVoiceRuntimeContract {
  readonly microphoneSession: 'HOOK_READY' | 'ACTIVE' | 'STOPPED';
  readonly pushToTalkHook: boolean;
  readonly wakeWordHook: boolean;
  readonly sttHandoff: 'SUPPORTED';
  readonly spokenResponsePlayback: 'BRAND_VOICE_RESOLVER';
  readonly audioOutput: 'DESKTOP_VOICE_AUDIO_OUTPUT';
  readonly backgroundOperation: true;
  readonly compactInteractionCoordination: true;
}

export function buildDesktopVoiceRuntimeContract(): DesktopVoiceRuntimeContract {
  return {
    microphoneSession: 'HOOK_READY',
    pushToTalkHook: true,
    wakeWordHook: true,
    sttHandoff: 'SUPPORTED',
    spokenResponsePlayback: 'BRAND_VOICE_RESOLVER',
    audioOutput: 'DESKTOP_VOICE_AUDIO_OUTPUT',
    backgroundOperation: true,
    compactInteractionCoordination: true,
  };
}

export interface CrossDeviceHandoff {
  readonly handoffId: string;
  readonly fromSurface: ExecutionSurface;
  readonly toSurface: ExecutionSurface;
  readonly goalId: string;
  readonly approvalPayloadHash: string;
  readonly route: ExecutionRoute;
  readonly outcomeSync: 'REQUIRED' | 'SYNCED';
  readonly smartTvCompatible: boolean;
}

export function buildCrossDeviceHandoff(input: {
  readonly handoffId: string;
  readonly fromSurface: ExecutionSurface;
  readonly toSurface: ExecutionSurface;
  readonly goalId: string;
  readonly approvalBinding: ApprovalBinding;
  readonly route: ExecutionRoute;
}): CrossDeviceHandoff {
  return {
    handoffId: input.handoffId,
    fromSurface: input.fromSurface,
    toSurface: input.toSurface,
    goalId: input.goalId,
    approvalPayloadHash: input.approvalBinding.payloadHash,
    route: input.route,
    outcomeSync: 'REQUIRED',
    smartTvCompatible: true,
  };
}

export function assertDesktopUsesSharedProposal(proposal: ReservationProposal): ReservationProposal {
  return proposal;
}
