// Phase 05 — Gmail Module Extraction.
//
// The only public surface external consumers may depend on. GMAIL_SEARCH_TOOL_ID,
// GMAIL_READ_THREAD_TOOL_ID, GmailComposePayload, and GmailAttachmentMetadata have
// zero external consumers (grep-verified) and stay module-private.
export { GmailService } from './gmail.service.js';
export {
  GMAIL_SEND_EMAIL_TOOL_ID,
  GMAIL_REPLY_TOOL_ID,
  GMAIL_CREATE_DRAFT_TOOL_ID,
} from './gmail.service.js';

export type { NormalizedGmailExecutionResult } from './gmail.service.js';
