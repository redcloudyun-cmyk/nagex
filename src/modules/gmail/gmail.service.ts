import { NagexError } from '../../common/errors.js';
import { AuditLogger } from '../../governance/audit.logger.js';
import { ActionApprovalStore, type ActionApprovalRecord } from '../../governance/action-approval.store.js';
import { ExecutionStore } from '../../governance/execution.store.js';
import { MemoryEngine } from '../../context/memory.engine.js';
import {
  sendGmailMessage,
  createGmailDraft,
  searchGmailThreads,
  getGmailThread,
  type GmailComposePayload,
  type GmailAttachmentMetadata,
} from './gmail.client.js';
import { readGoogleOAuthConfig, type GoogleOAuthConfig } from '../../integrations/google/oauth.client.js';
import type { GoogleOAuthTokenStore } from '../../integrations/google/token.store.js';
import { GoogleCapabilityExecutionPipeline, type NormalizedMutationResult } from '../../capabilities/google-capability-execution-pipeline.js';
import type { MutationCapabilityDefinition } from '../../capabilities/mutation-registry.js';

// Gmail as the second real external service, reusing the exact same
// generic, hash-verified, replay-protected approval system already proven
// with Google Calendar (ActionApprovalStore + ExecutionStore, shared
// singletons from server_web.ts — no separate approval architecture), and
// (R10.2-B) the same GoogleCapabilityExecutionPipeline chokepoint.
export const GMAIL_SEND_EMAIL_TOOL_ID = 'gmail.send_email';
export const GMAIL_REPLY_TOOL_ID = 'gmail.reply';
export const GMAIL_CREATE_DRAFT_TOOL_ID = 'gmail.create_draft';
export const GMAIL_SEARCH_TOOL_ID = 'gmail.search';
export const GMAIL_READ_THREAD_TOOL_ID = 'gmail.read_thread';

export type { NormalizedMutationResult as NormalizedGmailExecutionResult };

type FetchFn = typeof fetch;
const GMAIL_DISCONNECTED_MESSAGE = 'Gmail is not connected. Connect it before this action can execute.';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmailList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string' && EMAIL_PATTERN.test(v));
}

function isValidAttachmentList(value: unknown): value is GmailAttachmentMetadata[] {
  if (!Array.isArray(value)) return false;
  return value.every(
    (a) =>
      a && typeof a === 'object' &&
      typeof (a as Record<string, unknown>).filename === 'string' &&
      typeof (a as Record<string, unknown>).mimeType === 'string' &&
      typeof (a as Record<string, unknown>).sizeBytes === 'number',
  );
}

// Structural + semantic validation. approvalId/OAuth/payload-hash gating
// happens inside the shared GoogleCapabilityExecutionPipeline, which is
// where "fail closed" for tampering matters (mirrors
// google-calendar.service.ts's assertValidPayload — capability-specific
// validation stays capability-specific, R10.2-B §8).
function assertValidGmailPayload(payload: unknown, requestId: string): asserts payload is GmailComposePayload {
  const p = payload as Partial<GmailComposePayload> | null;
  const structurallyValid = Boolean(
    p &&
    typeof p.from === 'string' && p.from &&
    isValidEmailList(p.to) && (p.to as string[]).length > 0 &&
    (p.cc === undefined || isValidEmailList(p.cc)) &&
    (p.bcc === undefined || isValidEmailList(p.bcc)) &&
    typeof p.subject === 'string' &&
    typeof p.body === 'string' && p.body.trim() &&
    (p.attachments === undefined || isValidAttachmentList(p.attachments)) &&
    (p.threadId === undefined || p.threadId === null || typeof p.threadId === 'string') &&
    (p.replyToMessageId === undefined || p.replyToMessageId === null || typeof p.replyToMessageId === 'string'),
  );
  if (!structurallyValid) {
    throw new NagexError({
      code: 'INVALID_GMAIL_PAYLOAD',
      category: 'VALIDATION',
      message: 'A Gmail approval payload must include from, at least one valid "to" recipient, valid cc/bcc if present, subject, and a non-empty body.',
      request_id: requestId,
    });
  }
}

function normalizePayload(payload: GmailComposePayload): GmailComposePayload {
  return {
    from: payload.from,
    to: payload.to,
    cc: payload.cc ?? [],
    bcc: payload.bcc ?? [],
    subject: payload.subject,
    body: payload.body,
    attachments: payload.attachments ?? [],
    threadId: payload.threadId ?? null,
    replyToMessageId: payload.replyToMessageId ?? null,
  };
}

function validateAndNormalize(payload: unknown, requestId: string): GmailComposePayload {
  assertValidGmailPayload(payload, requestId);
  return normalizePayload(payload);
}

// R10.2-B (DEBT-0001) — canonical, exported Gmail mutation-capability
// definitions, assembled alongside Calendar's into one registry by
// src/capabilities/google-mutation-registry.ts.
export const GMAIL_MUTATION_DEFINITIONS: MutationCapabilityDefinition[] = [GMAIL_SEND_EMAIL_TOOL_ID, GMAIL_REPLY_TOOL_ID, GMAIL_CREATE_DRAFT_TOOL_ID].map((toolId) => ({
  toolId, provider: 'GOOGLE' as const, service: 'GMAIL' as const, mutation: true as const, approvalRequired: true as const,
  failureMode: 'FAIL_CLOSED' as const, timeoutBehavior: 'ABORT' as const, unknownStateBehavior: 'DENY' as const,
  disconnectedErrorCode: 'GMAIL_DISCONNECTED', disconnectedMessage: GMAIL_DISCONNECTED_MESSAGE,
  validatePayload: (payload: unknown, requestId: string) => validateAndNormalize(payload, requestId),
}));

const GMAIL_MUTATION_BY_TOOL_ID = new Map(GMAIL_MUTATION_DEFINITIONS.map((d) => [d.toolId, d]));

export class GmailService {
  private readonly pipeline: GoogleCapabilityExecutionPipeline;

  constructor(
    private readonly tokenStore: GoogleOAuthTokenStore,
    private readonly approvals: ActionApprovalStore,
    private readonly audit: AuditLogger,
    private readonly memory: MemoryEngine,
    private readonly fetchFn: FetchFn = fetch,
    private readonly getConfig: (env?: NodeJS.ProcessEnv) => GoogleOAuthConfig | null = readGoogleOAuthConfig,
    private readonly executions: ExecutionStore = new ExecutionStore(),
  ) {
    this.pipeline = new GoogleCapabilityExecutionPipeline({
      tokenStore: this.tokenStore, approvals: this.approvals, audit: this.audit,
      executions: this.executions, getConfig: this.getConfig, fetchFn: this.fetchFn,
    });
  }

  // ── approval requests (one per write tool) ──────────────────────────────

  public requestApproval(input: { toolId: string; tenantId: string; principalId: string; payload: unknown; requestId: string }): ActionApprovalRecord {
    const definition = GMAIL_MUTATION_BY_TOOL_ID.get(input.toolId);
    if (!definition) {
      throw new NagexError({ code: 'UNSUPPORTED_APPROVAL_TOOL', category: 'VALIDATION', message: `Gmail has no approval-gated action for toolId "${input.toolId}".`, request_id: input.requestId });
    }
    const payload = definition.validatePayload(input.payload, input.requestId) as GmailComposePayload;
    if (input.toolId === GMAIL_REPLY_TOOL_ID && (!payload.threadId || !payload.replyToMessageId)) {
      throw new NagexError({ code: 'GMAIL_REPLY_REQUIRES_THREAD', category: 'VALIDATION', message: 'A reply must include both threadId and replyToMessageId.', request_id: input.requestId });
    }
    // Never log body/subject content — only enough to identify the action in audit.
    return this.pipeline.requestApproval(definition, input.tenantId, input.principalId, payload as unknown as Record<string, unknown>, input.requestId, { to: payload.to });
  }

  public getApproval(approvalId: string, tenantId: string, principalId: string): ActionApprovalRecord | undefined {
    return this.pipeline.getApproval(approvalId, tenantId, principalId);
  }

  public approve(approvalId: string, tenantId: string, principalId: string, requestId: string): ActionApprovalRecord {
    return this.pipeline.approve(approvalId, tenantId, principalId, requestId);
  }

  public reject(approvalId: string, tenantId: string, principalId: string, requestId: string): ActionApprovalRecord {
    return this.pipeline.reject(approvalId, tenantId, principalId, requestId);
  }

  // ── read-only (no approval) ─────────────────────────────────────────────

  public async search(input: { tenantId: string; query: string; requestId: string }): Promise<{ threads: Array<{ threadId: string; snippet: string; historyId: string | null }> }> {
    const accessToken = await this.pipeline.resolveAccessToken(input.tenantId, input.requestId, 'GMAIL_DISCONNECTED', 'Gmail is not connected. Connect Google Calendar/Gmail before this action can execute.');
    const threads = await searchGmailThreads(accessToken, input.query, this.fetchFn, input.requestId);
    return { threads };
  }

  public async readThread(input: { tenantId: string; threadId: string; requestId: string }) {
    const accessToken = await this.pipeline.resolveAccessToken(input.tenantId, input.requestId, 'GMAIL_DISCONNECTED', 'Gmail is not connected. Connect Google Calendar/Gmail before this action can execute.');
    return getGmailThread(accessToken, input.threadId, this.fetchFn, input.requestId);
  }

  // ── approval-gated execution ─────────────────────────────────────────────

  public async executeSendEmail(input: { approvalId: string; payload: unknown; tenantId: string; principalId: string; requestId: string }): Promise<NormalizedMutationResult> {
    return this.executeCompose(GMAIL_SEND_EMAIL_TOOL_ID, input, (accessToken, payload, requestId) => sendGmailMessage(accessToken, payload, this.fetchFn, requestId));
  }

  public async executeReply(input: { approvalId: string; payload: unknown; tenantId: string; principalId: string; requestId: string }): Promise<NormalizedMutationResult> {
    return this.executeCompose(GMAIL_REPLY_TOOL_ID, input, (accessToken, payload, requestId) => sendGmailMessage(accessToken, payload, this.fetchFn, requestId));
  }

  public async executeCreateDraft(input: { approvalId: string; payload: unknown; tenantId: string; principalId: string; requestId: string }): Promise<NormalizedMutationResult> {
    return this.executeCompose(GMAIL_CREATE_DRAFT_TOOL_ID, input, async (accessToken, payload, requestId) => {
      const draft = await createGmailDraft(accessToken, payload, this.fetchFn, requestId);
      return { externalId: draft.draftId, externalUrl: `https://mail.google.com/mail/u/0/#drafts?compose=${draft.draftId}`, threadId: draft.messageId };
    });
  }

  private async executeCompose(
    toolId: string,
    input: { approvalId: string; payload: unknown; tenantId: string; principalId: string; requestId: string },
    call: (accessToken: string, payload: GmailComposePayload, requestId: string) => Promise<{ externalId: string; externalUrl: string; threadId: string }>,
  ): Promise<NormalizedMutationResult> {
    return this.pipeline.execute({
      definition: GMAIL_MUTATION_BY_TOOL_ID.get(toolId)! as MutationCapabilityDefinition<GmailComposePayload>,
      context: { tenantId: input.tenantId, principalId: input.principalId, toolId, approvalId: input.approvalId, payload: input.payload, requestId: input.requestId },
      executeProvider: call,
      afterSuccess: (payload: GmailComposePayload) => {
        const recipients = payload.to.join(', ');
        const memoryRecord = this.memory.proposeMemory('USER', input.tenantId, input.principalId, {
          subject: 'Email',
          predicate: toolId === GMAIL_CREATE_DRAFT_TOOL_ID ? 'drafted' : 'sent',
          value: `${toolId === GMAIL_CREATE_DRAFT_TOOL_ID ? 'Drafted' : 'Sent'} "${payload.subject}" to ${recipients}.`,
        });
        this.memory.activateMemory(memoryRecord.id, input.tenantId, input.principalId);
      },
    });
  }
}
