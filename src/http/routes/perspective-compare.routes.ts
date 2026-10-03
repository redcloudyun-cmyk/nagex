import { NagexError } from '../../common/errors.js';
import type { PerspectiveCompareService } from '../../model-gateway/perspective-compare.service.js';
import type { MemoryRecord } from '../../context/memory.engine.js';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';
import { callerIdentity } from '../request-identity.js';

export interface PerspectiveCompareRouteDeps {
  perspectiveCompareService: PerspectiveCompareService;
  getRelevantMemories?: (tenantId: string, ownerId: string, query: string) => MemoryRecord[];
  modelErrorResult: (error: unknown) => ApiResult;
}

export const handlePerspectiveCompareRoutes: AsyncRouteRegistrar<PerspectiveCompareRouteDeps> = async (
  method,
  pathname,
  body,
  headers,
  _query,
  deps
): Promise<ApiResult | undefined> => {
  const { perspectiveCompareService, getRelevantMemories, modelErrorResult } = deps;

  if (pathname === '/api/v1/ai/perspective-compare' && method === 'POST') {
    const tenantId = callerIdentity(headers).tenantId;
    const principalId = callerIdentity(headers).principalId;
    const headerRequestId = headers['x-request-id'] || headers['X-Request-Id'];
    const requestId = (Array.isArray(headerRequestId) ? headerRequestId[0] : headerRequestId) || `req_cmp_${Date.now()}`;

    const queryStr = typeof body?.query === 'string' ? body.query.trim() : '';
    if (!queryStr) {
      return {
        status: 400,
        data: { error: 'INVALID_QUERY', message: 'Perspective compare query is required.', request_id: requestId },
      };
    }

    try {
      const memories = getRelevantMemories ? getRelevantMemories(tenantId, principalId, queryStr) : [];
      const result = await perspectiveCompareService.compare({
        query: queryStr,
        tenantId,
        ownerId: principalId,
        memories,
        requestId,
      });

      return {
        status: 200,
        data: {
          status: result.status,
          answer: result.synthesis?.answer || '',
          commonGround: result.synthesis?.commonGround || [],
          differingPerspectives: result.synthesis?.differingPerspectives || [],
          uncertainties: result.synthesis?.uncertainties || [],
          sources: result.sources || [],
        },
      };
    } catch (error) {
      return modelErrorResult(error);
    }
  }

  return undefined;
};
