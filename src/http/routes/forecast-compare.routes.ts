import { NagexError } from '../../common/errors.js';
import type { ForecastCompareService } from '../../model-gateway/forecast-compare.service.js';
import type { MemoryRecord } from '../../context/memory.engine.js';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';

export interface ForecastCompareRouteDeps {
  forecastCompareService: ForecastCompareService;
  getRelevantMemories?: (tenantId: string, ownerId: string, query: string) => MemoryRecord[];
  modelErrorResult: (error: unknown) => ApiResult;
}

export const handleForecastCompareRoutes: AsyncRouteRegistrar<ForecastCompareRouteDeps> = async (
  method,
  pathname,
  body,
  headers,
  _query,
  deps
): Promise<ApiResult | undefined> => {
  const { forecastCompareService, getRelevantMemories, modelErrorResult } = deps;

  if (pathname === '/api/v1/ai/forecast-compare' && method === 'POST') {
    const tenantId = (Array.isArray(headers['x-nagex-tenant']) ? headers['x-nagex-tenant'][0] : headers['x-nagex-tenant']) || 'ten_production_01';
    const principalId = (Array.isArray(headers['x-principal-id']) ? headers['x-principal-id'][0] : headers['x-principal-id']) || 'usr_admin_001';
    const headerRequestId = headers['x-request-id'] || headers['X-Request-Id'];
    const requestId = (Array.isArray(headerRequestId) ? headerRequestId[0] : headerRequestId) || `req_fct_${Date.now()}`;

    const queryStr = typeof body?.query === 'string' ? body.query.trim() : '';
    if (!queryStr) {
      return {
        status: 400,
        data: { error: 'INVALID_QUERY', message: 'Forecast compare query is required.', request_id: requestId },
      };
    }

    try {
      const memories = getRelevantMemories ? getRelevantMemories(tenantId, principalId, queryStr) : [];
      const result = await forecastCompareService.compare({
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
          specification: result.specification,
          informationalMessage: result.informationalMessage ?? null,
          clarificationMessage: result.clarificationMessage ?? null,
          probability: result.synthesis?.probability ?? null,
          probabilityRange: result.synthesis?.probabilityRange ?? null,
          summary: result.synthesis?.summary || '',
          keyDrivers: result.synthesis?.keyDrivers || [],
          counterSignals: result.synthesis?.counterSignals || [],
          uncertainties: result.synthesis?.uncertainties || [],
          whatWouldChangeTheForecast: result.synthesis?.whatWouldChangeTheForecast || [],
          distribution: result.distribution,
          sources: result.sources || [],
        },
      };
    } catch (error) {
      return modelErrorResult(error);
    }
  }

  return undefined;
};
