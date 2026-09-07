import { NagexError } from '../common/errors.js';
import { generateResourceId, getCurrentISOString } from '../common/utils.js';
import { AuditLogger } from '../governance/audit.logger.js';
import { ActionApprovalStore, type ActionApprovalRecord } from '../governance/action-approval.store.js';
import { ExecutionStore } from '../governance/execution.store.js';
import { MemoryEngine } from '../context/memory.engine.js';
import {
  sendGmailMessage,
  createGmailDraft,
  searchGmailThreads,
  getGmailThread,
  type GmailComposePayload,
  type GmailAttachmentMetadata,
} from '../integrations/google/gmail.client.js';
import { readGoogleOAuthConfig, type GoogleOAuthConfig } from '../integrations/google/oauth.client.js';
import type { GoogleOAuthTokenStore } from '../integrations/google/token.store.js';

// Gmail as the second real external service, reusing the exact same
// generic, hash-verified, replay-protected approval system already proven
// with Google Calendar (ActionApprovalStore + ExecutionStore, shared
// singletons from server_web.ts — no separate approval architecture).
export const GMAIL_SEND_EMAIL_TOOL_ID = 'gmail.send_email';
export const GMAIL_REPLY_TOOL_ID = 'gmail.reply';
export const GMAIL_CREATE_DRAFT_TOOL_ID = 'gmail.create_draft';
export const GMAIL_SEARCH_TOOL_ID = 'gmail.search';
export const GMAIL_READ_THREAD_TOOL_ID = 'gmail.read_thread';

const WRITE_TOOL_IDS = new Set([GMAIL_SEND_EMAIL_TOOL_ID, GMAIL_REPLY_TOOL_ID, GMAIL_CREATE_DRAFT_TOOL_ID]);

export interface NormalizedGmailExecutionResult {
  executionId: string;
  toolId: string;
  status: 'SUCCEEDED';
  externalId: string;
  externalUrl: string;
  startedAt: string;
  completedAt: string;
}

type FetchFn = typeof fetch;

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
// happens in requestApproval/executeX, which is where "fail closed" for
// tampering matters (mirrors google-calendar.service.ts's assertValidPayload).
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

export class GmailService {
  constructor(
    private readonly tokenStore: GoogleOAuthTokenStore,
    private readonly approvals: ActionApprovalStore,
    private readonly audit: AuditLogger,
    private readonly memory: MemoryEngine,
    private readonly fetchFn: FetchFn = fetch,
    private readonly getConfig: (env?: NodeJS.ProcessEnv) => GoogleOAuthConfig | null = readGoogleOAuthConfig,
    private readonly executions: ExecutionStore = new ExecutionStore(),
  ) {}

  // ── approval requests (one per write tool) ──────────────────────────────

  public requestApproval(input: { toolId: string; tenantId: string; principalId: string; payload: unknown; requestId: string }): ActionApprovalRecord {
    if (!WRITE_TOOL_IDS.has(input.toolId)) {
      throw new NagexError({ code: 'UNSUPPORTED_APPROVAL_TOOL', category: 'VALIDATION', message: `Gmail has no approval-gated action for toolId "${input.toolId}".`, request_id: input.requestId });
    }
    assertValidGmailPayload(input.payload, input.requestId);
    const payload = normalizePayload(input.payload);
    if (input.toolId === GMAIL_REPLY_TOOL_ID && (!payload.threadId || !payload.replyToMessageId)) {
      throw new NagexError({ code: 'GMAIL_REPLY_REQUIRES_THREAD', category: 'VALIDATION', message: 'A reply must include both threadId and replyToMessageId.', request_id: input.requestId });
    }

    const record = this.approvals.request({
      toolId: input.toolId,
      tenantId: input.tenantId,
      principalId: input.principalId,
      payload: payload as unknown as Record<string, unknown>,
    });
    this.audit.logEvent({
      actor: { type: 'user', id: input.principalId },
      tenant_id: input.tenantId,
      action: 'approval.requested',
      resource: { type: 'ActionApproval', id: record.approvalId },
      result: 'PENDING_APPROVAL',
      request_id: input.requestId,
      // Never log body/subject content — only enough to identify the action in audit.
      details: { toolId: input.toolId, to: payload.to },
    });
    return record;
  }

  public getApproval(approvalId: string): ActionApprovalRecord | undefined {
    return this.approvals.get(approvalId);
  }

  public approve(approvalId: string, principalId: string, requestId: string): ActionApprovalRecord {
    const record = this.approvals.approve(approvalId, requestId);
    this.audit.logEvent({
      actor: { type: 'user', id: principalId },
      tenant_id: record.tenantId,
      action: 'approval.approved',
      resource: { type: 'ActionApproval', id: approvalId },
      result: 'SUCCESS',
      request_id: requestId,
    });
    return record;
  }

  public reject(approvalId: string, principalId: string, requestId: string): ActionApprovalRecord {
    const record = this.approvals.reject(approvalId, requestId);
    this.audit.logEvent({
      actor: { type: 'user', id: principalId },
      tenant_id: record.tenantId,
      action: 'approval.rejected',
      resource: { type: 'ActionApproval', id: approvalId },
      result: 'DENIED',
      request_id: requestId,
    });
    return record;
  }

  // ── read-only (no approval) ─────────────────────────────────────────────

  public async search(input: { tenantId: string; query: string; requestId: string }): Promise<{ threads: Array<{ threadId: string; snippet: string }> }> {
    const accessToken = await this.requireAccessToken(input.tenantId, input.requestId, GMAIL_SEARCH_TOOL_ID);
    const threads = await searchGmailThreads(accessToken, input.query, this.fetchFn, input.requestId);
    return { threads };
  }

  public async readThread(input: { tenantId: string; threadId: string; requestId: string }) {
    const accessToken = await this.requireAccessToken(input.tenantId, input.requestId, GMAIL_READ_THREAD_TOOL_ID);
    return getGmailThread(accessToken, input.threadId, this.fetchFn, input.requestId);
  }

  // ── approval-gated execution ─────────────────────────────────────────────

  public async executeSendEmail(input: { approvalId: string; payload: unknown; tenantId: string; principalId: string; requestId: string }): Promise<NormalizedGmailExecutionResult> {
    return this.executeCompose(GMAIL_SEND_EMAIL_TOOL_ID, input, (accessToken, payload, requestId) => sendGmailMessage(accessToken, payload, this.fetchFn, requestId));
  }

  public async executeReply(input: { approvalId: string; payload: unknown; tenantId: string; principalId: string; requestId: string }): Promise<NormalizedGmailExecutionResult> {
    return this.executeCompose(GMAIL_REPLY_TOOL_ID, input, (accessToken, payload, requestId) => sendGmailMessage(accessToken, payload, this.fetchFn, requestId));
  }

  public async executeCreateDraft(input: { approvalId: string; payload: unknown; tenantId: string; principalId: string; requestId: string }): Promise<NormalizedGmailExecutionResult> {
    return this.executeCompose(GMAIL_CREATE_DRAFT_TOOL_ID, input, async (accessToken, payload, requestId) => {
      const draft = await createGmailDraft(accessToken, payload, this.fetchFn, requestId);
      return { externalId: draft.draftId, externalUrl: `https://mail.google.com/mail/u/0/#drafts?compose=${draft.draftId}`, threadId: draft.messageId };
    });
  }

  private async requireAccessToken(tenantId: string, requestId: string, toolId: string): Promise<string> {
    const config = this.getConfig();
    const accessToken = config ? await this.tokenStore.getValidAccessToken(tenantId, config, this.fetchFn, requestId) : null;
    if (!accessToken) {
      this.audit.logEvent({
        actor: { type: 'user', id: 'system' },
        tenant_id: tenantId,
        action: 'tool.execution.failed',
        resource: { type: 'ToolExecution', id: toolId },
        result: 'FAILED',
        reason_code: 'GMAIL_DISCONNECTED',
        request_id: requestId,
        details: { toolId },
      });
      throw new NagexError({ code: 'GMAIL_DISCONNECTED', category: 'POLICY', message: 'Gmail is not connected. Connect Google Calendar/Gmail before this action can execute.', request_id: requestId });
    }
    return accessToken;
  }

  private async executeCompose(
    toolId: string,
    input: { approvalId: string; payload: unknown; tenantId: string; principalId: string; requestId: string },
    call: (accessToken: string, payload: GmailComposePayload, requestId: string) => Promise<{ externalId: string; externalUrl: string; threadId: string }>,
  ): Promise<NormalizedGmailExecutionResult> {
    assertValidGmailPayload(input.payload, input.requestId);
    const payload = normalizePayload(input.payload);
    const startedAt = getCurrentISOString();
    const executionId = generateResourceId('exe');

    this.audit.logEvent({
      actor: { type: 'user', id: input.principalId },
      tenant_id: input.tenantId,
      action: 'tool.execution.started',
      resource: { type: 'ToolExecution', id: executionId },
      result: 'PENDING_APPROVAL',
      request_id: input.requestId,
      details: { toolId, approvalId: input.approvalId },
    });

    const accessToken = await this.requireAccessTokenOrThrowExecutionFailed(input.tenantId, input.requestId, executionId, toolId, input.principalId);

    // Consuming the approval (hash-checked, one-time-use) happens before the
    // real Gmail call, atomically with respect to this event loop — no await
    // between checking and marking it CONSUMED — so a replayed or concurrent
    // execute request can never send twice.
    try {
      this.approvals.consume(input.approvalId, toolId, payload as unknown as Record<string, unknown>, input.requestId, executionId);
    } catch (error) {
      const code = error instanceof NagexError ? error.code : 'APPROVAL_VALIDATION_FAILED';
      this.audit.logEvent({
        actor: { type: 'user', id: input.principalId },
        tenant_id: input.tenantId,
        action: 'tool.execution.failed',
        resource: { type: 'ToolExecution', id: executionId },
        result: 'DENIED',
        reason_code: code,
        request_id: input.requestId,
        details: { toolId, approvalId: input.approvalId },
      });
      throw error;
    }

    this.executions.start({ executionId, toolId, approvalId: input.approvalId, tenantId: input.tenantId, principalId: input.principalId, startedAt });

    try {
      const created = await call(accessToken, payload, input.requestId);
      const completedAt = getCurrentISOString();
      this.executions.succeed(executionId, { externalId: created.externalId, externalUrl: created.externalUrl, completedAt });

      this.audit.logEvent({
        actor: { type: 'user', id: input.principalId },
        tenant_id: input.tenantId,
        action: 'tool.execution.succeeded',
        resource: { type: 'ToolExecution', id: executionId },
        result: 'SUCCESS',
        request_id: input.requestId,
        details: { toolId, externalId: created.externalId },
      });

      const recipients = payload.to.join(', ');
      const memoryRecord = this.memory.proposeMemory('USER', input.principalId, {
        subject: 'Email',
        predicate: toolId === GMAIL_CREATE_DRAFT_TOOL_ID ? 'drafted' : 'sent',
        value: `${toolId === GMAIL_CREATE_DRAFT_TOOL_ID ? 'Drafted' : 'Sent'} "${payload.subject}" to ${recipients}.`,
      });
      this.memory.activateMemory(memoryRecord.id);

      return { executionId, toolId, status: 'SUCCEEDED', externalId: created.externalId, externalUrl: created.externalUrl, startedAt, completedAt };
    } catch (error) {
      const code = error instanceof NagexError ? error.code : 'GMAIL_EXECUTION_FAILED';
      const completedAt = getCurrentISOString();
      this.executions.fail(executionId, { errorCode: code, completedAt });
      this.audit.logEvent({
        actor: { type: 'user', id: input.principalId },
        tenant_id: input.tenantId,
        action: 'tool.execution.failed',
        resource: { type: 'ToolExecution', id: executionId },
        result: 'FAILED',
        reason_code: code,
        request_id: input.requestId,
        details: { toolId },
      });
      throw error;
    }
  }

  private async requireAccessTokenOrThrowExecutionFailed(tenantId: string, requestId: string, executionId: string, toolId: string, principalId: string): Promise<string> {
    const config = this.getConfig();
    const accessToken = config ? await this.tokenStore.getValidAccessToken(tenantId, config, this.fetchFn, requestId) : null;
    if (!accessToken) {
      this.audit.logEvent({
        actor: { type: 'user', id: principalId },
        tenant_id: tenantId,
        action: 'tool.execution.failed',
        resource: { type: 'ToolExecution', id: executionId },
        result: 'FAILED',
        reason_code: 'GMAIL_DISCONNECTED',
        request_id: requestId,
        details: { toolId },
      });
      throw new NagexError({ code: 'GMAIL_DISCONNECTED', category: 'POLICY', message: 'Gmail is not connected. Connect it before this action can execute.', request_id: requestId });
    }
    return accessToken;
  }
}
