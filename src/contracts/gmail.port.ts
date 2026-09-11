// Phase 03 — Module Contracts.
//
// The only real consumer of Gmail outside server_web.ts's own route
// handlers (which keep using the concrete GmailService directly — see the
// Phase 03 pre-flight report) is CapabilityBroker, and only for read-only
// search/read plus requesting approval for a write. executeSendEmail/
// executeReply/executeCreateDraft stay direct concrete calls in
// server_web.ts, unchanged by this phase — no port is added for them
// per the directive's "do not add a port speculatively" instruction.
import type { ActionApprovalRecord } from '../governance/action-approval.store.js';

// Mirrors integrations/google/gmail.client.ts's shapes — inlined rather
// than imported: contracts never import from integrations/.
export interface GmailThreadSummary {
  threadId: string;
  snippet: string;
}

export interface GmailMessageSummary {
  id: string;
  snippet: string;
}

export interface GmailThreadDetail {
  threadId: string;
  messages: GmailMessageSummary[];
}

export interface GmailPort {
  search(input: { tenantId: string; query: string; requestId: string }): Promise<{ threads: GmailThreadSummary[] }>;
  readThread(input: { tenantId: string; threadId: string; requestId: string }): Promise<GmailThreadDetail>;
  requestApproval(input: { toolId: string; tenantId: string; principalId: string; payload: unknown; requestId: string }): ActionApprovalRecord;
}
