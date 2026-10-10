import crypto from 'node:crypto';

export type KakaoAccessibilityDraftStatus =
  | 'DRAFT'
  | 'APPROVAL_REQUIRED'
  | 'APPROVED'
  | 'SUPERSEDED'
  | 'CANCELLED';

export interface KakaoAccessibilityDraftRecord {
  draftId: string;
  tenantId: string;
  ownerId: string;
  deviceId: string;
  recipientRef: string;
  conversationRef: string;
  provider: 'KAKAOTALK';
  route: 'ANDROID_ACCESSIBILITY';
  expectedProviderDisplayName: string;
  message: string;
  messageHash: string;
  status: KakaoAccessibilityDraftStatus;
  approvalId: string | null;
  createdAt: string;
  updatedAt: string;
}

export function buildKakaoAccessibilityMessageHash(message: string): string {
  return `sha256:${crypto.createHash('sha256').update(message, 'utf8').digest('hex')}`;
}

export function isKakaoAccessibilityDraftRecord(value: unknown): value is KakaoAccessibilityDraftRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.draftId === 'string'
    && v.draftId.startsWith('kdr_')
    && typeof v.tenantId === 'string'
    && typeof v.ownerId === 'string'
    && typeof v.deviceId === 'string'
    && typeof v.recipientRef === 'string'
    && typeof v.conversationRef === 'string'
    && v.provider === 'KAKAOTALK'
    && v.route === 'ANDROID_ACCESSIBILITY'
    && typeof v.expectedProviderDisplayName === 'string'
    && typeof v.message === 'string'
    && typeof v.messageHash === 'string'
    && (v.status === 'DRAFT' || v.status === 'APPROVAL_REQUIRED' || v.status === 'APPROVED' || v.status === 'SUPERSEDED' || v.status === 'CANCELLED')
    && (v.approvalId === null || typeof v.approvalId === 'string')
    && typeof v.createdAt === 'string'
    && typeof v.updatedAt === 'string';
}
