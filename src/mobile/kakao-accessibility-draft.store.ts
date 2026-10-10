import { NagexError } from '../common/errors.js';
import { generateResourceId, getCurrentISOString } from '../common/utils.js';
import type { DeviceIdentityStore } from '../device-agent/device-identity.store.js';
import { FileRecordStore, resolveNagexDataDir } from '../governance/file-record.store.js';
import type { ConversationTargetStore } from './conversation-target.store.js';
import { normalizeConversationIdentityText } from './conversation-target.store.js';
import type { RecipientRefStore } from './recipient-ref.store.js';
import {
  buildKakaoAccessibilityMessageHash,
  isKakaoAccessibilityDraftRecord,
  type KakaoAccessibilityDraftRecord,
} from './kakao-accessibility-draft.types.js';

export interface KakaoAccessibilityDraftStoreOptions {
  dir?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => string;
}

export interface KakaoAccessibilityDraftStoreDeps {
  deviceIdentityStore: DeviceIdentityStore;
  recipientRefStore: RecipientRefStore;
  conversationTargetStore: ConversationTargetStore;
}

export interface CreateKakaoAccessibilityDraftInput {
  tenantId: string;
  ownerId: string;
  deviceId: string;
  recipientRef: string;
  conversationRef: string;
  provider: 'KAKAOTALK';
  route: 'ANDROID_ACCESSIBILITY';
  expectedProviderDisplayName: string;
  message: string;
  requestId: string;
  draftId?: never;
}

export class KakaoAccessibilityDraftStore {
  private readonly records = new Map<string, KakaoAccessibilityDraftRecord>();
  private readonly fileStore: FileRecordStore<KakaoAccessibilityDraftRecord>;
  private readonly now: () => string;

  constructor(
    private readonly deps: KakaoAccessibilityDraftStoreDeps,
    options: KakaoAccessibilityDraftStoreOptions = {},
  ) {
    const env = options.env ?? process.env;
    const dir = options.dir ?? resolveNagexDataDir('kakao-accessibility-drafts', 'NAGEX_KAKAO_ACCESSIBILITY_DRAFTS_DIR', env);
    this.fileStore = new FileRecordStore<KakaoAccessibilityDraftRecord>(dir, isKakaoAccessibilityDraftRecord);
    this.now = options.now ?? getCurrentISOString;
    for (const record of this.fileStore.readAll()) {
      this.records.set(record.draftId, record);
    }
  }

  public create(input: CreateKakaoAccessibilityDraftInput): KakaoAccessibilityDraftRecord {
    this.validateCreate(input);
    const message = input.message;
    if (!message.trim()) {
      throw new NagexError({ code: 'KAKAO_ACCESSIBILITY_DRAFT_MESSAGE_REQUIRED', category: 'VALIDATION', message: 'message is required.', request_id: input.requestId });
    }
    const timestamp = this.now();
    const record: KakaoAccessibilityDraftRecord = {
      draftId: generateResourceId('kdr'),
      tenantId: input.tenantId,
      ownerId: input.ownerId,
      deviceId: input.deviceId,
      recipientRef: input.recipientRef,
      conversationRef: input.conversationRef,
      provider: 'KAKAOTALK',
      route: 'ANDROID_ACCESSIBILITY',
      expectedProviderDisplayName: input.expectedProviderDisplayName,
      message,
      messageHash: buildKakaoAccessibilityMessageHash(message),
      status: 'DRAFT',
      approvalId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.records.set(record.draftId, record);
    this.fileStore.writeOrThrow(record.draftId, record);
    return record;
  }

  public getOwned(draftId: string, tenantId: string, ownerId: string): KakaoAccessibilityDraftRecord | null {
    const record = this.records.get(draftId);
    if (!record) return null;
    if (record.tenantId !== tenantId || record.ownerId !== ownerId) return null;
    return record;
  }

  public requireApprovalEligible(draftId: string, tenantId: string, ownerId: string, requestId: string): KakaoAccessibilityDraftRecord {
    const record = this.getOwned(draftId, tenantId, ownerId);
    if (!record) {
      throw new NagexError({ code: 'KAKAO_ACCESSIBILITY_DRAFT_NOT_FOUND', category: 'NOT_FOUND', message: 'Kakao accessibility draft was not found for this tenant/user.', request_id: requestId });
    }
    if (record.status !== 'DRAFT' && record.status !== 'APPROVAL_REQUIRED' && record.status !== 'APPROVED') {
      throw new NagexError({ code: 'KAKAO_ACCESSIBILITY_DRAFT_NOT_APPROVAL_ELIGIBLE', category: 'CONFLICT', message: `Draft ${draftId} is ${record.status}.`, request_id: requestId });
    }
    return record;
  }

  public requireExecutable(draftId: string, tenantId: string, ownerId: string, requestId: string): KakaoAccessibilityDraftRecord {
    const record = this.getOwned(draftId, tenantId, ownerId);
    if (!record) {
      throw new NagexError({ code: 'KAKAO_ACCESSIBILITY_DRAFT_NOT_FOUND', category: 'NOT_FOUND', message: 'Kakao accessibility draft was not found for this tenant/user.', request_id: requestId });
    }
    if (record.status !== 'APPROVED') {
      throw new NagexError({ code: 'KAKAO_ACCESSIBILITY_DRAFT_NOT_APPROVED', category: 'POLICY', message: `Draft ${draftId} is ${record.status}, not APPROVED.`, request_id: requestId });
    }
    return record;
  }

  public markApprovalRequired(draftId: string, tenantId: string, ownerId: string, approvalId: string, requestId: string): KakaoAccessibilityDraftRecord {
    const record = this.requireApprovalEligible(draftId, tenantId, ownerId, requestId);
    return this.save({ ...record, status: 'APPROVAL_REQUIRED', approvalId });
  }

  public markApproved(draftId: string, tenantId: string, ownerId: string, approvalId: string, requestId: string): KakaoAccessibilityDraftRecord {
    const record = this.getOwned(draftId, tenantId, ownerId);
    if (!record || record.approvalId !== approvalId) {
      throw new NagexError({ code: 'KAKAO_ACCESSIBILITY_DRAFT_NOT_FOUND', category: 'NOT_FOUND', message: 'Kakao accessibility draft was not found for this approval.', request_id: requestId });
    }
    return this.save({ ...record, status: 'APPROVED' });
  }

  public supersede(draftId: string, tenantId: string, ownerId: string, requestId: string): KakaoAccessibilityDraftRecord {
    const record = this.getOwned(draftId, tenantId, ownerId);
    if (!record) {
      throw new NagexError({ code: 'KAKAO_ACCESSIBILITY_DRAFT_NOT_FOUND', category: 'NOT_FOUND', message: 'Kakao accessibility draft was not found for this tenant/user.', request_id: requestId });
    }
    if (record.status === 'APPROVED') {
      throw new NagexError({ code: 'KAKAO_ACCESSIBILITY_DRAFT_APPROVED_IMMUTABLE', category: 'POLICY', message: 'Approved Kakao accessibility drafts cannot be modified in place.', request_id: requestId });
    }
    return this.save({ ...record, status: 'SUPERSEDED' });
  }

  private save(record: KakaoAccessibilityDraftRecord): KakaoAccessibilityDraftRecord {
    const updated = { ...record, updatedAt: this.now() };
    this.records.set(updated.draftId, updated);
    this.fileStore.writeOrThrow(updated.draftId, updated);
    return updated;
  }

  private validateCreate(input: CreateKakaoAccessibilityDraftInput): void {
    if (input.provider !== 'KAKAOTALK' || input.route !== 'ANDROID_ACCESSIBILITY') {
      throw new NagexError({ code: 'KAKAO_ACCESSIBILITY_PROVIDER_ROUTE_REQUIRED', category: 'VALIDATION', message: 'Kakao accessibility drafts require provider=KAKAOTALK and route=ANDROID_ACCESSIBILITY.', request_id: input.requestId });
    }
    const device = this.deps.deviceIdentityStore.getOwned(input.deviceId, input.tenantId, input.ownerId);
    if (!device || device.status !== 'ACTIVE') {
      throw new NagexError({ code: 'KAKAO_ACCESSIBILITY_DRAFT_DEVICE_INVALID', category: 'NOT_FOUND', message: 'Device was not found or is not active for this tenant/user.', request_id: input.requestId });
    }
    const recipient = this.deps.recipientRefStore.getOwned(input.recipientRef, input.tenantId, input.ownerId, input.deviceId);
    if (!recipient) {
      throw new NagexError({ code: 'KAKAO_ACCESSIBILITY_DRAFT_RECIPIENT_INVALID', category: 'NOT_FOUND', message: 'recipientRef was not found for this tenant/user/device.', request_id: input.requestId });
    }
    const conversation = this.deps.conversationTargetStore.getOwned(input.conversationRef, input.tenantId, input.ownerId, input.deviceId);
    if (!conversation) {
      throw new NagexError({ code: 'KAKAO_ACCESSIBILITY_DRAFT_CONVERSATION_INVALID', category: 'NOT_FOUND', message: 'conversationRef was not found for this tenant/user/device.', request_id: input.requestId });
    }
    if (conversation.targetType !== 'DIRECT') {
      throw new NagexError({ code: 'KAKAO_ACCESSIBILITY_DRAFT_CONVERSATION_NOT_DIRECT', category: 'POLICY', message: 'Kakao accessibility drafts require a DIRECT conversation target.', request_id: input.requestId });
    }
    if (conversation.recipientRef !== input.recipientRef) {
      throw new NagexError({ code: 'KAKAO_ACCESSIBILITY_DRAFT_RECIPIENT_MISMATCH', category: 'POLICY', message: 'Conversation recipientRef does not match the draft recipientRef.', request_id: input.requestId });
    }
    if (conversation.provider !== 'KAKAOTALK' || normalizeConversationIdentityText(conversation.providerDisplayName) !== normalizeConversationIdentityText(input.expectedProviderDisplayName)) {
      throw new NagexError({ code: 'KAKAO_ACCESSIBILITY_DRAFT_PROVIDER_IDENTITY_MISMATCH', category: 'POLICY', message: 'Conversation provider identity does not match this draft.', request_id: input.requestId });
    }
  }
}
