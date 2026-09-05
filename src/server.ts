import type { TenantContext, PrincipalReference } from './common/types.js';
import { AgexError } from './common/errors.js';
import { PolicyDecisionPoint, describeDeniedDecision } from './identity/pdp.js';
import { DurableRuntimeEngine } from './runtime/runtime.engine.js';
import { AuditLogger } from './governance/audit.logger.js';
import { BillingLedgerEngine } from './billing/billing.ledger.js';

export interface AgexApiRequest {
  path: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers: Record<string, string>;
  body?: Record<string, unknown>;
}

export interface AgexApiResponse {
  status: number;
  body: Record<string, unknown>;
}

export class AgexPlatformApiServer {
  private pdp: PolicyDecisionPoint;
  private runtime: DurableRuntimeEngine;
  private auditLogger: AuditLogger;
  private billingEngine: BillingLedgerEngine;

  constructor(
    pdp: PolicyDecisionPoint,
    runtime: DurableRuntimeEngine,
    auditLogger: AuditLogger,
    billingEngine: BillingLedgerEngine
  ) {
    this.pdp = pdp;
    this.runtime = runtime;
    this.auditLogger = auditLogger;
    this.billingEngine = billingEngine;
  }

  public async handleRequest(req: AgexApiRequest): Promise<AgexApiResponse> {
    const requestId = req.headers['x-request-id'] || `req_${Date.now()}`;
    const tenantHeader = req.headers['x-agex-tenant'];

    try {
      // 1. Tenant Context Validation
      if (!tenantHeader && req.path !== '/api/v1/health') {
        throw new AgexError({
          code: 'TENANT_CONTEXT_MISSING',
          category: 'AUTHENTICATION',
          message: 'Header X-AGEX-Tenant is mandatory for tenant-scoped endpoints.',
          request_id: requestId,
        });
      }

      const tenantContext: TenantContext = {
        tenant_id: tenantHeader || 'platform_system',
        scope_type: 'TENANT',
      };

      const principal: PrincipalReference = {
        type: 'user',
        id: req.headers['x-principal-id'] || 'usr_anonymous',
      };

      // Router Endpoints
      if (req.path === '/api/v1/health' && req.method === 'GET') {
        return { status: 200, body: { status: 'UP', service: 'AGEX AI OS Platform API' } };
      }

      if (req.path === '/api/v1/executions' && req.method === 'POST') {
        const targetId = (req.body?.target_resource_id as string) || 'agt_default';

        // Evaluate PDP. resource_tenant_id is intentionally omitted: there is
        // no Agent resource registry yet to resolve the target's *actual*
        // owning tenant, and echoing the caller's own tenant_context here
        // would make the cross-tenant check vacuously pass. See the
        // resource_tenant_id doc comment on AuthorizationRequest.
        // TODO(spec-gap): wire up a real Agent registry lookup once one
        // exists so cross-tenant access to another tenant's Agent is denied.
        const decision = this.pdp.evaluate({
          principal,
          tenant_context: tenantContext,
          action: 'agent:execute',
          resource_type: 'Agent',
          resource_id: targetId,
          principal_permissions: ['agent:execute'],
        });

        if (decision.decision !== 'ALLOW') {
          const outcome = describeDeniedDecision(decision);
          this.auditLogger.logEvent({
            actor: principal,
            tenant_id: tenantContext.tenant_id,
            action: 'agent:execute',
            resource: { type: 'Agent', id: targetId },
            result: outcome.auditResult,
            reason_code: decision.reason_code,
            request_id: requestId,
          });

          const requiresApproval = decision.decision === 'CONDITIONAL';
          throw new AgexError({
            code: outcome.errorCode,
            category: requiresApproval ? 'POLICY' : 'AUTHORIZATION',
            message: `Execution ${requiresApproval ? 'requires approval' : 'denied'}: ${decision.reason_code}`,
            request_id: requestId,
          });
        }

        const execution = this.runtime.createExecution(tenantContext, targetId);

        // Audit Success Event
        this.auditLogger.logEvent({
          actor: principal,
          tenant_id: tenantContext.tenant_id,
          action: 'agent:execute',
          resource: { type: 'Execution', id: execution.id },
          result: 'SUCCESS',
          request_id: requestId,
        });

        return { status: 201, body: { data: execution as unknown as Record<string, unknown> } };
      }

      throw new AgexError({
        code: 'ENDPOINT_NOT_FOUND',
        category: 'NOT_FOUND',
        message: `Endpoint ${req.method} ${req.path} not found.`,
        request_id: requestId,
      });
    } catch (err: unknown) {
      if (err instanceof AgexError) {
        return { status: this.mapCategoryToHttpStatus(err.category), body: err.toJSON() };
      }

      const internalErr = new AgexError({
        code: 'INTERNAL_SERVER_ERROR',
        category: 'INTERNAL',
        message: err instanceof Error ? err.message : String(err),
        request_id: requestId,
      });
      return { status: 500, body: internalErr.toJSON() };
    }
  }

  private mapCategoryToHttpStatus(category: string): number {
    switch (category) {
      case 'AUTHENTICATION': return 401;
      case 'AUTHORIZATION': return 403;
      // POLICY is only ever used for the CONDITIONAL/APPROVAL_REQUIRED path
      // (see the /executions handler above) — collapsing it into the same
      // 403 as AUTHORIZATION made "denied" and "pending approval" look
      // identical to API callers.
      case 'POLICY': return 202;
      case 'NOT_FOUND': return 404;
      case 'CONFLICT': return 409;
      case 'VALIDATION': return 422;
      default: return 500;
    }
  }
}
