// R23.1 — Personal Context Aggregation HTTP Route.
// R23.2 — Right Now / Today Intelligence HTTP Route (added below).
// Both are read-only, tenant/user-scoped snapshots. No mutation, no
// provider/model call. The right-now route fetches the canonical context
// exactly once and delegates ranking to RightNowIntelligenceService — it
// never builds a second, parallel context snapshot
// (CURRENT_CONTEXT_PIPELINE_COUNT=1).
import type { CurrentPersonalContextService } from '../../personal/current-personal-context.service.js';
import type { RightNowIntelligenceService } from '../../personal/right-now-intelligence.service.js';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';

export interface PersonalContextRouteDeps {
  currentPersonalContextService: CurrentPersonalContextService;
  rightNowIntelligenceService?: RightNowIntelligenceService;
  modelErrorResult: (error: unknown) => ApiResult;
}

function resolveIdentity(headers: Record<string, string | string[] | undefined>): { tenantId: string; principalId: string; requestId: string } {
  const tenantId = (Array.isArray(headers['x-nagex-tenant']) ? headers['x-nagex-tenant'][0] : headers['x-nagex-tenant']) || 'ten_production_01';
  const principalId = (Array.isArray(headers['x-principal-id']) ? headers['x-principal-id'][0] : headers['x-principal-id']) || 'usr_admin_001';
  const headerRequestId = headers['x-request-id'] || headers['X-Request-Id'];
  const requestId = (Array.isArray(headerRequestId) ? headerRequestId[0] : headerRequestId) || `req_ctx_${Date.now()}`;
  return { tenantId, principalId, requestId };
}

export const handlePersonalContextRoutes: AsyncRouteRegistrar<PersonalContextRouteDeps> = async (
  method,
  pathname,
  _body,
  headers,
  _query,
  deps
): Promise<ApiResult | undefined> => {
  const { currentPersonalContextService, rightNowIntelligenceService, modelErrorResult } = deps;

  if (pathname === '/api/v1/personal/context' && method === 'GET') {
    const { tenantId, principalId, requestId } = resolveIdentity(headers);

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

  if (pathname === '/api/v1/personal/right-now' && method === 'GET') {
    if (!rightNowIntelligenceService) {
      return { status: 503, data: { error: 'RIGHT_NOW_UNAVAILABLE', message: 'Right Now intelligence is not configured.' } };
    }
    const { tenantId, principalId, requestId } = resolveIdentity(headers);

    try {
      const data = await rightNowIntelligenceService.buildRightNow({
        tenantId,
        userId: principalId,
        requestId,
      });

      return { status: 200, data };
    } catch (error) {
      return modelErrorResult(error);
    }
  }

  // R23.3 — a dedicated read of the same canonical suggestion list
  // GET /api/v1/personal/right-now already carries. This does exactly one
  // context fetch of its own (CONTEXT_FETCH_PER_PERSONAL_REQUEST<=1) — it
  // never shares a fetch across requests, but a caller who only wants
  // suggestions never has to pull the full Right Now payload to get them.
  if (pathname === '/api/v1/personal/suggestions' && method === 'GET') {
    if (!rightNowIntelligenceService) {
      return { status: 503, data: { error: 'SUGGESTIONS_UNAVAILABLE', message: 'Proactive suggestions are not configured.' } };
    }
    const { tenantId, principalId, requestId } = resolveIdentity(headers);

    try {
      const intel = await rightNowIntelligenceService.buildRightNow({
        tenantId,
        userId: principalId,
        requestId,
      });

      return { status: 200, data: { generatedAt: intel.generatedAt, suggestions: intel.suggestions } };
    } catch (error) {
      return modelErrorResult(error);
    }
  }

  return undefined;
};
