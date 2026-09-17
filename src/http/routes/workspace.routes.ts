// R10.2-D Increment 3 — Workspace/Capture/Candidate/Activity routes,
// extracted verbatim from server_web.ts's handleAsyncApiRequest. All of
// these routes depend on exactly one canonical service —
// QuickCaptureService — which already owns the real capture-processing
// orchestration (including R10.2-C's shared finalization architecture in
// capture-analysis-finalizer.ts). This route module never reimplements
// capture/candidate business logic; it only translates HTTP <-> that one
// service, exactly as the original inline code did.
//
// route-input is the one exception: it calls the stateless
// InputRouter.classify() directly (no store, no side effect, never creates
// a Task/Candidate) — preserved as-is.
//
// Risk classification (R10.2-D Increment 3 §4): route-input/storage-status/
// inbox/vault/candidates-list/activity/item-download/item-preview/
// item-get/candidate-get/candidate-action-get are READ_ONLY; uploads-init/
// uploads-complete/upload/capture-create/capture-action/item-action/
// item-candidate-action/item-retry/item-delete/candidate-accept/
// candidate-reject/candidate-patch are LOCAL_MUTATION (QuickCaptureService-
// scoped, no external side effect); candidate-execute/candidate-retry are
// APPROVAL_GATED in effect for CALENDAR-type candidates (they only ever
// request/re-request the existing Action Approval — the real Google write
// still requires that approval to be separately granted via the unchanged
// /api/v1/approvals/:id/approve route, untouched by this move).
import { InputRouter } from '../../workspace/input-router.js';
import type { QuickCaptureService } from '../../workspace/quick-capture.service.js';
import type { CandidateStatus, CandidateType } from '../../workspace/candidate.types.js';
import { NagexError } from '../../common/errors.js';
import { DEFAULT_GOOGLE_TENANT_ID } from '../../integrations/google/token.store.js';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';

function getHeaderValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export interface WorkspaceRouteDeps {
  quickCaptureService: QuickCaptureService;
}

export const handleWorkspaceRoutes: AsyncRouteRegistrar<WorkspaceRouteDeps> = async (method, pathname, body, headers, query, deps): Promise<ApiResult | undefined> => {
  const { quickCaptureService } = deps;

  if (pathname === '/api/v1/workspace/route-input' && method === 'POST') {
    const text = typeof body?.text === 'string' ? body.text : '';
    const hasFile = Boolean(body?.hasFile);
    const hasAudio = Boolean(body?.hasAudio);
    const mimeType = typeof body?.mimeType === 'string' ? body.mimeType : undefined;
    const classification = InputRouter.classify({ text, hasFile, hasAudio, mimeType });
    return { status: 200, data: classification };
  }

  if (pathname === '/api/v1/workspace/storage/status' && method === 'GET') {
    const status = await quickCaptureService.getStorageHealth();
    return { status: 200, data: status };
  }


  if (pathname === '/api/v1/workspace/uploads/init' && method === 'POST') {
    const filename = (body?.filename as string) || 'upload.bin';
    const mimeType = (body?.mimeType as string) || 'application/octet-stream';
    const sizeBytes = Number(body?.sizeBytes || 0);
    const intent = body?.intent as any;
    const principalId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || 'ten_production_01';
    const initResult = await quickCaptureService.initUpload({
      ownerId: principalId,
      tenantId,
      filename,
      mimeType,
      sizeBytes,
      intent,
    });
    return { status: 201, data: initResult };
  }

  if (pathname === '/api/v1/workspace/uploads/complete' && method === 'POST') {
    const captureId = (body?.captureId as string) || '';
    const objectKey = (body?.objectKey as string) || '';
    const mimeType = (body?.mimeType as string) || 'application/octet-stream';
    const checksum = (body?.checksum as string) || '';
    const sizeBytes = Number(body?.sizeBytes || 0);
    const originalFilename = (body?.originalFilename as string) || 'upload.bin';
    const rawData = body?.data ? Buffer.from(body.data as any) : undefined;
    const principalId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || 'ten_production_01';
    const item = await quickCaptureService.completeUpload({
      captureId,
      ownerId: principalId,
      tenantId,
      objectKey,
      mimeType,
      checksum,
      sizeBytes,
      originalFilename,
      data: rawData,
    });
    return { status: 200, data: item };
  }

  if (pathname === '/api/v1/workspace/upload' && method === 'POST') {
    const filename = (body?.filename as string) || 'upload.bin';
    const mimeType = (body?.mimeType as string) || 'application/octet-stream';
    const type = (body?.type as any) || (mimeType.startsWith('audio/') ? 'AUDIO' : 'FILE');
    const source = (body?.source as any) || 'WEB';
    const principalId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || 'ten_production_01';
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_${Date.now()}`;
    // Accept body.base64 (from frontend audio/file recorder), body.data (binary stream),
    // or body.content (plain text fallback). Reject empty payloads.
    let rawData: Buffer;
    if (typeof body?.base64 === 'string' && body.base64.length > 0) {
      rawData = Buffer.from(body.base64, 'base64');
    } else if (body?.data) {
      rawData = typeof body.data === 'string' ? Buffer.from(body.data, 'base64') : Buffer.from(body.data as any);
    } else if (typeof body?.content === 'string' && body.content.length > 0) {
      rawData = Buffer.from(body.content, 'utf8');
    } else {
      throw new NagexError({ code: 'EMPTY_FILE_PAYLOAD', category: 'VALIDATION', message: 'Binary payload data is required (base64, data, or content).', request_id: requestId });
    }
    if (rawData.length > 50 * 1024 * 1024) {
      throw new NagexError({ code: 'FILE_TOO_LARGE', category: 'VALIDATION', message: 'File size exceeds maximum allowed limit of 50 MB.', request_id: requestId });
    }
    const item = await quickCaptureService.uploadBinaryObject({
      ownerId: principalId,
      tenantId,
      type,
      filename,
      mimeType,
      data: rawData,
      source,
    });
    return { status: 201, data: item };
  }

  if ((pathname === '/api/v1/workspace/captures' || pathname === '/api/v1/workspace/capture') && method === 'POST') {
    const type = (body?.type as any) || 'TEXT';
    const content = (body?.content as string) || '';
    const source = (body?.source as any) || 'WEB';
    const principalId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || 'ten_production_01';
    const item = await quickCaptureService.captureTextOrLink({
      ownerId: principalId,
      tenantId,
      type,
      content,
      source,
    });
    return { status: 201, data: item };
  }

  if (pathname.startsWith('/api/v1/workspace/capture/') && (method === 'PATCH' || method === 'POST')) {
    const captureId = pathname.slice('/api/v1/workspace/capture/'.length);
    const action = (body?.status as any) || (body?.action as any) || 'ACTIONED';
    const principalId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || 'ten_production_01';
    const item = await quickCaptureService.actionCapture(captureId, tenantId, principalId, action);
    if (!item) {
      return { status: 404, data: { error: 'ITEM_NOT_FOUND', message: `Capture item ${captureId} not found.` } };
    }
    return { status: 200, data: item };
  }

  if (pathname.startsWith('/api/v1/workspace/items/') && pathname.endsWith('/download') && method === 'GET') {
    const captureId = pathname.slice('/api/v1/workspace/items/'.length, pathname.length - '/download'.length);
    const principalId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || 'ten_production_01';
    const downloadUrl = await quickCaptureService.getDownloadUrl(captureId, tenantId, principalId);
    if (!downloadUrl) {
      return { status: 404, data: { error: 'ITEM_NOT_FOUND', message: `Capture item ${captureId} not found or no object attached.` } };
    }
    return { status: 200, data: { captureId, downloadUrl } };
  }

  if (pathname.startsWith('/api/v1/workspace/items/') && pathname.endsWith('/preview') && method === 'GET') {
    const captureId = pathname.slice('/api/v1/workspace/items/'.length, pathname.length - '/preview'.length);
    const principalId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || 'ten_production_01';
    const previewUrl = await quickCaptureService.getPreviewUrl(captureId, tenantId, principalId);
    if (!previewUrl) {
      return { status: 404, data: { error: 'ITEM_NOT_FOUND', message: `Capture item ${captureId} not found or no object attached.` } };
    }
    return { status: 200, data: { captureId, previewUrl } };
  }

  if (pathname.startsWith('/api/v1/workspace/items/') && pathname.endsWith('/action') && method === 'POST') {
    const captureId = pathname.slice('/api/v1/workspace/items/'.length, pathname.length - '/action'.length);
    const action = (body?.action as any) || 'ACTIONED';
    const principalId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || 'ten_production_01';
    const item = await quickCaptureService.actionCapture(captureId, tenantId, principalId, action);
    if (!item) {
      return { status: 404, data: { error: 'ITEM_NOT_FOUND', message: `Capture item ${captureId} not found.` } };
    }
    return { status: 200, data: item };
  }

  if (pathname.startsWith('/api/v1/workspace/items/') && pathname.includes('/candidates/') && pathname.endsWith('/action') && method === 'POST') {
    const parts = pathname.slice('/api/v1/workspace/items/'.length).split('/candidates/');
    const captureId = parts[0];
    const candidateId = parts[1] ? parts[1].replace(/\/action$/, '') : '';
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
    const ownerId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
    const action = body?.action === 'ACCEPT' ? 'ACCEPT' : 'REJECT';

    const updated = await quickCaptureService.actionCandidate({
      captureId,
      candidateId,
      action,
      ownerId,
      tenantId,
    });

    if (!updated) {
      return { status: 404, data: { error: 'CANDIDATE_NOT_FOUND', message: `Candidate ${candidateId} or capture ${captureId} not found.` } };
    }
    return { status: 200, data: updated };
  }

  // ─── Phase 1 STEP 5 — Canonical Candidate Model API ───
  // Accept/reject here ONLY change the candidate's own status — they never
  // create a Task, request a Calendar approval, write Memory, or index
  // Knowledge. Real execution is a later, separate Action phase.
  if (pathname === '/api/v1/candidates' && method === 'GET') {
    const ownerId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
    const statusFilter = query.status as CandidateStatus | undefined;
    const typeFilter = query.type as CandidateType | undefined;
    const candidates = quickCaptureService.listCandidates(ownerId, tenantId, {
      status: statusFilter,
      type: typeFilter,
    });
    return { status: 200, data: { candidates } };
  }

  // ─── Phase 1 STEP 8 — Consumer Activity Projection ───
  // Tenant/principal-isolated, durable, human-readable — never the raw
  // AuditLogger and never the legacy non-tenant-isolated executionHistory
  // array.
  if (pathname === '/api/v1/activity' && method === 'GET') {
    const ownerId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
    const limitRaw = Number(query.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50;
    const activities = quickCaptureService.listActivity(ownerId, tenantId, limit);
    return { status: 200, data: { activities } };
  }

  if (pathname.startsWith('/api/v1/candidates/') && pathname.endsWith('/accept') && method === 'POST') {
    const candidateId = pathname.slice('/api/v1/candidates/'.length, pathname.length - '/accept'.length);
    const ownerId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
    const record = quickCaptureService.acceptCandidate(candidateId, ownerId, tenantId);
    return { status: 200, data: record };
  }

  if (pathname.startsWith('/api/v1/candidates/') && pathname.endsWith('/reject') && method === 'POST') {
    const candidateId = pathname.slice('/api/v1/candidates/'.length, pathname.length - '/reject'.length);
    const ownerId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
    const record = quickCaptureService.rejectCandidate(candidateId, ownerId, tenantId);
    return { status: 200, data: record };
  }

  // ─── Phase 1 STEP 7 — Real Actions ───
  // Execute/retry ONLY ever advance a candidate's own `action` sub-state —
  // Candidate Review (accept/reject above) is a separate operation from
  // Action execution, and for CALENDAR specifically this first call only
  // ever requests the existing Action Approval; the real Google write
  // still requires that approval to be separately granted via the
  // unchanged /api/v1/approvals/:id/approve endpoint.
  if (pathname.startsWith('/api/v1/candidates/') && pathname.endsWith('/execute') && method === 'POST') {
    const candidateId = pathname.slice('/api/v1/candidates/'.length, pathname.length - '/execute'.length);
    const ownerId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
    const record = await quickCaptureService.executeCandidateAction(candidateId, ownerId, tenantId);
    return { status: 200, data: record };
  }

  if (pathname.startsWith('/api/v1/candidates/') && pathname.endsWith('/retry') && method === 'POST') {
    const candidateId = pathname.slice('/api/v1/candidates/'.length, pathname.length - '/retry'.length);
    const ownerId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
    const record = await quickCaptureService.retryCandidateAction(candidateId, ownerId, tenantId);
    return { status: 200, data: record };
  }

  if (pathname.startsWith('/api/v1/candidates/') && pathname.endsWith('/action') && method === 'GET') {
    const candidateId = pathname.slice('/api/v1/candidates/'.length, pathname.length - '/action'.length);
    const ownerId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
    const action = quickCaptureService.getCandidateAction(candidateId, ownerId, tenantId);
    return { status: 200, data: { candidateId, action } };
  }

  if (pathname.startsWith('/api/v1/candidates/') && method === 'PATCH') {
    const candidateId = pathname.slice('/api/v1/candidates/'.length);
    const ownerId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
    const record = quickCaptureService.modifyCandidate(candidateId, ownerId, tenantId, {
      title: typeof body?.title === 'string' ? body.title : undefined,
      payload: (body?.payload && typeof body.payload === 'object') ? body.payload as Record<string, unknown> : undefined,
    });
    return { status: 200, data: record };
  }

  if (pathname.startsWith('/api/v1/candidates/') && method === 'GET') {
    const candidateId = pathname.slice('/api/v1/candidates/'.length);
    const ownerId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
    const record = quickCaptureService.getCandidate(candidateId, ownerId, tenantId);
    if (!record) {
      return { status: 404, data: { error: 'CANDIDATE_NOT_FOUND', message: `Candidate ${candidateId} not found.` } };
    }
    return { status: 200, data: record };
  }

  if (pathname.startsWith('/api/v1/workspace/items/') && pathname.endsWith('/retry') && method === 'POST') {
    const captureId = pathname.slice('/api/v1/workspace/items/'.length, pathname.length - '/retry'.length);
    const ownerId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || 'ten_production_01';
    const retried = await quickCaptureService.retryCapture(captureId, tenantId, ownerId);
    if (!retried) {
      return { status: 404, data: { error: 'ITEM_NOT_FOUND', message: `Capture item ${captureId} not found.` } };
    }
    return { status: 200, data: retried };
  }

  if (pathname.startsWith('/api/v1/workspace/items/') && !pathname.endsWith('/download') && !pathname.endsWith('/preview') && !pathname.endsWith('/action') && !pathname.endsWith('/retry') && !pathname.includes('/candidates/') && method === 'GET') {
    const captureId = pathname.slice('/api/v1/workspace/items/'.length);
    const ownerId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || 'ten_production_01';
    const item = await quickCaptureService.getCaptureItem(captureId, tenantId, ownerId);
    if (!item) {
      return { status: 404, data: { error: 'ITEM_NOT_FOUND', message: `Capture item ${captureId} not found.` } };
    }
    return { status: 200, data: item };
  }

  if (pathname.startsWith('/api/v1/workspace/items/') && method === 'DELETE') {
    const captureId = pathname.slice('/api/v1/workspace/items/'.length);
    const principalId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || 'ten_production_01';
    const deleted = await quickCaptureService.deleteCaptureItem(captureId, tenantId, principalId);
    return { status: 200, data: { success: deleted, captureId } };
  }

  if (pathname === '/api/v1/workspace/search' && method === 'GET') {
    const q = typeof query?.q === 'string' ? query.q.trim() : '';
    const results: Array<{ id: string; title: string; summary: string; sourceTypeBadge: string; sourceBadge: string; source: string; url?: string }> = [];

    if (q) {
      results.push({
        id: `sr_web_${Date.now()}`,
        title: `Web results for "${q}"`,
        summary: `Search index results matching query "${q}"`,
        sourceTypeBadge: '[Web]',
        sourceBadge: 'Web',
        source: 'WEB_SEARCH',
      });
      results.push({
        id: `sr_vlt_${Date.now()}`,
        title: `Vault document matching "${q}"`,
        summary: `Saved personal document containing "${q}"`,
        sourceTypeBadge: '[Vault]',
        sourceBadge: 'Vault',
        source: 'PERSONAL_VAULT',
      });
      results.push({
        id: `sr_mem_${Date.now()}`,
        title: `Memory preference: "${q}"`,
        summary: `User preference fact matching "${q}"`,
        sourceTypeBadge: '[Memory]',
        sourceBadge: 'Memory',
        source: 'MEMORY_ENGINE',
      });
    }

    return { status: 200, data: { query: q, results, total: results.length } };
  }

  return undefined;
};
