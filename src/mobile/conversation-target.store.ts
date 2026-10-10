import crypto from 'node:crypto';
import { NagexError } from '../common/errors.js';
import { generateResourceId, getCurrentISOString } from '../common/utils.js';
import { FileRecordStore, resolveNagexDataDir } from '../governance/file-record.store.js';
import {
  isConversationTargetRecord,
  type ConversationProvider,
  type ConversationTargetRecord,
  type ConversationTargetType,
} from './conversation-target.types.js';

export interface ConversationTargetStoreOptions {
  dir?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => string;
}

export interface MintConversationTargetInput {
  tenantId: string;
  ownerId: string;
  deviceId: string;
  provider: ConversationProvider;
  targetType: ConversationTargetType;
  recipientRef?: string;
  providerDisplayName: string;
  conversationTitle: string;
  participantHints: string[];
  conversationRef?: never;
}

export class ConversationTargetStore {
  private readonly records = new Map<string, ConversationTargetRecord>();
  private readonly fileStore: FileRecordStore<ConversationTargetRecord>;
  private readonly now: () => string;

  constructor(options: ConversationTargetStoreOptions = {}) {
    const env = options.env ?? process.env;
    const dir = options.dir ?? resolveNagexDataDir('mobile-conversation-targets', 'NAGEX_MOBILE_CONVERSATION_TARGETS_DIR', env);
    this.fileStore = new FileRecordStore<ConversationTargetRecord>(dir, isConversationTargetRecord);
    this.now = options.now ?? getCurrentISOString;
    for (const record of this.fileStore.readAll()) {
      this.records.set(record.conversationRef, record);
    }
  }

  public mintOrReuse(input: MintConversationTargetInput): ConversationTargetRecord {
    this.validateInput(input);
    const identityFingerprint = buildConversationIdentityFingerprint(input);
    for (const existing of this.records.values()) {
      if (
        existing.tenantId === input.tenantId
        && existing.ownerId === input.ownerId
        && existing.deviceId === input.deviceId
        && existing.provider === input.provider
        && existing.targetType === input.targetType
        && existing.identityFingerprint === identityFingerprint
      ) {
        return existing;
      }
    }

    const timestamp = this.now();
    const record: ConversationTargetRecord = {
      conversationRef: generateResourceId('cvr'),
      provider: input.provider,
      targetType: input.targetType,
      ...(input.targetType === 'DIRECT' ? { recipientRef: input.recipientRef } : {}),
      providerDisplayName: input.providerDisplayName,
      conversationTitle: input.conversationTitle,
      participantHints: [...input.participantHints],
      deviceId: input.deviceId,
      tenantId: input.tenantId,
      ownerId: input.ownerId,
      identityFingerprint,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.records.set(record.conversationRef, record);
    this.fileStore.writeOrThrow(record.conversationRef, record);
    return record;
  }

  public getOwned(conversationRef: string, tenantId: string, ownerId: string, deviceId: string): ConversationTargetRecord | null {
    const record = this.records.get(conversationRef);
    if (!record) return null;
    if (record.tenantId !== tenantId || record.ownerId !== ownerId || record.deviceId !== deviceId) return null;
    return record;
  }

  public listForOwnerDevice(tenantId: string, ownerId: string, deviceId: string): ConversationTargetRecord[] {
    return [...this.records.values()].filter((record) => (
      record.tenantId === tenantId &&
      record.ownerId === ownerId &&
      record.deviceId === deviceId
    ));
  }

  public requireExecutable(record: ConversationTargetRecord, requestId: string): ConversationTargetRecord {
    if (record.targetType === 'UNKNOWN') {
      throw new NagexError({ code: 'CONVERSATION_TARGET_NOT_EXECUTABLE', category: 'POLICY', message: 'UNKNOWN conversation targets are not executable.', request_id: requestId });
    }
    return record;
  }

  public verifyPostSelection(input: {
    conversationRef: string;
    tenantId: string;
    ownerId: string;
    deviceId: string;
    observedPackage: string;
    observed: Omit<MintConversationTargetInput, 'tenantId' | 'ownerId' | 'deviceId' | 'provider'> & { provider?: ConversationProvider };
    requestId: string;
  }): ConversationTargetRecord {
    if (input.observedPackage !== 'com.kakao.talk') {
      throw new NagexError({ code: 'CONVERSATION_PACKAGE_MISMATCH', category: 'POLICY', message: 'KakaoTalk conversation verification observed a different package.', request_id: input.requestId });
    }
    const record = this.getOwned(input.conversationRef, input.tenantId, input.ownerId, input.deviceId);
    if (!record) {
      throw new NagexError({ code: 'CONVERSATION_TARGET_NOT_FOUND', category: 'NOT_FOUND', message: 'Conversation target was not found for this tenant/user/device.', request_id: input.requestId });
    }
    this.requireExecutable(record, input.requestId);
    const observedFingerprint = buildConversationIdentityFingerprint({
      tenantId: input.tenantId,
      ownerId: input.ownerId,
      deviceId: input.deviceId,
      provider: input.observed.provider ?? record.provider,
      targetType: input.observed.targetType,
      recipientRef: input.observed.recipientRef,
      providerDisplayName: input.observed.providerDisplayName,
      conversationTitle: input.observed.conversationTitle,
      participantHints: input.observed.participantHints,
    });
    if (observedFingerprint !== record.identityFingerprint) {
      throw new NagexError({ code: 'CONVERSATION_TARGET_MISMATCH_REQUIRES_RERESOLUTION', category: 'POLICY', message: 'Observed KakaoTalk conversation no longer matches the bound conversation target.', request_id: input.requestId });
    }
    return record;
  }

  private validateInput(input: MintConversationTargetInput): void {
    if (input.provider !== 'KAKAOTALK') {
      throw new NagexError({ code: 'CONVERSATION_PROVIDER_UNSUPPORTED', category: 'VALIDATION', message: 'Only KakaoTalk conversation targets are supported.' });
    }
    if (input.targetType === 'DIRECT') {
      if (!input.recipientRef?.trim()) {
        throw new NagexError({ code: 'DIRECT_CONVERSATION_REQUIRES_RECIPIENT_REF', category: 'VALIDATION', message: 'DIRECT KakaoTalk targets require recipientRef.' });
      }
      return;
    }
    if (input.recipientRef !== undefined) {
      throw new NagexError({ code: 'NON_DIRECT_CONVERSATION_FORBIDS_RECIPIENT_REF', category: 'VALIDATION', message: 'GROUP, OPEN_CHAT, CHANNEL, and UNKNOWN targets must not inherit recipientRef.' });
    }
  }
}

export function buildConversationIdentityFingerprint(input: Omit<MintConversationTargetInput, 'conversationRef'>): string {
  const normalized = canonicalConversationIdentity(input);
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function canonicalConversationIdentity(input: Omit<MintConversationTargetInput, 'conversationRef'>): Record<string, unknown> {
  return {
    tenantId: input.tenantId,
    ownerId: input.ownerId,
    deviceId: input.deviceId,
    provider: input.provider,
    targetType: input.targetType,
    ...(input.targetType === 'DIRECT' ? { recipientRef: input.recipientRef } : {}),
    providerDisplayName: normalizeConversationIdentityText(input.providerDisplayName),
    conversationTitle: normalizeConversationIdentityText(input.conversationTitle),
    participantHints: input.participantHints.map(normalizeConversationIdentityText).filter(Boolean).sort(),
  };
}

export function normalizeConversationIdentityText(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}
