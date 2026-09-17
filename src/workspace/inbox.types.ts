// R18 — Inbox Domain Types
export type InboxSourceType =
  | 'MANUAL_CAPTURE'
  | 'EMAIL'
  | 'UPLOADED_FILE'
  | 'WEB_LINK'
  | 'AGENT_SUGGESTION'
  | 'CALENDAR_ITEM'
  | 'CONNECTED_APP_EVENT';

export type InboxItemStatus = 'NEW' | 'REVIEWED' | 'ACTIONED' | 'ARCHIVED';
export type InboxItemPriority = 'HIGH' | 'MEDIUM' | 'LOW';

export interface InboxItem {
  inboxItemId: string;
  userId: string;
  tenantId: string;
  workspaceId: string;
  sourceType: InboxSourceType;
  sourceRef?: string;
  title: string;
  summary: string;
  contentRef?: string;
  status: InboxItemStatus;
  priority: InboxItemPriority;
  createdAt: string;
  updatedAt: string;
  processedAt?: string;
}

export interface CreateInboxItemParams {
  tenantId: string;
  userId: string;
  workspaceId?: string;
  sourceType: InboxSourceType;
  sourceRef?: string;
  title: string;
  summary?: string;
  contentRef?: string;
  priority?: InboxItemPriority;
}
