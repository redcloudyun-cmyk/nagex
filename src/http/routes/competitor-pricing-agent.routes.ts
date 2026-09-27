// R23.6E — Competitor Pricing Monitor + Email canonical scenario route.
// POST creates a run and GET reads its status; both Phase B. This module
// deliberately never imports GmailService/BrowserService/
// UnifiedModelRouter/ActionApprovalStore directly — every real
// integration lives behind CompetitorPricingRunService, so this route can
// never itself be the place a send happens; it only ever translates
// HTTP <-> CompetitorPricingRunService.
//
// Final-certification addition — POST .../:runId/continue. This is
// intentionally the ONLY execution-surface route: it inspects the
// persisted run's own current status and invokes exactly the one legal
// next orchestration step (never more than one, never a caller-chosen
// step), reusing every existing state-transition guard, approval check,
// and payload-drift protection unchanged. It does not add any new
// approval/send/credential logic of its own — it is pure HTTP <-> service
// plumbing, same as POST/GET above. In particular:
//   - APPROVAL_REQUIRED still only ever calls confirmApproval(), which
//     itself only advances once the REAL approval system reports
//     APPROVED — this route can never auto-approve or auto-send.
//   - A run at a status with no legal next step (FAILED/BLOCKED, or an
//     already-finalized SENT_CONFIRMED being finalized again is still
//     legal/idempotent) is returned unchanged rather than erroring.
import crypto from 'node:crypto';
import { NagexError } from '../../common/errors.js';
import { DEFAULT_GOOGLE_TENANT_ID } from '../../integrations/google/token.store.js';
import type { CompetitorPricingRunService } from '../../agents/competitor-pricing-run.service.js';
import type { CompetitorPricingRunRecord } from '../../agents/competitor-pricing-email.types.js';
import type { ReportLocale } from '../../agents/pricing-report-composer.js';
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

  const continueMatch = pathname.match(new RegExp(`^${BASE_PATH}/([^/]+)/continue$`));
  if (continueMatch && method === 'POST') {
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
    const ownerId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
    const runId = decodeURIComponent(continueMatch[1]);
    const locale: ReportLocale = body?.locale === 'ko' ? 'ko' : 'en';

    const current = competitorPricingRunService.getOwnedRun(runId, tenantId, ownerId);
    if (!current) {
      throw new NagexError({ code: 'AGENT_RUN_NOT_FOUND', category: 'NOT_FOUND', message: `Run ${runId} was not found.`, request_id: requestId });
    }

    let run: CompetitorPricingRunRecord;
    let extra: Record<string, unknown> | undefined;
    switch (current.status) {
      case 'RESEARCHING':
        run = await competitorPricingRunService.completeResearch(runId, tenantId, ownerId, requestId);
        break;
      case 'REPORT_READY':
        run = competitorPricingRunService.createDraft(runId, tenantId, ownerId, requestId, locale);
        break;
      case 'DRAFT_CREATED':
        run = competitorPricingRunService.requestSendApproval(runId, tenantId, ownerId, requestId);
        break;
      case 'APPROVAL_REQUIRED':
        // Never auto-approves — confirmApproval() only advances once the
        // real Gmail/ActionApprovalStore approval is genuinely APPROVED;
        // still PENDING returns the run unchanged.
        run = competitorPricingRunService.confirmApproval(runId, tenantId, ownerId, requestId);
        break;
      case 'APPROVED':
        run = await competitorPricingRunService.executeApprovedSend(runId, tenantId, ownerId, requestId);
        break;
      case 'SENT_CONFIRMED': {
        const result = competitorPricingRunService.finalizeRun(runId, tenantId, ownerId, requestId);
        run = result.run;
        extra = { baselinePromoted: result.baselinePromoted, memoryProposed: result.memoryProposed };
        break;
      }
      default:
        // FAILED/BLOCKED — no legal next step; safe no-op, never an error.
        run = current;
    }

    return { status: 200, data: extra ? { ...run, ...extra } : run };
  }

  return undefined;
};
