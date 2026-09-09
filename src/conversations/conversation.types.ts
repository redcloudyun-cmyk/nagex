export type ConversationRole =
  | 'USER'
  | 'ASSISTANT'
  | 'SYSTEM'
  | 'TOOL';

export type ConversationMessageStatus =
  | 'COMMITTED'
  | 'FAILED'
  | 'REDACTED'
  | 'DELETED';

export type ConversationSource =
  | 'WEB'
  | 'QUICK_WAKE'
  | 'TELEGRAM'
  | 'SLACK'
  | 'SYSTEM'
  | 'TOOL';

export interface ConversationMessageRecord {
  messageId: string;

  tenantId: string;
  principalId: string;
  sessionId: string;

  role: ConversationRole;
  status: ConversationMessageStatus;

  content: string;

  source: ConversationSource;

  requestId?: string;
  parentMessageId?: string;

  createdAt: string;
  updatedAt: string;
}

const VALID_ROLES = new Set<string>(['USER', 'ASSISTANT', 'SYSTEM', 'TOOL']);
const VALID_STATUSES = new Set<string>(['COMMITTED', 'FAILED', 'REDACTED', 'DELETED']);
const VALID_SOURCES = new Set<string>(['WEB', 'QUICK_WAKE', 'TELEGRAM', 'SLACK', 'SYSTEM', 'TOOL']);

export function isConversationMessageRecord(value: unknown): value is ConversationMessageRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.messageId === 'string' &&
    typeof v.tenantId === 'string' &&
    typeof v.principalId === 'string' &&
    typeof v.sessionId === 'string' &&
    typeof v.role === 'string' &&
    VALID_ROLES.has(v.role) &&
    typeof v.status === 'string' &&
    VALID_STATUSES.has(v.status) &&
    typeof v.content === 'string' &&
    typeof v.source === 'string' &&
    VALID_SOURCES.has(v.source) &&
    typeof v.createdAt === 'string' &&
    typeof v.updatedAt === 'string' &&
    (v.requestId === undefined || typeof v.requestId === 'string') &&
    (v.parentMessageId === undefined || typeof v.parentMessageId === 'string')
  );
}
