import { NagexError } from '../../common/errors.js';
import type { ProductBuilderService } from '../../product-builder/product-builder.service.js';
import { PREVIEW_RESPONSE_HEADERS, type PreviewLinkSigner } from '../../product-builder/product-preview-link.js';
import type { ProjectGate } from '../../product-builder/product-builder.types.js';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';
import { tryGetCallerIdentity } from '../request-identity.js';

// AI Product Builder: "build me this website, show me, and put it online" - with the person deciding at four gates.
//
//   GET  /api/v1/product-builder/capability                              what NAgex can really do here (planning model, image providers, coding engine, test runner, hosting)
//   POST /api/v1/product-builder/projects                                start a project from the person's own words; answered at once, the project goes on in the background
//   GET  /api/v1/product-builder/projects                                the caller's projects
//   GET  /api/v1/product-builder/projects/:id                            the project: state, the artifact waiting for a decision, blockers, test results, the deployment
//   POST /api/v1/product-builder/projects/:id/gates/:gate/(approve|decline|revise)    the person's decision at PLAN | DESIGN | BUILD | DEPLOY
//   POST /api/v1/product-builder/projects/:id/deploy-request             ask to put the tested preview online (this only asks: nothing is deployed until Gate 4 is approved)
//   POST /api/v1/product-builder/projects/:id/resolve                    continue after a blocker the person resolved (optionally choosing another authorized image provider)
//   POST /api/v1/product-builder/projects/:id/cancel
//   GET  /api/v1/product-builder/projects/:id/mockups/:file              a mockup picture (owner only)
//   GET  /api/v1/product-builder/projects/:id/screenshots/:file          a picture from the isolated test run (owner only)
//   POST /api/v1/product-builder/projects/:id/preview-link               a short-lived signed link to the sandboxed preview of the current build
//   GET  /api/v1/product-builder/preview/:token/*                        the sandboxed preview itself (the signed link is the credential; generated content, served under a sandbox CSP)
//
// Every route except the preview is owner-scoped (another person's project is the same 404 as one that does not exist). A decision is the signed-in owner's own act on the approval that gate holds.

export interface ProductBuilderRouteDeps {
  productBuilderService?: ProductBuilderService;
  previewSigner?: PreviewLinkSigner;
}

function getHeaderValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

const STATUS_BY_CODE: Record<string, number> = {
  PRODUCT_REQUEST_REQUIRED: 400,
  PRODUCT_REQUEST_TOO_LONG: 400,
  PRODUCT_FEEDBACK_REQUIRED: 400,
  PRODUCT_MOCKUP_PROVIDER_UNKNOWN: 400,
  PRODUCT_PLAN_INVALID: 422,
  PRODUCT_PROJECT_NOT_FOUND: 404,
  PRODUCT_GATE_NOT_WAITING: 409,
  PRODUCT_NOT_BLOCKED: 409,
  PRODUCT_NOT_READY_FOR_DEPLOY: 409,
  PRODUCT_DEPLOY_NOT_CONFIGURED: 409,
  PRODUCT_TOO_MANY_ACTIVE: 409,
  PRODUCT_BUILDER_UNAVAILABLE: 503,
  PRODUCT_PLANNER_UNAVAILABLE: 503,
  APPROVAL_NOT_FOUND: 404,
  APPROVAL_EXPIRED: 410,
  APPROVAL_NOT_PENDING: 409,
};

const GATES: readonly string[] = ['PLAN', 'DESIGN', 'BUILD', 'DEPLOY'];
const PROJECT_ID = /^pbp_[0-9a-f]{12,}$/;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/;

function failure(error: unknown, requestId: string): ApiResult {
  if (error instanceof NagexError) {
    const status = STATUS_BY_CODE[error.code] ?? (error.category === 'VALIDATION' ? 400 : error.category === 'NOT_FOUND' ? 404 : error.category === 'CONFLICT' ? 409 : error.category === 'POLICY' ? 403 : 500);
    return { status, data: { error: error.code, message: error.message, request_id: requestId, ...(error.details ? { details: error.details } : {}) } };
  }
  throw error;
}

const notFound = (requestId: string): ApiResult => ({ status: 404, data: { error: 'PRODUCT_PROJECT_NOT_FOUND', message: 'No such project.', request_id: requestId } });

export const handleProductBuilderRoutes: AsyncRouteRegistrar<ProductBuilderRouteDeps> = async (method, pathname, body, headers, _query, deps): Promise<ApiResult | undefined> => {
  if (!pathname.startsWith('/api/v1/product-builder/')) return undefined;
  const requestId = getHeaderValue(headers, 'x-request-id') || `req_pb_${Date.now()}`;

  // ---- the sandboxed preview: authorised by the signed link, not by a session ----------------------------------------------------------------------------------------------------------------
  const previewMatch = /^\/api\/v1\/product-builder\/preview\/([^/]+)\/(.*)$/.exec(pathname);
  if (previewMatch) {
    if (method !== 'GET' && method !== 'HEAD') return { status: 405, data: { error: 'METHOD_NOT_ALLOWED', message: 'Method not allowed.', request_id: requestId } };
    const claims = deps.previewSigner?.verify(decodeURIComponent(previewMatch[1])) ?? null;
    let relative = '';
    try { relative = decodeURIComponent(previewMatch[2]); } catch { relative = '\0'; }
    const file = claims && deps.productBuilderService ? deps.productBuilderService.readPreviewFile(claims.projectId, claims.tenantId, claims.ownerId, claims.workspaceId, relative) : null;
    if (!claims || !file) return { status: 404, data: Buffer.from('Not found'), contentType: 'text/plain; charset=utf-8', isBinary: true, headers: { ...PREVIEW_RESPONSE_HEADERS } };
    return { status: 200, data: method === 'HEAD' ? Buffer.alloc(0) : file.data, contentType: file.contentType, isBinary: true, headers: { ...PREVIEW_RESPONSE_HEADERS } };
  }

  const caller = tryGetCallerIdentity(headers);
  if (!caller) return undefined; // route-access.ts has already answered 401 for anonymous callers
  const identity = { tenantId: caller.tenantId, ownerId: caller.principalId };
  const service = deps.productBuilderService;

  if (pathname === '/api/v1/product-builder/capability' && method === 'GET') {
    return { status: 200, data: service ? { ...service.capability() } : { available: false, planning: false, mockups: [], engine: null, tester: null, deployers: [], verifier: false } };
  }
  if (!service) {
    return { status: 503, data: { error: 'PRODUCT_BUILDER_UNAVAILABLE', message: 'NAgex cannot build products here: no planning model is configured.', request_id: requestId } };
  }

  try {
    if (pathname === '/api/v1/product-builder/projects' && method === 'POST') {
      const locale = body?.locale === 'ko' ? 'ko' : 'en';
      const record = service.createProject(identity, { request: typeof body?.request === 'string' ? body.request : '', locale, requestId });
      service.kick(record.projectId);
      return { status: 202, data: { project: service.viewOf(record) } };
    }
    if (pathname === '/api/v1/product-builder/projects' && method === 'GET') {
      return { status: 200, data: { projects: service.list(identity).map((r) => service.view(r.projectId, identity)!) } };
    }

    const match = /^\/api\/v1\/product-builder\/projects\/([^/]+)(?:\/(.+))?$/.exec(pathname);
    if (!match) return { status: 404, data: { error: 'NOT_FOUND', message: 'Not found.', request_id: requestId } };
    const projectId = decodeURIComponent(match[1]);
    const rest = match[2] ?? '';
    if (!PROJECT_ID.test(projectId)) return notFound(requestId);

    if (rest === '' && method === 'GET') {
      const view = service.view(projectId, identity);
      return view ? { status: 200, data: { project: view } } : notFound(requestId);
    }

    const picture = /^(mockups|screenshots)\/([^/]+)$/.exec(rest);
    if (picture && method === 'GET') {
      const fileName = decodeURIComponent(picture[2]);
      if (!FILE_NAME.test(fileName)) return notFound(requestId);
      const found = picture[1] === 'mockups' ? service.readMockup(projectId, identity, fileName) : (() => { const data = service.readScreenshot(projectId, identity, fileName); return data ? { data, mimeType: 'image/png' } : null; })();
      if (!found) return notFound(requestId);
      return { status: 200, data: found.data, contentType: found.mimeType, isBinary: true, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } };
    }

    if (rest === 'preview-link' && method === 'POST') {
      // someone else's project is the same 404 as one that does not exist - never a different answer that would show it is there
      if (!service.get(projectId, identity)) return notFound(requestId);
      const workspaceId = service.previewWorkspaceId(projectId, identity);
      if (!workspaceId || !deps.previewSigner) return { status: 409, data: { error: 'PRODUCT_NO_PREVIEW', message: 'There is no built preview to show yet.', request_id: requestId } };
      const link = deps.previewSigner.issue({ projectId, workspaceId, tenantId: identity.tenantId, ownerId: identity.ownerId });
      return { status: 200, data: { url: `/api/v1/product-builder/preview/${link.token}/`, expiresAt: link.expiresAt } };
    }

    const gateMatch = /^gates\/([A-Z]+)\/(approve|decline|revise)$/.exec(rest);
    if (gateMatch && method === 'POST') {
      if (!GATES.includes(gateMatch[1])) return { status: 400, data: { error: 'PRODUCT_GATE_UNKNOWN', message: 'Unknown decision.', request_id: requestId } };
      const gate = gateMatch[1] as ProjectGate;
      const record = gateMatch[2] === 'revise'
        ? await service.revise(projectId, identity, gate, typeof body?.feedback === 'string' ? body.feedback : '', requestId, { wait: false })
        : await service.decide(projectId, identity, gate, gateMatch[2] === 'approve' ? 'APPROVE' : 'DECLINE', requestId, { wait: false });
      return { status: 200, data: { project: service.viewOf(record) } };
    }

    if (rest === 'deploy-request' && method === 'POST') {
      const record = service.requestDeploy(projectId, identity, {
        requestId,
        ...(typeof body?.appName === 'string' ? { appName: body.appName } : {}),
        ...(typeof body?.adapterId === 'string' ? { adapterId: body.adapterId } : {}),
      });
      return { status: 200, data: { project: service.viewOf(record) } };
    }

    if (rest === 'resolve' && method === 'POST') {
      const record = await service.resolveBlocker(projectId, identity, { requestId, wait: false, ...(typeof body?.mockupProviderId === 'string' ? { mockupProviderId: body.mockupProviderId } : {}) });
      return { status: 200, data: { project: service.viewOf(record) } };
    }

    if (rest === 'cancel' && method === 'POST') {
      return { status: 200, data: { project: service.viewOf(service.cancel(projectId, identity, requestId)) } };
    }
  } catch (error) {
    return failure(error, requestId);
  }

  return { status: 405, data: { error: 'METHOD_NOT_ALLOWED', message: 'Method not allowed.', request_id: requestId } };
};
