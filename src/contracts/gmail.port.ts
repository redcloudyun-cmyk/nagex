// Phase 03 — Module Contracts. Extended in P02a — Capability Broker
// Approved-Write Execution.
//
// CapabilityBroker was the only real consumer of Gmail outside
// server_web.ts's own route handlers, and originally only needed
// read-only search/read plus requesting approval for a write —
// executeSendEmail/executeReply/executeCreateDraft stayed direct concrete
// calls in server_web.ts, with no port added "speculatively" (Phase 03).
// P02a is the real, evidence-based need Phase 03 deferred: CapabilityBroker
// now also executes an already-approved write once a valid approvalId is
// supplied, via the new GmailWriteExecutionPort below (an intersection
// with GmailPort, never a merged interface).
import type { ActionApprovalRecord } from '../governance/action-approval.store.js';

// Mirrors modules/gmail/gmail.client.ts's shapes — inlined rather
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

// Mirrors modules/gmail/gmail.service.ts's NormalizedGmailExecutionResult —
// inlined rather than imported from the concrete service file, so this
// contract does not depend on the implementation it exists to abstract.
export interface GmailExecutionResult {
  executionId: string;
  toolId: string;
  status: 'SUCCEEDED';
  externalId: string;
  externalUrl: string;
  startedAt: string;
  completedAt: string;
}

export interface GmailWriteExecutionInput {
  approvalId: string;
  payload: unknown;
  tenantId: string;
  principalId: string;
  requestId: string;
}

// P02a — consumed by CapabilityBroker alongside GmailPort (as an
// intersection type) to execute an already-approved write once a valid
// approvalId is supplied. Each executeX method already internally
// validates and consumes the approval (tool binding, expiry, one-time-use,
// exact payload-hash match) via the same governed ActionApprovalStore path
// every other execute caller already goes through — this port only
// exposes that existing, already-frozen behavior to the Broker.
export interface GmailWriteExecutionPort {
  executeSendEmail(input: GmailWriteExecutionInput): Promise<GmailExecutionResult>;
  executeReply(input: GmailWriteExecutionInput): Promise<GmailExecutionResult>;
  executeCreateDraft(input: GmailWriteExecutionInput): Promise<GmailExecutionResult>;
}
