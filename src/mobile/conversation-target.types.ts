export type ConversationTargetType = 'DIRECT' | 'GROUP' | 'OPEN_CHAT' | 'CHANNEL' | 'UNKNOWN';

export type ConversationProvider = 'KAKAOTALK';

export interface ConversationTargetRecord {
  conversationRef: string;
  provider: ConversationProvider;
  targetType: ConversationTargetType;
  recipientRef?: string;
  providerDisplayName: string;
  conversationTitle: string;
  participantHints: string[];
  deviceId: string;
  tenantId: string;
  ownerId: string;
  identityFingerprint: string;
  createdAt: string;
  updatedAt: string;
}

export function isExecutableConversationTarget(record: ConversationTargetRecord): boolean {
  return record.targetType !== 'UNKNOWN';
}

export function isConversationTargetRecord(value: unknown): value is ConversationTargetRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<ConversationTargetRecord>;
  return typeof v.conversationRef === 'string'
    && v.conversationRef.startsWith('cvr_')
    && v.provider === 'KAKAOTALK'
    && (v.targetType === 'DIRECT' || v.targetType === 'GROUP' || v.targetType === 'OPEN_CHAT' || v.targetType === 'CHANNEL' || v.targetType === 'UNKNOWN')
    && (v.recipientRef === undefined || typeof v.recipientRef === 'string')
    && typeof v.providerDisplayName === 'string'
    && typeof v.conversationTitle === 'string'
    && Array.isArray(v.participantHints)
    && v.participantHints.every((hint) => typeof hint === 'string')
    && typeof v.deviceId === 'string'
    && typeof v.tenantId === 'string'
    && typeof v.ownerId === 'string'
    && typeof v.identityFingerprint === 'string'
    && typeof v.createdAt === 'string'
    && typeof v.updatedAt === 'string';
}
