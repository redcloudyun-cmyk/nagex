import { performance } from 'node:perf_hooks';
import { NagexError } from '../common/errors.js';
import type { DevicePendingCommandStore } from '../device-agent/device-pending-command.store.js';
import type { DeviceCommandStatusStore } from '../device-agent/device-command-status.store.js';
import { ANDROID_ACCESSIBILITY_ROUTE, KAKAOTALK_PROVIDER } from '../mobile/kakaotalk-accessibility-approval.service.js';
import type { KakaoTalkFastPathApprovalService } from '../mobile/kakaotalk-fast-path-approval.service.js';
import type { CommandContextStore } from './command-context.store.js';
import type { CommandContext, CommandInputArtifact, InputModality } from './command-context.types.js';

export interface SubmitCommandInput {
  tenantId: string;
  principalId: string;
  text?: string;
  inputModality?: InputModality;
  originDeviceId?: string | null;
  originDeviceType?: string | null;
  originSurface?: string;
  inputArtifacts?: CommandInputArtifact[];
  foregroundApp?: string | null;
  activeWindow?: string | null;
  selectedText?: string | null;
  screenContext?: Record<string, unknown> | null;
  audioTranscript?: string | null;
  preferredExecutionDeviceId?: string | null;
  requestId: string;
}

export interface SubmitCommandResult {
  handled: boolean;
  mode: 'KAKAO_FAST_PATH_APPROVAL' | 'UNSUPPORTED_MODALITY' | 'UNRECOGNIZED_TEXT';
  commandContext?: CommandContext;
  approval?: Record<string, unknown>;
  telemetry?: Record<string, number | string>;
  capabilityState?: 'LIVE' | 'BETA' | 'UNAVAILABLE';
  reason?: string;
}

export interface DispatchApprovedInput {
  tenantId: string;
  principalId: string;
  approvalId: string;
  requestId: string;
}

export interface MultimodalCommandServiceDeps {
  commandContextStore: CommandContextStore;
  kakaoFastPathApprovalService: KakaoTalkFastPathApprovalService;
  devicePendingCommandStore: DevicePendingCommandStore;
  deviceCommandStatusStore: DeviceCommandStatusStore;
  nowMs?: () => number;
}

interface ParsedKakaoTextIntent {
  recipientQuery: string;
  message: string;
  confidence: number;
  evidence: Array<Record<string, unknown>>;
}

export class MultimodalCommandService {
  private readonly nowMs: () => number;

  constructor(private readonly deps: MultimodalCommandServiceDeps) {
    this.nowMs = deps.nowMs ?? (() => performance.now());
  }

  public async submit(input: SubmitCommandInput): Promise<SubmitCommandResult> {
    const modality = input.inputModality ?? 'TEXT';
    const rawUserIntent = (input.text ?? input.audioTranscript ?? '').trim();
    if (modality !== 'TEXT') {
      const context = this.deps.commandContextStore.create({
        tenantId: input.tenantId,
        principalId: input.principalId,
        originDeviceId: input.originDeviceId ?? null,
        originDeviceType: input.originDeviceType ?? null,
        originSurface: input.originSurface ?? 'HOME',
        inputModality: modality,
        inputArtifacts: input.inputArtifacts ?? [],
        foregroundApp: input.foregroundApp ?? null,
        activeWindow: input.activeWindow ?? null,
        selectedText: input.selectedText ?? null,
        sharedFiles: (input.inputArtifacts ?? []).filter((artifact) => artifact.modality === 'FILE'),
        screenContext: input.screenContext ?? null,
        audioTranscript: input.audioTranscript ?? null,
        rawUserIntent,
        normalizedIntent: 'UNKNOWN',
        entities: {},
        constraints: { productionExecutionEnabled: false },
        preferredExecutionDeviceId: input.preferredExecutionDeviceId ?? null,
        resolvedExecutionDeviceId: null,
        resolvedExecutionRoute: null,
        confidence: 0,
        evidence: [{ kind: 'MODALITY_INTERFACE_ONLY', modality }],
      });
      return {
        handled: false,
        mode: 'UNSUPPORTED_MODALITY',
        commandContext: context,
        capabilityState: 'BETA',
        reason: `${modality} is normalized into CommandContext plumbing, but the production execution path is not enabled yet.`,
      };
    }
    const parsed = this.parseKakaoTextIntent(rawUserIntent);
    if (!parsed) return { handled: false, mode: 'UNRECOGNIZED_TEXT', reason: 'Text was not a supported executable command.' };

    const start = this.nowMs();
    const approval = await this.deps.kakaoFastPathApprovalService.prepareApproval({
      tenantId: input.tenantId,
      ownerId: input.principalId,
      userCommand: rawUserIntent,
      recipientQuery: parsed.recipientQuery,
      message: parsed.message,
      requestId: input.requestId,
      preferredDeviceId: input.preferredExecutionDeviceId ?? undefined,
    });
    const context = this.deps.commandContextStore.create({
      tenantId: input.tenantId,
      principalId: input.principalId,
      originDeviceId: input.originDeviceId ?? null,
      originDeviceType: input.originDeviceType ?? null,
      originSurface: input.originSurface ?? 'HOME',
      inputModality: modality,
      inputArtifacts: input.inputArtifacts ?? [],
      foregroundApp: input.foregroundApp ?? null,
      activeWindow: input.activeWindow ?? null,
      selectedText: input.selectedText ?? null,
      sharedFiles: (input.inputArtifacts ?? []).filter((artifact) => artifact.modality === 'FILE'),
      screenContext: input.screenContext ?? null,
      audioTranscript: input.audioTranscript ?? null,
      rawUserIntent,
      normalizedIntent: 'SEND_MESSAGE',
      entities: {
        provider: KAKAOTALK_PROVIDER,
        recipient: parsed.recipientQuery,
        message: parsed.message,
      },
      constraints: {
        approvalRequired: true,
        exactMessageRequired: true,
        liveOutcomeVerificationRequired: true,
        cleanupRequired: true,
      },
      preferredExecutionDeviceId: input.preferredExecutionDeviceId ?? null,
      resolvedExecutionDeviceId: approval.deviceId,
      resolvedExecutionRoute: ANDROID_ACCESSIBILITY_ROUTE,
      confidence: parsed.confidence,
      evidence: parsed.evidence,
      executionThreadId: approval.draftId,
    });

    return {
      handled: true,
      mode: 'KAKAO_FAST_PATH_APPROVAL',
      commandContext: context,
      approval: {
        approvalId: approval.approval.approvalId,
        draftId: approval.draftId,
        recipientDisplayName: approval.recipientDisplayName,
        providerDisplayName: approval.providerDisplayName,
        message: approval.message,
        deviceId: approval.deviceId,
        provider: approval.provider,
        route: approval.route,
      },
      telemetry: {
        ...approval.telemetry,
        approval_surface_ms: Math.max(0, this.nowMs() - start),
      },
    };
  }

  public dispatchApproved(input: DispatchApprovedInput): { dispatched: boolean; commandId?: string; reason?: string } {
    const record = this.deps.commandContextStore.list(input.tenantId, input.principalId)
      .find((context) => context.normalizedIntent === 'SEND_MESSAGE');
    void record;
    return { dispatched: false, reason: 'Approval dispatch is owned by the device-agent accessibility send route.' };
  }

  private parseKakaoTextIntent(text: string): ParsedKakaoTextIntent | null {
    const normalized = text.normalize('NFKC').trim();
    if (!normalized || !/카카오|kakao/i.test(normalized) || !/보내|send/i.test(normalized)) return null;
    const english = normalized.match(/send\s+kakao(?:talk)?\s+to\s+(.+?):\s*(.+)$/i);
    if (english?.[1] && english?.[2]) {
      return {
        recipientQuery: english[1].trim(),
        message: english[2].trim(),
        confidence: 0.91,
        evidence: [
          { kind: 'TEXT_PATTERN', matched: 'KAKAOTALK_SEND_EN' },
          { kind: 'RECIPIENT_FRAGMENT', value: english[1].trim() },
          { kind: 'MESSAGE_FRAGMENT', value: english[2].trim() },
        ],
      };
    }
    const quoted = normalized.match(/["“](.+?)["”]/);
    const recipientMatch = normalized.match(/^(.+?)(?:에게|한테|께| to )/i);
    const messageMatch = quoted?.[1]
      ?? normalized.match(/(?:로|으로)\s*(.+?)(?:라고|하고)?\s*보내/i)?.[1]
      ?? normalized.match(/(?:message|text)\s+(.+?)\s+(?:to|via)/i)?.[1];
    const recipientQuery = recipientMatch?.[1]?.replace(/카카오톡|카카오|kakaotalk|kakao/ig, '').trim();
    const message = messageMatch?.trim();
    if (!recipientQuery || !message) return null;
    return {
      recipientQuery,
      message,
      confidence: 0.91,
      evidence: [
        { kind: 'TEXT_PATTERN', matched: 'KAKAOTALK_SEND' },
        { kind: 'RECIPIENT_FRAGMENT', value: recipientQuery },
        { kind: 'MESSAGE_FRAGMENT', value: message },
      ],
    };
  }
}
