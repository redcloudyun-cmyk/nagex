import { NagexError } from '../common/errors.js';
import { hashCanonicalPayload, type ActionApprovalStore, type ActionApprovalRecord } from '../governance/action-approval.store.js';
import type { ConversationTargetStore } from './conversation-target.store.js';
import { normalizeConversationIdentityText } from './conversation-target.store.js';
import type { KakaoAccessibilityDraftStore } from './kakao-accessibility-draft.store.js';
import type { RecipientRefStore } from './recipient-ref.store.js';

export const KAKAOTALK_ACCESSIBILITY_DRAFT_TOOL_ID = 'KAKAOTALK_ACCESSIBILITY_DRAFT';
export const KAKAOTALK_ACCESSIBILITY_SEND_TOOL_ID = 'KAKAOTALK_ACCESSIBILITY_SEND';
export const KAKAOTALK_PROVIDER = 'KAKAOTALK';
export const ANDROID_ACCESSIBILITY_ROUTE = 'ANDROID_ACCESSIBILITY';
export const SELECT_KAKAO_DIRECT_CONVERSATION_ACTION = 'SELECT_KAKAO_DIRECT_CONVERSATION';
export const SEND_KAKAO_DIRECT_MESSAGE_ACTION = 'SEND_MESSAGE';

export interface KakaoAccessibilityDraftApprovalInput {
  tenantId: string;
  ownerId: string;
  draftId: string;
  deviceId: string;
  recipientRef: string;
  conversationRef: string;
  messageHash: string;
  expectedProviderDisplayName: string;
  requestId: string;
}

export interface KakaoAccessibilityDraftApprovalPayload {
  action: typeof SELECT_KAKAO_DIRECT_CONVERSATION_ACTION;
  draftId: string;
  deviceId: string;
  recipientRef: string;
  messageHash: string;
  provider: typeof KAKAOTALK_PROVIDER;
  route: typeof ANDROID_ACCESSIBILITY_ROUTE;
  expectedProviderDisplayName: string;
  conversationRef: string;
}

export interface KakaoAccessibilitySendApprovalPayload {
  action: typeof SEND_KAKAO_DIRECT_MESSAGE_ACTION;
  draftId: string;
  deviceId: string;
  recipientRef: string;
  messageHash: string;
  provider: typeof KAKAOTALK_PROVIDER;
  route: typeof ANDROID_ACCESSIBILITY_ROUTE;
  expectedProviderDisplayName: string;
  conversationRef: string;
}

export interface KakaoAccessibilityApprovalDisplayDetails {
  targetContact: string | null;
  kakaoIdentity: string;
  message: string | null;
  action: string;
  provider: typeof KAKAOTALK_PROVIDER;
  route: typeof ANDROID_ACCESSIBILITY_ROUTE;
  draftId: string;
  deviceId: string;
  recipientRef: string;
  conversationRef: string;
  expectedProviderDisplayName: string;
  messageHash: string;
}

export class KakaoAccessibilityApprovalService {
  constructor(
    private readonly approvals: ActionApprovalStore,
    private readonly recipientRefs: RecipientRefStore,
    private readonly conversationTargets: ConversationTargetStore,
    private readonly drafts: KakaoAccessibilityDraftStore,
  ) {}

  public requestDraftApproval(input: KakaoAccessibilityDraftApprovalInput): ActionApprovalRecord {
    const payload = this.buildBoundPayload(input);
    const record = this.approvals.request({
      toolId: KAKAOTALK_ACCESSIBILITY_DRAFT_TOOL_ID,
      tenantId: input.tenantId,
      principalId: input.ownerId,
      payload: { ...payload },
    });
    this.drafts.markApprovalRequired(input.draftId, input.tenantId, input.ownerId, record.approvalId, input.requestId);
    return record;
  }

  public consumeDraftApproval(approvalId: string, input: KakaoAccessibilityDraftApprovalInput, executionId: string): ActionApprovalRecord {
    const payload = this.buildBoundPayload(input);
    const record = this.approvals.consume(
      approvalId,
      input.tenantId,
      input.ownerId,
      KAKAOTALK_ACCESSIBILITY_DRAFT_TOOL_ID,
      { ...payload },
      input.requestId,
      executionId,
    );
    this.drafts.markApproved(input.draftId, input.tenantId, input.ownerId, approvalId, input.requestId);
    return record;
  }

  public describeApprovalForHuman(record: ActionApprovalRecord): KakaoAccessibilityApprovalDisplayDetails | null {
    if (record.toolId !== KAKAOTALK_ACCESSIBILITY_DRAFT_TOOL_ID && record.toolId !== KAKAOTALK_ACCESSIBILITY_SEND_TOOL_ID) return null;
    const payload = record.canonicalPayload as Partial<KakaoAccessibilityDraftApprovalPayload | KakaoAccessibilitySendApprovalPayload>;
    if (
      (payload.action !== SELECT_KAKAO_DIRECT_CONVERSATION_ACTION && payload.action !== SEND_KAKAO_DIRECT_MESSAGE_ACTION)
      || payload.provider !== KAKAOTALK_PROVIDER
      || payload.route !== ANDROID_ACCESSIBILITY_ROUTE
      || typeof payload.draftId !== 'string'
      || typeof payload.deviceId !== 'string'
      || typeof payload.recipientRef !== 'string'
      || typeof payload.conversationRef !== 'string'
      || typeof payload.expectedProviderDisplayName !== 'string'
      || typeof payload.messageHash !== 'string'
    ) {
      return null;
    }

    const draft = this.drafts.getOwned(payload.draftId, record.tenantId, record.principalId);
    const recipient = this.recipientRefs.getOwned(payload.recipientRef, record.tenantId, record.principalId, payload.deviceId);
    const conversation = this.conversationTargets.getOwned(payload.conversationRef, record.tenantId, record.principalId, payload.deviceId);

    return {
      targetContact: recipient?.displayName ?? null,
      kakaoIdentity: conversation?.providerDisplayName ?? payload.expectedProviderDisplayName,
      message: draft?.message ?? null,
      action: payload.action === SEND_KAKAO_DIRECT_MESSAGE_ACTION
        ? 'Send the exact approved KakaoTalk message in this bound DIRECT conversation.'
        : 'Open the bound KakaoTalk DIRECT conversation for this approved draft.',
      provider: KAKAOTALK_PROVIDER,
      route: ANDROID_ACCESSIBILITY_ROUTE,
      draftId: payload.draftId,
      deviceId: payload.deviceId,
      recipientRef: payload.recipientRef,
      conversationRef: payload.conversationRef,
      expectedProviderDisplayName: payload.expectedProviderDisplayName,
      messageHash: payload.messageHash,
    };
  }

  public buildBoundPayload(input: KakaoAccessibilityDraftApprovalInput): KakaoAccessibilityDraftApprovalPayload {
    return this.buildBoundPayloadForAction(input, SELECT_KAKAO_DIRECT_CONVERSATION_ACTION) as KakaoAccessibilityDraftApprovalPayload;
  }

  public requestSendApproval(input: KakaoAccessibilityDraftApprovalInput): ActionApprovalRecord {
    const payload = this.buildBoundPayloadForAction(input, SEND_KAKAO_DIRECT_MESSAGE_ACTION);
    return this.approvals.request({
      toolId: KAKAOTALK_ACCESSIBILITY_SEND_TOOL_ID,
      tenantId: input.tenantId,
      principalId: input.ownerId,
      payload: { ...payload },
    });
  }

  public consumeSendApproval(approvalId: string, input: KakaoAccessibilityDraftApprovalInput, executionId: string): ActionApprovalRecord {
    const payload = this.buildBoundPayloadForAction(input, SEND_KAKAO_DIRECT_MESSAGE_ACTION);
    return this.approvals.consume(
      approvalId,
      input.tenantId,
      input.ownerId,
      KAKAOTALK_ACCESSIBILITY_SEND_TOOL_ID,
      { ...payload },
      input.requestId,
      executionId,
    );
  }

  public assertSendApprovalExecutable(approvalId: string, input: KakaoAccessibilityDraftApprovalInput): ActionApprovalRecord {
    const payload = this.buildBoundPayloadForAction(input, SEND_KAKAO_DIRECT_MESSAGE_ACTION);
    const record = this.approvals.assertExecutable(
      approvalId,
      input.tenantId,
      input.ownerId,
      KAKAOTALK_ACCESSIBILITY_SEND_TOOL_ID,
      input.requestId,
    );
    if (record.payloadHash !== hashCanonicalPayload({ ...payload })) {
      throw new NagexError({ code: 'APPROVAL_PAYLOAD_MISMATCH', category: 'POLICY', message: 'Approval payload does not match the requested KakaoTalk SEND binding.', request_id: input.requestId });
    }
    return record;
  }

  private buildBoundPayloadForAction(input: KakaoAccessibilityDraftApprovalInput, action: typeof SELECT_KAKAO_DIRECT_CONVERSATION_ACTION | typeof SEND_KAKAO_DIRECT_MESSAGE_ACTION): KakaoAccessibilityDraftApprovalPayload | KakaoAccessibilitySendApprovalPayload {
    if (!input.deviceId.trim() || !input.recipientRef.trim() || !input.conversationRef.trim() || !input.messageHash.trim() || !input.expectedProviderDisplayName.trim()) {
      throw new NagexError({ code: 'KAKAOTALK_ACCESSIBILITY_APPROVAL_FIELDS_REQUIRED', category: 'VALIDATION', message: 'draftId, deviceId, recipientRef, conversationRef, messageHash, and expectedProviderDisplayName are required.', request_id: input.requestId });
    }
    if (!input.draftId.trim() || !input.draftId.startsWith('kdr_')) {
      throw new NagexError({ code: 'KAKAO_ACCESSIBILITY_DRAFT_ID_INVALID', category: 'VALIDATION', message: 'draftId must be a server-owned kdr_* reference.', request_id: input.requestId });
    }
    if (!input.conversationRef.startsWith('cvr_')) {
      throw new NagexError({ code: 'CONVERSATION_REF_INVALID', category: 'VALIDATION', message: 'conversationRef must be a server-owned cvr_* reference.', request_id: input.requestId });
    }
    const recipient = this.recipientRefs.getOwned(input.recipientRef, input.tenantId, input.ownerId, input.deviceId);
    if (!recipient) {
      throw new NagexError({ code: 'RECIPIENT_REF_NOT_FOUND', category: 'NOT_FOUND', message: 'recipientRef was not found for this tenant/user/device.', request_id: input.requestId });
    }
    const conversation = this.conversationTargets.getOwned(input.conversationRef, input.tenantId, input.ownerId, input.deviceId);
    if (!conversation) {
      throw new NagexError({ code: 'CONVERSATION_TARGET_NOT_FOUND', category: 'NOT_FOUND', message: 'conversationRef was not found for this tenant/user/device.', request_id: input.requestId });
    }
    if (conversation.provider !== KAKAOTALK_PROVIDER) {
      throw new NagexError({ code: 'CONVERSATION_PROVIDER_MISMATCH', category: 'POLICY', message: 'Conversation target provider must be KakaoTalk.', request_id: input.requestId });
    }
    if (conversation.targetType !== 'DIRECT') {
      throw new NagexError({ code: 'CONVERSATION_TARGET_NOT_DIRECT', category: 'POLICY', message: 'Person-directed KakaoTalk accessibility plans require a DIRECT conversation target.', request_id: input.requestId });
    }
    if (conversation.recipientRef !== input.recipientRef) {
      throw new NagexError({ code: 'CONVERSATION_RECIPIENT_MISMATCH', category: 'POLICY', message: 'Conversation target recipientRef does not match the plan recipientRef.', request_id: input.requestId });
    }
    if (normalizeConversationIdentityText(conversation.providerDisplayName) !== normalizeConversationIdentityText(input.expectedProviderDisplayName)) {
      throw new NagexError({ code: 'CONVERSATION_PROVIDER_DISPLAY_NAME_MISMATCH', category: 'POLICY', message: 'Conversation target provider display name does not match the expected target identity.', request_id: input.requestId });
    }
    const draft = this.drafts.requireApprovalEligible(input.draftId, input.tenantId, input.ownerId, input.requestId);
    if (draft.deviceId !== input.deviceId || draft.recipientRef !== input.recipientRef || draft.conversationRef !== input.conversationRef || draft.messageHash !== input.messageHash) {
      throw new NagexError({ code: 'KAKAO_ACCESSIBILITY_DRAFT_BINDING_MISMATCH', category: 'POLICY', message: 'Draft binding does not match the approval payload.', request_id: input.requestId });
    }
    return {
      action,
      draftId: input.draftId,
      deviceId: input.deviceId,
      recipientRef: input.recipientRef,
      messageHash: input.messageHash,
      provider: KAKAOTALK_PROVIDER,
      route: ANDROID_ACCESSIBILITY_ROUTE,
      expectedProviderDisplayName: input.expectedProviderDisplayName,
      conversationRef: input.conversationRef,
    };
  }
}
