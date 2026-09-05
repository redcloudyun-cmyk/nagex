import type { PrincipalReference, TenantContext } from '../common/types.js';
import { PERMISSION_RISK } from './permission.registry.js';

export interface AuthorizationRequest {
  principal: PrincipalReference;
  tenant_context: TenantContext;
  action: string; // 예: agent:execute, plugin:install
  resource_type: string;
  resource_id: string;
  /**
   * The tenant that actually OWNS the target resource, resolved from an
   * authoritative resource registry — never the requester's own
   * tenant_context.tenant_id. Echoing the caller's tenant here makes the
   * cross-tenant check below vacuously true and silently defeats Rule 13
   * (Cross-Tenant access is Default Deny). Leave undefined only when
   * ownership is genuinely unresolvable (e.g. no registry wired up yet);
   * in that case the check below is skipped rather than enforced.
   */
  resource_tenant_id?: string | null;
  principal_permissions: string[];
  context?: Record<string, unknown>;
}

export type AuthorizationDecisionResult = 'ALLOW' | 'DENY' | 'CONDITIONAL';

export interface AuthorizationDecision {
  decision: AuthorizationDecisionResult;
  reason_code: string;
  policy_ids?: string[];
  obligations?: string[];
}

export class PolicyDecisionPoint {
  public evaluate(request: AuthorizationRequest): AuthorizationDecision {
    // 1. Cross-Tenant Check (Default Deny)
    if (
      request.resource_tenant_id &&
      request.resource_tenant_id !== request.tenant_context.tenant_id
    ) {
      return {
        decision: 'DENY',
        reason_code: 'CROSS_TENANT_ACCESS_DENIED',
      };
    }

    // 2. Permission Check
    const hasPermission =
      request.principal_permissions.includes(request.action) ||
      request.principal_permissions.includes('*');

    if (!hasPermission) {
      return {
        decision: 'DENY',
        reason_code: 'PERMISSION_MISSING',
      };
    }

    // 3. Risk / Obligation Check. CRITICAL-risk actions (per the canonical
    // permission registry — specs/permissions/*.yaml, mirrored in
    // permission.registry.ts) always require approval, on top of the two
    // historically hardcoded high-risk verb patterns.
    // NOTE: several actions are rated HIGH (not CRITICAL) in that registry,
    // e.g. agent:execute — the console's core "run task" flow depends on
    // agent:execute being immediately ALLOW-able, so HIGH-risk actions are
    // intentionally NOT auto-gated here. Whether HIGH-risk actions should
    // ever require approval is an open product question, not resolved by
    // this check — see CLAUDE.md's Specification Gap Behavior.
    if (
      request.action.endsWith(':delete') ||
      request.action === 'agent:publish' ||
      PERMISSION_RISK[request.action] === 'CRITICAL'
    ) {
      return {
        decision: 'CONDITIONAL',
        reason_code: 'REQUIRE_APPROVAL',
        obligations: ['APPROVAL_REQUIRED'],
      };
    }

    return {
      decision: 'ALLOW',
      reason_code: 'PERMITTED_BY_POLICY',
    };
  }
}

export interface DecisionOutcome {
  httpStatus: number;
  errorCode: 'PERMISSION_DENIED' | 'APPROVAL_REQUIRED';
  auditResult: 'DENIED' | 'PENDING_APPROVAL';
}

/**
 * Translates a non-ALLOW PDP decision into the HTTP status, public error
 * code, and audit-log result every call site (server.ts, server_web.ts,
 * agent.executor.ts) should use. Centralized so CONDITIONAL (which means
 * "pending approval", not "denied") can't silently drift back to being
 * treated identically to DENY at some call sites but not others.
 */
export function describeDeniedDecision(decision: AuthorizationDecision): DecisionOutcome {
  if (decision.decision === 'CONDITIONAL') {
    return { httpStatus: 202, errorCode: 'APPROVAL_REQUIRED', auditResult: 'PENDING_APPROVAL' };
  }
  return { httpStatus: 403, errorCode: 'PERMISSION_DENIED', auditResult: 'DENIED' };
}
