// R23.1 — Personal Context Aggregation HTTP Route.
// Read-only, tenant/user-scoped snapshot of the canonical
// CurrentPersonalContextService aggregation. No mutation, no provider/
// model call.
import type { CurrentPersonalContextService } from '../../personal/current-personal-context.service.js';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';

export interface PersonalContextRouteDeps {
  currentPersonalContextService: CurrentPersonalContextService;
  modelErrorResult: (error: unknown) => ApiResult;
}

export const handlePersonalContextRoutes: AsyncRouteRegistrar<PersonalContextRouteDeps> = async (
  method,
  pathname,
  _body,
  headers,
  _query,
  deps
): Promise<ApiResult | undefined> => {
  const { currentPersonalContextService, modelErrorResult } = deps;

  if (pathname === '/api/v1/personal/context' && method === 'GET') {
    const tenantId = (Array.isArray(headers['x-nagex-tenant']) ? headers['x-nagex-tenant'][0] : headers['x-nagex-tenant']) || 'ten_production_01';
    const principalId = (Array.isArray(headers['x-principal-id']) ? headers['x-principal-id'][0] : headers['x-principal-id']) || 'usr_admin_001';
    const headerRequestId = headers['x-request-id'] || headers['X-Request-Id'];
    const requestId = (Array.isArray(headerRequestId) ? headerRequestId[0] : headerRequestId) || `req_ctx_${Date.now()}`;

    try {
      const data = await currentPersonalContextService.buildCurrentContext({
        tenantId,
        userId: principalId,
        requestId,
      });

      return { status: 200, data };
    } catch (error) {
      return modelErrorResult(error);
    }
  }

  return undefined;
};
