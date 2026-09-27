// R23.6E — Competitor Pricing Monitor + Email canonical scenario route.
// Phase B: start a run and read its status only. This module deliberately
// never imports GmailService/BrowserService/UnifiedModelRouter/
// ActionApprovalStore directly — every real integration is added behind
// CompetitorPricingRunService in later phases, so this route can never be
// the place a send happens; it only ever translates HTTP <->
// CompetitorPricingRunService.
import crypto from 'node:crypto';
import { NagexError } from '../../common/errors.js';
import { DEFAULT_GOOGLE_TENANT_ID } from '../../integrations/google/token.store.js';
import type { CompetitorPricingRunService } from '../../agents/competitor-pricing-run.service.js';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';

function getHeaderValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export interface CompetitorPricingAgentRouteDeps {
  competitorPricingRunService: CompetitorPricingRunService;
}

const BASE_PATH = '/api/v1/agents/competitor-pricing-email';

export const handleCompetitorPricingAgentRoutes: AsyncRouteRegistrar<CompetitorPricingAgentRouteDeps> = async (
  method,
  pathname,
  body,
  headers,
  _query,
  deps,
): Promise<ApiResult | undefined> => {
  const { competitorPricingRunService } = deps;

  if (pathname === BASE_PATH && method === 'POST') {
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
    const ownerId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
    const competitor = typeof body?.competitor === 'string' ? body.competitor : '';
    if (!competitor.trim()) {
      throw new NagexError({ code: 'AGENT_COMPETITOR_REQUIRED', category: 'VALIDATION', message: 'competitor is required.', request_id: requestId });
    }
    const targetUrl = typeof body?.targetUrl === 'string' ? body.targetUrl : undefined;
    const recipientEmail = typeof body?.recipientEmail === 'string' ? body.recipientEmail : undefined;
    const run = competitorPricingRunService.startRun({ tenantId, ownerId, requestId, competitor, targetUrl, recipientEmail });
    return { status: 201, data: run };
  }

  const getMatch = pathname.match(new RegExp(`^${BASE_PATH}/([^/]+)$`));
  if (getMatch && method === 'GET') {
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
    const ownerId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
    const runId = decodeURIComponent(getMatch[1]);
    const run = competitorPricingRunService.getOwnedRun(runId, tenantId, ownerId);
    if (!run) {
      throw new NagexError({ code: 'AGENT_RUN_NOT_FOUND', category: 'NOT_FOUND', message: `Run ${runId} was not found.`, request_id: requestId });
    }
    return { status: 200, data: run };
  }

  return undefined;
};
