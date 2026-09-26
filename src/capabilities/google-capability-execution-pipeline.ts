// R10.2-B — GoogleCapabilityExecutionPipeline (DEBT-0001). The single
// canonical safety chokepoint every Google mutation (Calendar
// create/update/cancel/RSVP, Gmail send/reply/create_draft) now flows
// through, replacing the near-identical request/consume/execute/audit
// logic that used to be duplicated inside google-calendar.service.ts's
// executeWrite()/executeCreateEvent() and gmail.service.ts's
// executeCompose(). Composition, not inheritance (§5 of the R10.2-B
// directive): GoogleCalendarService and GmailService each own one instance
// of this pipeline as a private field; they never extend a shared base
// class, and their business-specific payload shapes/validators/provider
// calls/post-success memory behavior stay entirely in the owning service.
//
// Ordering guarantee (§6): payload validation -> audit(started) ->
// token resolution (fail closed, audited on failure) -> approval consume
// (hash-verified, one-time-use, audited on denial) -> execution record
// started -> real provider call -> execution record succeeded/failed +
// audit -> (only on success) an isolated, failure-tolerant post-success
// hook that can NEVER flip a real success back into a reported failure
// (§12 — this fixes a real pre-existing bug: previously, a memory-write
// failure AFTER a successful Google write was caught by the same try/catch
// as provider failures, which called executions.fail() over an
// already-succeeded execution record and re-threw as if the mutation
// itself had failed, even though Google had already processed it).
import { NagexError } from '../common/errors.js';
import { generateResourceId, getCurrentISOString } from '../common/utils.js';
import type { AuditLogger } from '../governance/audit.logger.js';
import type { ActionApprovalStore, ActionApprovalRecord } from '../governance/action-approval.store.js';
import type { ExecutionStore } from '../governance/execution.store.js';
import type { MutationCapabilityDefinition, MutationExecutionContext } from './mutation-registry.js';
import { GMAIL_SCOPES, GOOGLE_CALENDAR_SCOPES } from '../integrations/google/oauth.client.js';

type FetchFn = typeof fetch;

export interface GoogleOAuthConfigLike {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface GoogleOAuthTokenStoreLike {
  getValidAccessToken(tenantId: string, config: GoogleOAuthConfigLike, fetchFn: FetchFn, requestId: string): Promise<string | null>;
}

export interface GoogleCredentialAccessLike {
  withAccessToken<TResult>(
    input: {
      tenantId: string;
      principalId: string;
      requiredScopes: string[];
      purpose: string;
      requestId: string;
      capabilityId?: string;
    },
    use: (accessToken: string) => Promise<TResult>,
  ): Promise<TResult | null>;
}

export interface GoogleCapabilityExecutionPipelineDeps {
  tokenStore: GoogleOAuthTokenStoreLike;
  credentialAccess: GoogleCredentialAccessLike;
  approvals: ActionApprovalStore;
  audit: AuditLogger;
  executions: ExecutionStore;
  getConfig: (env?: NodeJS.ProcessEnv) => GoogleOAuthConfigLike | null;
  fetchFn: FetchFn;
}

export interface NormalizedMutationResult {
  executionId: string;
  toolId: string;
  status: 'SUCCEEDED';
  externalId: string;
  externalUrl: string;
  startedAt: string;
  completedAt: string;
}

export interface ExecuteMutationInput<TPayload, TProviderResult extends { externalId: string; externalUrl: string }> {
  definition: MutationCapabilityDefinition<TPayload>;
  context: MutationExecutionContext<unknown>;
  // The one and only place a real external call happens — the pipeline
  // never understands Gmail/Calendar business payloads itself (§9).
  executeProvider: (accessToken: string, payload: TPayload, requestId: string) => Promise<TProviderResult>;
  // Runs ONLY after a real, already-recorded-successful execution. Any
  // throw here is caught, logged, and never rethrown or allowed to alter
  // the (already truthful) SUCCEEDED result returned to the caller (§12).
  afterSuccess?: (payload: TPayload, result: TProviderResult, context: MutationExecutionContext<TPayload>) => void;
}

export class GoogleCapabilityExecutionPipeline {
  constructor(private readonly deps: GoogleCapabilityExecutionPipelineDeps) {}

  // ── shared approval lifecycle (§8) ──────────────────────────────────────

  public requestApproval(
    definition: MutationCapabilityDefinition,
    tenantId: string,
    principalId: string,
    payload: Record<string, unknown>,
    requestId: string,
    auditDetails: Record<string, unknown>,
  ): ActionApprovalRecord {
    const record = this.deps.approvals.request({ toolId: definition.toolId, tenantId, principalId, payload });
    this.deps.audit.logEvent({
      actor: { type: 'user', id: principalId },
      tenant_id: tenantId,
      action: 'approval.requested',
      resource: { type: 'ActionApproval', id: record.approvalId },
      result: 'PENDING_APPROVAL',
      request_id: requestId,
      details: { toolId: definition.toolId, ...auditDetails },
    });
    return record;
  }

  public getApproval(approvalId: string, tenantId: string, principalId: string): ActionApprovalRecord | undefined {
    return this.deps.approvals.get(approvalId, tenantId, principalId);
  }

  public approve(approvalId: string, tenantId: string, principalId: string, requestId: string): ActionApprovalRecord {
    const record = this.deps.approvals.approve(approvalId, tenantId, principalId, requestId);
    this.deps.audit.logEvent({
      actor: { type: 'user', id: principalId },
      tenant_id: record.tenantId,
      action: 'approval.approved',
      resource: { type: 'ActionApproval', id: approvalId },
      result: 'SUCCESS',
      request_id: requestId,
    });
    return record;
  }

  public reject(approvalId: string, tenantId: string, principalId: string, requestId: string): ActionApprovalRecord {
    const record = this.deps.approvals.reject(approvalId, tenantId, principalId, requestId);
    this.deps.audit.logEvent({
      actor: { type: 'user', id: principalId },
      tenant_id: record.tenantId,
      action: 'approval.rejected',
      resource: { type: 'ActionApproval', id: approvalId },
      result: 'DENIED',
      request_id: requestId,
    });
    return record;
  }

  // ── R23.4V inject-only Google credential boundary ─────────────────────
  public async withAccessToken<TResult>(
    input: {
      tenantId: string;
      principalId: string;
      requestId: string;
      capabilityId: string;
      service: 'GMAIL' | 'CALENDAR';
      purpose: string;
      disconnectedErrorCode: string;
      disconnectedMessage: string;
    },
    use: (accessToken: string) => Promise<TResult>,
  ): Promise<TResult> {
    const requiredScopes = input.service === 'GMAIL' ? [...GMAIL_SCOPES] : [...GOOGLE_CALENDAR_SCOPES];
    let result: TResult | null;
    try {
      result = await this.deps.credentialAccess.withAccessToken({
        tenantId: input.tenantId,
        principalId: input.principalId,
        requiredScopes,
        purpose: input.purpose,
        requestId: input.requestId,
        capabilityId: input.capabilityId,
      }, use);
    } catch (error) {
      if (error instanceof NagexError && error.code.startsWith('CREDENTIAL_')) {
        throw new NagexError({
          code: input.disconnectedErrorCode,
          category: 'POLICY',
          message: input.disconnectedMessage,
          request_id: input.requestId,
        });
      }
      throw error;
    }

    if (result === null) {
      throw new NagexError({
        code: input.disconnectedErrorCode,
        category: 'POLICY',
        message: input.disconnectedMessage,
        request_id: input.requestId,
      });
    }
    return result;
  }

  // ── the canonical mutation execution chokepoint (§6) ────────────────────
  public async execute<TPayload, TProviderResult extends { externalId: string; externalUrl: string }>(
    input: ExecuteMutationInput<TPayload, TProviderResult>,
  ): Promise<NormalizedMutationResult> {
    const { definition, context, executeProvider, afterSuccess } = input;

    // Missing identity/context must DENY (§7) — TypeScript already
    // requires these fields, but a runtime guard protects against a
    // caller passing an empty string past the type system (e.g. a bug
    // upstream that stringifies `undefined`).
    if (!context.tenantId || !context.principalId || !context.approvalId) {
      throw new NagexError({
        code: 'MUTATION_CONTEXT_INCOMPLETE',
        category: 'VALIDATION',
        message: 'tenantId, principalId, and approvalId are all required to execute a Google mutation.',
        request_id: context.requestId,
      });
    }

    const payload = definition.validatePayload(context.payload, context.requestId) as TPayload;
    const startedAt = getCurrentISOString();
    const executionId = generateResourceId('exe');

    this.deps.audit.logEvent({
      actor: { type: 'user', id: context.principalId },
      tenant_id: context.tenantId,
      action: 'tool.execution.started',
      resource: { type: 'ToolExecution', id: executionId },
      result: 'PENDING_APPROVAL',
      request_id: context.requestId,
      details: { toolId: definition.toolId, approvalId: context.approvalId },
    });

    let result: TProviderResult;
    try {
      result = await this.withAccessToken({
        tenantId: context.tenantId,
        principalId: context.principalId,
        requestId: context.requestId,
        capabilityId: definition.toolId,
        service: definition.service,
        purpose: `execute:${definition.toolId}`,
        disconnectedErrorCode: definition.disconnectedErrorCode,
        disconnectedMessage: definition.disconnectedMessage,
      }, async (accessToken) => {
        // The secret exists only inside this privileged callback. Approval
        // consumption stays immediately before the provider mutation, with no
        // await between consume and provider invocation.
        try {
          this.deps.approvals.consume(context.approvalId, context.tenantId, context.principalId, definition.toolId, payload as unknown as Record<string, unknown>, context.requestId, executionId);
        } catch (error) {
          const code = error instanceof NagexError ? error.code : 'APPROVAL_VALIDATION_FAILED';
          this.deps.audit.logEvent({
            actor: { type: 'user', id: context.principalId },
            tenant_id: context.tenantId,
            action: 'tool.execution.failed',
            resource: { type: 'ToolExecution', id: executionId },
            result: 'DENIED',
            reason_code: code,
            request_id: context.requestId,
            details: { toolId: definition.toolId, approvalId: context.approvalId },
          });
          throw error;
        }

        this.deps.executions.start({ executionId, toolId: definition.toolId, approvalId: context.approvalId, tenantId: context.tenantId, principalId: context.principalId, startedAt });

        try {
          return await executeProvider(accessToken, payload, context.requestId);
        } catch (error) {
          const code = error instanceof NagexError ? error.code : `${definition.service}_EXECUTION_FAILED`;
          const completedAt = getCurrentISOString();
          this.deps.executions.fail(executionId, { errorCode: code, completedAt });
          this.deps.audit.logEvent({
            actor: { type: 'user', id: context.principalId },
            tenant_id: context.tenantId,
            action: 'tool.execution.failed',
            resource: { type: 'ToolExecution', id: executionId },
            result: 'FAILED',
            reason_code: code,
            request_id: context.requestId,
            details: { toolId: definition.toolId },
          });
          throw error;
        }
      });
    } catch (error) {
      // Credential-resolution failures occur before approval consumption.
      if (this.deps.approvals.get(context.approvalId, context.tenantId, context.principalId)?.status !== 'CONSUMED') {
        const code = error instanceof NagexError ? error.code : definition.disconnectedErrorCode;
        this.deps.audit.logEvent({
          actor: { type: 'user', id: context.principalId },
          tenant_id: context.tenantId,
          action: 'tool.execution.failed',
          resource: { type: 'ToolExecution', id: executionId },
          result: 'FAILED',
          reason_code: code,
          request_id: context.requestId,
          details: { toolId: definition.toolId },
        });
      }
      throw error;
    }

    // From this point on the external mutation genuinely succeeded and is
    // durably recorded as such — nothing below this line may ever cause
    // the caller to be told it failed.
    const completedAt = getCurrentISOString();
    this.deps.executions.succeed(executionId, { externalId: result.externalId, externalUrl: result.externalUrl, completedAt });
    this.deps.audit.logEvent({
      actor: { type: 'user', id: context.principalId },
      tenant_id: context.tenantId,
      action: 'tool.execution.succeeded',
      resource: { type: 'ToolExecution', id: executionId },
      result: 'SUCCESS',
      request_id: context.requestId,
      details: { toolId: definition.toolId, [definition.successExternalIdAuditKey ?? 'externalId']: result.externalId },
    });

    if (afterSuccess) {
      try {
        afterSuccess(payload, result, { ...context, payload });
      } catch (hookError) {
        // §12 — an optional post-success hook (e.g. memory activation)
        // failing must never be reported as the mutation having failed.
        // Logged, not silently swallowed, and never rethrown.
        console.error(JSON.stringify({
          event: 'nagex_mutation_after_success_hook_failed',
          toolId: definition.toolId,
          executionId,
          tenantId: context.tenantId,
          error: hookError instanceof Error ? hookError.message : String(hookError),
        }));
      }
    }

    return { executionId, toolId: definition.toolId, status: 'SUCCEEDED', externalId: result.externalId, externalUrl: result.externalUrl, startedAt, completedAt };
  }
}
