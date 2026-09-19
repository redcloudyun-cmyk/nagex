import { NagexError } from '../../common/errors.js';
import type { AiService } from '../../model-gateway/ai-service.js';
import type { EvidencePackService } from '../../research/evidence-pack.service.js';
import type { MemoryRecord } from '../../context/memory.engine.js';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';

export interface ResearchRouteDeps {
  aiService: AiService;
  evidencePackService: EvidencePackService;
  getRelevantMemories?: (tenantId: string, ownerId: string, query: string) => MemoryRecord[];
  modelErrorResult: (error: unknown) => ApiResult;
}

export const handleResearchRoutes: AsyncRouteRegistrar<ResearchRouteDeps> = async (
  method,
  pathname,
  body,
  headers,
  _query,
  deps
): Promise<ApiResult | undefined> => {
  const { aiService, evidencePackService, getRelevantMemories, modelErrorResult } = deps;

  if (pathname === '/api/v1/research' && method === 'POST') {
    const tenantId = (Array.isArray(headers['x-nagex-tenant']) ? headers['x-nagex-tenant'][0] : headers['x-nagex-tenant']) || 'ten_production_01';
    const principalId = (Array.isArray(headers['x-principal-id']) ? headers['x-principal-id'][0] : headers['x-principal-id']) || 'usr_admin_001';
    const headerRequestId = headers['x-request-id'] || headers['X-Request-Id'];
    const requestId = (Array.isArray(headerRequestId) ? headerRequestId[0] : headerRequestId) || `req_res_${Date.now()}`;

    const query = typeof body?.query === 'string' ? body.query.trim() : '';
    if (!query) {
      return {
        status: 400,
        data: { error: 'INVALID_QUERY', message: 'Research query is required.', request_id: requestId },
      };
    }

    try {
      const memories = getRelevantMemories ? getRelevantMemories(tenantId, principalId, query) : [];
      const evidencePack = await evidencePackService.buildEvidencePack(query, { requestId });

      // Truthful failure when search is required but search capability is unavailable
      if (evidencePack.freshnessRequirement === 'REQUIRED' && !evidencePackService.isWebSearchAvailable()) {
        return {
          status: 200,
          data: {
            query,
            freshness: evidencePack.freshnessRequirement,
            category: evidencePack.category,
            answer: "I can't verify current information right now because live web search is unavailable.",
            evidencePackId: evidencePack.evidencePackId,
            sources: [],
          },
        };
      }

      const outcome = await aiService.research({
        query,
        evidencePack,
        memories,
        requestId,
      });

      return {
        status: 200,
        data: {
          query,
          freshness: evidencePack.freshnessRequirement,
          category: evidencePack.category,
          answer: outcome.data.answer,
          evidencePackId: evidencePack.evidencePackId,
          sources: evidencePack.sources,
        },
      };
    } catch (error) {
      return modelErrorResult(error);
    }
  }

  return undefined;
};
