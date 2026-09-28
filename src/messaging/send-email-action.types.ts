import type { ExecutionEnvironment } from './messaging-execution-contract.types.js';

export interface EmailAttachmentReference {
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

export interface EmailReplyContext {
  threadId: string;
  replyToMessageId: string;
}

/** Canonical email action. It is intentionally distinct from SEND_MESSAGE. */
export interface SendEmailAction {
  canonicalAction: 'SEND_EMAIL';
  tenantId: string;
  ownerId: string;
  requestId: string;
  providerAccountRef: string;
  displayIdentity?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  attachments?: EmailAttachmentReference[];
  replyContext?: EmailReplyContext;
}

export interface EmailApprovalBinding {
  canonicalAction: 'SEND_EMAIL';
  providerAccountRef: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  contentDigest: string;
  attachmentDigest: string;
  environment: Extract<ExecutionEnvironment, 'SERVER'>;
  provider: 'GOOGLE';
  executionRoute: 'GMAIL_API';
  threadId: string | null;
  replyToMessageId: string | null;
}
