import { NagexError } from '../../common/errors.js';
import type { AiService } from '../../model-gateway/ai-service.js';
import type { EvidencePackService } from '../../research/evidence-pack.service.js';
import type { MemoryRecord } from '../../context/memory.engine.js';
import type { ArtifactStore } from '../../artifacts/artifact.store.js';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';
import { callerIdentity } from '../request-identity.js';
import { detectRequestLanguage } from '../../common/request-language.js';
import type { ResearchReportService } from '../../research/research-report.service.js';
import type { ResearchRunStore } from '../../research/research-run.store.js';

export interface ResearchRouteDeps {
  aiService: AiService;
  evidencePackService: EvidencePackService;
  artifactStore?: ArtifactStore;
  getRelevantMemories?: (tenantId: string, ownerId: string, query: string) => MemoryRecord[];
  modelErrorResult: (error: unknown) => ApiResult;
  // R26-A: optional so existing wiring keeps compiling; without it the report route answers truthfully that it is unavailable
  researchReportService?: ResearchReportService;
  researchRunStore?: ResearchRunStore;
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

  // A cited research report: searched, retrieved, verified, composed by NAgex and saved as a real document. Domain outcomes other than success (no search provider, nothing retrievable, nothing verifiable) are
  // answered 200 with their status and reason - the same contract as POST /api/v1/research - and no document exists for them.
  if (pathname === '/api/v1/research/reports' && method === 'POST') {
    const { tenantId, principalId } = callerIdentity(headers);
    const headerRequestId = headers['x-request-id'] || headers['X-Request-Id'];
    const requestId = (Array.isArray(headerRequestId) ? headerRequestId[0] : headerRequestId) || `req_rrep_${Date.now()}`;
    const query = typeof body?.query === 'string' ? body.query.trim() : '';
    if (!query || query.length > 600) {
      return { status: 400, data: { error: 'INVALID_QUERY', message: 'A research question of 1 to 600 characters is required.', request_id: requestId } };
    }
    if (!deps.researchReportService) {
      return { status: 503, data: { error: 'RESEARCH_REPORT_UNAVAILABLE', message: 'Research reports are not available right now.', request_id: requestId } };
    }
    const locale: 'en' | 'ko' = body?.locale === 'ko' || body?.locale === 'en' ? body.locale : (detectRequestLanguage(query) === 'ko' ? 'ko' : 'en');
    const outcome = await deps.researchReportService.run({ query, tenantId, ownerId: principalId, requestId, locale });
    return { status: outcome.status === 'SUCCESS' ? 201 : 200, data: { query, ...outcome } };
  }

  // The provenance of a report: what was searched, retrieved and verified. Unknown, malformed, foreign-tenant and foreign-owner run ids are indistinguishable.
  const runMatch = pathname.match(/^\/api\/v1\/research\/runs\/([^/]+)$/);
  if (runMatch && method === 'GET') {
    const { tenantId, principalId } = callerIdentity(headers);
    const record = deps.researchRunStore?.get(runMatch[1], tenantId, principalId) ?? null;
    if (!record) return { status: 404, data: { error: 'RESEARCH_RUN_NOT_FOUND', message: 'Research run not found.' } };
    const { tenantId: _t, ownerId: _o, ...visible } = record;
    return { status: 200, data: { run: visible } };
  }

  if (pathname === '/api/v1/research' && method === 'POST') {
    const tenantId = callerIdentity(headers).tenantId;
    const principalId = callerIdentity(headers).principalId;
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
      // Directive B: Explicit research endpoint MUST force search execution
      const evidencePack = await evidencePackService.buildEvidencePack(query, { forceSearch: true, requestId });

      // Directive B & A: Truthful failure when evidence retrieval returns 0 sources or non-SUCCESS status
      if (evidencePack.status !== 'SUCCESS' || evidencePack.sources.length === 0) {
        const notAvailMsg = evidencePack.status === 'UNAVAILABLE'
          ? "Could not complete research because live web search capability is unavailable."
          : `Could not complete research because no verified evidence sources were found (${evidencePack.status}).`;
        return {
          status: 200,
          data: {
            query,
            freshness: evidencePack.freshnessRequirement,
            category: evidencePack.category,
            status: evidencePack.status,
            answer: notAvailMsg,
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
      deps.artifactStore?.saveCompleted({
        tenantId, ownerId: principalId, type: 'RESEARCH', title: query,
        preview: outcome.data.answer, sourceType: 'RESEARCH_RESULT', sourceId: evidencePack.evidencePackId,
        openTarget: `/api/v1/artifacts/by-source/${encodeURIComponent(evidencePack.evidencePackId)}`,
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
