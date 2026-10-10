import { performance } from 'node:perf_hooks';
import { NagexError } from '../common/errors.js';
import type { ActionApprovalRecord } from '../governance/action-approval.store.js';
import type { DeviceIdentityStore } from '../device-agent/device-identity.store.js';
import type { ConversationTargetStore } from './conversation-target.store.js';
import { normalizeConversationIdentityText } from './conversation-target.store.js';
import type { KakaoAccessibilityDraftStore } from './kakao-accessibility-draft.store.js';
import { buildKakaoAccessibilityMessageHash } from './kakao-accessibility-draft.types.js';
import {
  ANDROID_ACCESSIBILITY_ROUTE,
  KAKAOTALK_PROVIDER,
  type KakaoAccessibilityApprovalService,
} from './kakaotalk-accessibility-approval.service.js';
import type { RecipientRefStore } from './recipient-ref.store.js';

export interface KakaoFastPathApprovalInput {
  tenantId: string;
  ownerId: string;
  userCommand: string;
  recipientQuery: string;
  message: string;
  requestId: string;
  preferredDeviceId?: string;
}

export interface KakaoFastPathApprovalTelemetry {
  intent_parse_ms: number;
  target_resolution_ms: number;
  context_resolution_ms: number;
  route_resolution_ms: number;
  policy_resolution_ms: number;
  approval_render_ms: number;
  approval_time_to_surface_ms: number;
  fallback: 'NONE' | 'UNCERTAIN_REQUIRES_LIVE_RESOLUTION';
}

export interface KakaoFastPathApprovalResult {
  mode: 'FAST_PATH_APPROVAL_READY';
  approval: ActionApprovalRecord;
  draftId: string;
  recipientRef: string;
  conversationRef: string;
  deviceId: string;
  provider: typeof KAKAOTALK_PROVIDER;
  route: typeof ANDROID_ACCESSIBILITY_ROUTE;
  recipientDisplayName: string;
  providerDisplayName: string;
  message: string;
  messageHash: string;
  labels: {
    approve: string;
    cancel: string;
  };
  telemetry: KakaoFastPathApprovalTelemetry;
}

export interface KakaoFastPathApprovalDeps {
  deviceIdentityStore: DeviceIdentityStore;
  recipientRefStore: RecipientRefStore;
  conversationTargetStore: ConversationTargetStore;
  draftStore: KakaoAccessibilityDraftStore;
  approvalService: KakaoAccessibilityApprovalService;
  nowMs?: () => number;
}

interface Timed<T> {
  value: T;
  ms: number;
}

const KAKAO_APP_PROFILE = Object.freeze({
  provider: KAKAOTALK_PROVIDER,
  route: ANDROID_ACCESSIBILITY_ROUTE,
  capabilities: ['SEARCH', 'DIRECT_CONVERSATION', 'COMPOSER', 'SEND'] as const,
  requiresLiveSendVerification: true,
});

export class KakaoTalkFastPathApprovalService {
  private readonly nowMs: () => number;

  constructor(private readonly deps: KakaoFastPathApprovalDeps) {
    this.nowMs = deps.nowMs ?? (() => performance.now());
  }

  public async prepareApproval(input: KakaoFastPathApprovalInput): Promise<KakaoFastPathApprovalResult> {
    const totalStart = this.nowMs();
    const intent = this.timeSync(() => this.parseIntent(input));

    const [deviceTimed, targetTimed, contextTimed, routeTimed, policyTimed] = await Promise.all([
      this.timeAsync(() => this.resolveDevice(input)),
      this.timeAsync(() => this.resolveRecipient(input)),
      this.timeAsync(() => this.resolveConversationContext(input)),
      this.timeAsync(() => this.resolveRoute()),
      this.timeAsync(() => this.resolvePolicy(input)),
    ]);

    const device = deviceTimed.value;
    const recipient = targetTimed.value;
    const conversation = this.requireConversation(input, device.deviceId, recipient.recipientRef, contextTimed.value);
    const route = routeTimed.value;

    const approvalStart = this.nowMs();
    const draft = this.deps.draftStore.create({
      tenantId: input.tenantId,
      ownerId: input.ownerId,
      deviceId: device.deviceId,
      recipientRef: recipient.recipientRef,
      conversationRef: conversation.conversationRef,
      provider: KAKAOTALK_PROVIDER,
      route: ANDROID_ACCESSIBILITY_ROUTE,
      expectedProviderDisplayName: conversation.providerDisplayName,
      message: intent.value.message,
      requestId: input.requestId,
    });
    if (draft.messageHash !== policyTimed.value.messageHash) {
      throw new NagexError({ code: 'KAKAO_FAST_PATH_HASH_INVALID', category: 'POLICY', message: 'Message hash policy produced an inconsistent value.', request_id: input.requestId });
    }
    const approval = this.deps.approvalService.requestSendApproval({
      tenantId: input.tenantId,
      ownerId: input.ownerId,
      draftId: draft.draftId,
      deviceId: device.deviceId,
      recipientRef: recipient.recipientRef,
      conversationRef: conversation.conversationRef,
      messageHash: draft.messageHash,
      expectedProviderDisplayName: conversation.providerDisplayName,
      requestId: input.requestId,
    });
    const approvalRenderMs = this.elapsed(approvalStart);

    return {
      mode: 'FAST_PATH_APPROVAL_READY',
      approval,
      draftId: draft.draftId,
      recipientRef: recipient.recipientRef,
      conversationRef: conversation.conversationRef,
      deviceId: device.deviceId,
      provider: route.provider,
      route: route.route,
      recipientDisplayName: recipient.displayName,
      providerDisplayName: conversation.providerDisplayName,
      message: draft.message,
      messageHash: draft.messageHash,
      labels: { approve: 'Send', cancel: 'Cancel' },
      telemetry: {
        intent_parse_ms: intent.ms,
        target_resolution_ms: targetTimed.ms,
        context_resolution_ms: contextTimed.ms,
        route_resolution_ms: routeTimed.ms,
        policy_resolution_ms: policyTimed.ms,
        approval_render_ms: approvalRenderMs,
        approval_time_to_surface_ms: this.elapsed(totalStart),
        fallback: 'NONE',
      },
    };
  }

  private parseIntent(input: KakaoFastPathApprovalInput): { recipientQuery: string; message: string } {
    const recipientQuery = input.recipientQuery.normalize('NFKC').trim();
    const message = input.message;
    if (!input.userCommand.trim() || !recipientQuery || !message.trim()) {
      throw new NagexError({ code: 'KAKAO_FAST_PATH_INTENT_INCOMPLETE', category: 'VALIDATION', message: 'userCommand, recipientQuery, and message are required.', request_id: input.requestId });
    }
    return { recipientQuery, message };
  }

  private resolveDevice(input: KakaoFastPathApprovalInput) {
    if (!input.preferredDeviceId) {
      throw new NagexError({ code: 'KAKAO_FAST_PATH_DEVICE_REQUIRED', category: 'VALIDATION', message: 'preferredDeviceId is required for deterministic fast-path routing.', request_id: input.requestId });
    }
    const device = this.deps.deviceIdentityStore.getOwned(input.preferredDeviceId, input.tenantId, input.ownerId);
    if (!device || device.status !== 'ACTIVE') {
      throw new NagexError({ code: 'KAKAO_FAST_PATH_DEVICE_NOT_ACTIVE', category: 'NOT_FOUND', message: 'Device is not active for this tenant/user.', request_id: input.requestId });
    }
    if (!device.capabilityInventory.includes('permission:ACCESSIBILITY_SERVICE:ENABLED')) {
      throw new NagexError({ code: 'KAKAO_FAST_PATH_ACCESSIBILITY_NOT_ENABLED', category: 'POLICY', message: 'Accessibility is required for KakaoTalk fast-path execution.', request_id: input.requestId });
    }
    return device;
  }

  private resolveRecipient(input: KakaoFastPathApprovalInput) {
    const normalizedQuery = normalizeConversationIdentityText(input.recipientQuery);
    const candidates = this.scanRecipientRefs(input.tenantId, input.ownerId, input.preferredDeviceId)
      .filter((record) => {
        const displayName = normalizeConversationIdentityText(record.displayName);
        return displayName === normalizedQuery || displayName.includes(normalizedQuery);
      });
    if (candidates.length !== 1) {
      throw new NagexError({ code: 'KAKAO_FAST_PATH_RECIPIENT_UNCERTAIN', category: 'POLICY', message: 'Fast path requires exactly one cached recipient match; use live resolution fallback.', request_id: input.requestId });
    }
    return candidates[0];
  }

  private resolveConversationContext(input: KakaoFastPathApprovalInput) {
    return {
      tenantId: input.tenantId,
      ownerId: input.ownerId,
      deviceId: input.preferredDeviceId,
      recipientQuery: input.recipientQuery,
    };
  }

  private requireConversation(input: KakaoFastPathApprovalInput, deviceId: string, recipientRef: string, _context: ReturnType<KakaoTalkFastPathApprovalService['resolveConversationContext']>) {
    const normalizedQuery = normalizeConversationIdentityText(input.recipientQuery);
    const conversations = this.scanConversationTargets(input.tenantId, input.ownerId, deviceId)
      .filter((record) => record.provider === KAKAOTALK_PROVIDER)
      .filter((record) => record.targetType === 'DIRECT')
      .filter((record) => record.recipientRef === recipientRef)
      .filter((record) => {
        const searchableIdentity = [
          record.providerDisplayName,
          record.conversationTitle,
          ...record.participantHints,
        ].map(normalizeConversationIdentityText).join(' ');
        return searchableIdentity.includes(normalizedQuery);
      });
    if (conversations.length !== 1) {
      throw new NagexError({ code: 'KAKAO_FAST_PATH_CONVERSATION_UNCERTAIN', category: 'POLICY', message: 'Fast path requires exactly one cached DIRECT KakaoTalk conversation; use live search fallback.', request_id: input.requestId });
    }
    return conversations[0];
  }

  private resolveRoute() {
    return {
      provider: KAKAO_APP_PROFILE.provider,
      route: KAKAO_APP_PROFILE.route,
      capabilities: [...KAKAO_APP_PROFILE.capabilities],
      requiresLiveSendVerification: KAKAO_APP_PROFILE.requiresLiveSendVerification,
    };
  }

  private resolvePolicy(input: KakaoFastPathApprovalInput): { messageHash: string } {
    const messageHash = buildKakaoAccessibilityMessageHash(input.message);
    if (!messageHash.startsWith('sha256:')) {
      throw new NagexError({ code: 'KAKAO_FAST_PATH_HASH_INVALID', category: 'POLICY', message: 'Message hash could not be computed.', request_id: input.requestId });
    }
    return { messageHash };
  }

  private scanRecipientRefs(tenantId: string, ownerId: string, deviceId?: string) {
    if (!deviceId) return [];
    return this.deps.recipientRefStore.listForOwnerDevice(tenantId, ownerId, deviceId);
  }

  private scanConversationTargets(tenantId: string, ownerId: string, deviceId: string) {
    return this.deps.conversationTargetStore.listForOwnerDevice(tenantId, ownerId, deviceId);
  }

  private async timeAsync<T>(fn: () => T | Promise<T>): Promise<Timed<T>> {
    const start = this.nowMs();
    const value = await fn();
    return { value, ms: this.elapsed(start) };
  }

  private timeSync<T>(fn: () => T): Timed<T> {
    const start = this.nowMs();
    const value = fn();
    return { value, ms: this.elapsed(start) };
  }

  private elapsed(start: number): number {
    return Math.max(0, this.nowMs() - start);
  }
}
