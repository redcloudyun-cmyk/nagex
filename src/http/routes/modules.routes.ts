// R10.2-D Increment 2 — Module (capability toggle) routes, extracted
// verbatim from server_web.ts's handleApiRequest. PUT .../state is a real
// authorization-sensitive route (PolicyDecisionPoint.evaluate(), fail-
// closed on any non-ALLOW decision, audited on denial) — this extraction
// changes nothing about that decision path, only its physical location.
import type { PolicyDecisionPoint } from '../../identity/pdp.js';
import { describeDeniedDecision } from '../../identity/pdp.js';
import { resolveBuiltInPrincipalPermissions } from '../../identity/permission.registry.js';
import type { ModuleService } from '../../modules/module.service.js';
import type { AuditLogger } from '../../governance/audit.logger.js';
import type { TenantContext, PrincipalReference } from '../../common/types.js';
import type { ApiResult, SyncRouteRegistrar } from '../http-types.js';

export interface ModulesRouteDeps {
  moduleService: ModuleService;
  pdp: PolicyDecisionPoint;
  auditLogger: AuditLogger;
  tenantId: string;
  tenantContext: TenantContext;
  principal: PrincipalReference;
  modelErrorResult: (error: unknown) => ApiResult;
}

export const handleModulesRoutes: SyncRouteRegistrar<ModulesRouteDeps> = (method, pathname, body, headers, _query, deps): ApiResult | undefined => {
  const { moduleService, pdp, auditLogger, tenantId, tenantContext, principal, modelErrorResult } = deps;

  if (pathname === '/api/v1/modules' && method === 'GET') {
    const modules = moduleService.listModules(tenantId);
    return { status: 200, data: { modules, total: modules.length } };
  }

  if (pathname.startsWith('/api/v1/modules/') && pathname.endsWith('/state') && method === 'PUT') {
    const moduleId = pathname.slice('/api/v1/modules/'.length, pathname.length - '/state'.length);
    const headerReqId = headers['x-request-id'] || headers['X-Request-Id'];
    const requestId = (Array.isArray(headerReqId) ? headerReqId[0] : headerReqId) || `req_mod_${Date.now()}`;

    if (typeof body?.enabled !== 'boolean') {
      return {
        status: 400,
        data: {
          error: {
            code: 'INVALID_MODULE_STATE',
            category: 'VALIDATION',
            message: 'body.enabled must be a boolean.',
            request_id: requestId,
          },
        },
      };
    }

    const targetTenantId = (typeof body?.tenantId === 'string' && body.tenantId.trim())
      ? body.tenantId.trim()
      : tenantId;

    // Resolve server-side built-in permissions for principal (fail-closed for unknown principals)
    const permissions = resolveBuiltInPrincipalPermissions(principal);

    const decision = pdp.evaluate({
      principal,
      tenant_context: tenantContext,
      action: 'module:manage',
      resource_type: 'Module',
      resource_id: moduleId,
      resource_tenant_id: targetTenantId,
      principal_permissions: permissions,
    });

    if (decision.decision !== 'ALLOW') {
      const outcome = describeDeniedDecision(decision);
      auditLogger.logEvent({
        actor: principal,
        tenant_id: tenantId,
        action: 'module.state_change_blocked',
        resource: { type: 'Module', id: moduleId },
        result: outcome.auditResult,
        reason_code: decision.reason_code,
        request_id: requestId,
      });
      return {
        status: outcome.httpStatus,
        data: { error: outcome.errorCode, reason: decision.reason_code, request_id: requestId },
      };
    }

    try {
      const updated = moduleService.setModuleState(targetTenantId, moduleId, body.enabled as boolean, principal.id);
      return { status: 200, data: updated };
    } catch (error) {
      return modelErrorResult(error);
    }
  }

  if (pathname.startsWith('/api/v1/modules/') && method === 'GET') {
    const moduleId = pathname.slice('/api/v1/modules/'.length);
    const moduleState = moduleService.getModule(tenantId, moduleId);
    if (!moduleState) {
      return {
        status: 404,
        data: {
          error: {
            code: 'MODULE_NOT_FOUND',
            category: 'NOT_FOUND',
            message: `Module "${moduleId}" was not found.`,
            request_id: `req_mod_${Date.now()}`,
          },
        },
      };
    }
    return { status: 200, data: moduleState };
  }

  return undefined;
};
