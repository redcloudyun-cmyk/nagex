import type { CreationRuntime } from '../../creation/creation-runtime.js';
import type { PresentationExecutor } from '../../creation/executors/presentation-executor.js';
import type { ArtifactVersionService } from '../../creation/artifact-version.service.js';
import type { PresentationStore } from '../../creation/presentation.store.js';
import { PRESENTATION_ID_PATTERN } from '../../creation/presentation.store.js';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';
import { detectRequestLanguage } from '../../common/request-language.js';
import { tryGetCallerIdentity } from '../request-identity.js';

export interface PresentationCreationRouteDeps {
  creationRuntime: CreationRuntime;
  presentationStore: PresentationStore;
  // optional so existing wiring keeps compiling; without it the revision route answers truthfully that revising is unavailable
  presentationExecutor?: PresentationExecutor;
  // R26-D: versions, comparison and restoration (optional; absent -> 503)
  versionService?: ArtifactVersionService;
}

function getHeaderValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

const STATUS_BY_CODE: Record<string, number> = {
  INVALID_PROMPT: 400,
  UNAUTHORIZED_REFERENCE: 404,
  NO_MODEL_PROVIDER_CONFIGURED: 503,
  NO_CREATION_PROVIDER_AVAILABLE: 503,
  PROVIDER_UNAVAILABLE: 503,
  PRESENTATION_NOT_FOUND: 404,
  INVALID_MODEL_RESPONSE: 502,
  EMPTY_GENERATION: 502,
};

/** A readable, header-safe download name: the deck title with path and control characters removed. */
export function downloadFileName(title: string): string {
  const base = String(title).replace(/[\u0000-\u001f\u007f"\\/:*?<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'presentation';
  return `${base}.pptx`;
}

export const handlePresentationCreationRoutes: AsyncRouteRegistrar<PresentationCreationRouteDeps> = async (
  method,
  pathname,
  body,
  headers,
  query,
  deps
): Promise<ApiResult | undefined> => {
  if (!pathname.startsWith('/api/v1/creations/presentations')) return undefined;
  const caller = tryGetCallerIdentity(headers);
  if (!caller) return undefined; // route-access.ts has already answered 401 for anonymous callers
  const { tenantId, principalId } = caller;
  const requestId = getHeaderValue(headers, 'x-request-id') || `req_pres_${Date.now()}`;

  if (pathname === '/api/v1/creations/presentations' && method === 'POST') {
    const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt) {
      return { status: 400, data: { error: 'INVALID_PROMPT', message: 'Presentation creation prompt is required.', request_id: requestId } };
    }
    const sourceArtifactIds = Array.isArray(body?.sourceArtifactIds) ? (body!.sourceArtifactIds as unknown[]).filter((id): id is string => typeof id === 'string' && id.length > 0).slice(0, 3) : [];
    const result = await deps.creationRuntime.create({
      creationKind: 'PRESENTATION',
      prompt,
      sourceRefs: sourceArtifactIds.map((id) => ({ type: 'ARTIFACT' as const, id })),
      options: {
        style: typeof body?.style === 'string' ? body.style : undefined,
        targetAudience: typeof body?.targetAudience === 'string' ? body.targetAudience : undefined,
        // an explicit locale wins; otherwise the deck follows the language of the request
        locale: body?.locale === 'ko' || body?.locale === 'en' ? body.locale : (detectRequestLanguage(prompt) === 'ko' ? 'ko' : 'en'),
        routingMode: typeof body?.routingMode === 'string' ? (body.routingMode as any) : undefined,
      },
      tenantId,
      ownerId: principalId,
      requestId,
    });
    if (result.status !== 'SUCCESS') {
      const code = result.errorCode || 'CREATION_FAILED';
      return { status: STATUS_BY_CODE[code] ?? 500, data: { error: code, message: result.errorMessage || 'Presentation creation failed.', request_id: requestId } };
    }
    return { status: 201, data: result };
  }

  // Revise one of the person's own decks: the answer is a NEW deck (the original is never changed). Unknown, malformed, foreign-tenant and foreign-owner ids are indistinguishable.
  const revisionMatch = pathname.match(/^\/api\/v1\/creations\/presentations\/([^/]+)\/revisions$/);
  if (revisionMatch && method === 'POST') {
    const instruction = typeof body?.instruction === 'string' ? body.instruction.trim() : '';
    if (!instruction) return { status: 400, data: { error: 'INVALID_INSTRUCTION', message: 'Revision instruction is required.', request_id: requestId } };
    if (!PRESENTATION_ID_PATTERN.test(revisionMatch[1])) return { status: 404, data: { error: 'PRESENTATION_NOT_FOUND', message: 'Presentation not found.', request_id: requestId } };
    if (!deps.presentationExecutor) return { status: 503, data: { error: 'PRESENTATION_REVISION_UNAVAILABLE', message: 'Revising a presentation is not available right now.', request_id: requestId } };
    const result = await deps.presentationExecutor.executeRevision({
      parentPresentationId: revisionMatch[1],
      instruction,
      tenantId,
      ownerId: principalId,
      requestId,
      locale: body?.locale === 'ko' || body?.locale === 'en' ? body.locale : (detectRequestLanguage(instruction) === 'ko' ? 'ko' : undefined),
      routingMode: typeof body?.routingMode === 'string' ? (body.routingMode as any) : undefined,
    });
    if (result.status !== 'SUCCESS') {
      const code = result.errorCode || 'REVISION_FAILED';
      return { status: STATUS_BY_CODE[code] ?? 500, data: { error: code, message: result.errorMessage || 'Presentation revision failed.', request_id: requestId } };
    }
    return { status: 201, data: result };
  }

  // ---- R26-D: versions of a deck. Unknown, malformed, foreign-tenant and foreign-owner ids are indistinguishable.
  const versionsMatch = pathname.match(/^\/api\/v1\/creations\/presentations\/([^/]+)\/(versions|compare|restore)$/);
  if (versionsMatch) {
    const [, presentationId, action] = versionsMatch;
    const missing: ApiResult = { status: 404, data: { error: 'PRESENTATION_NOT_FOUND', message: 'Presentation not found.', request_id: requestId } };
    if (!PRESENTATION_ID_PATTERN.test(presentationId)) return missing;
    if (!deps.versionService) return { status: 503, data: { error: 'VERSIONS_UNAVAILABLE', message: 'Version history is not available right now.', request_id: requestId } };
    if (action === 'versions' && method === 'GET') {
      const family = deps.versionService.listPresentationVersions(presentationId, tenantId, principalId);
      return family ? { status: 200, data: family } : missing;
    }
    if (action === 'compare' && method === 'GET') {
      const to = typeof query?.to === 'string' && query.to ? query.to : undefined;
      if (to !== undefined && !PRESENTATION_ID_PATTERN.test(to)) return missing;
      const result = deps.versionService.comparePresentations(presentationId, to, tenantId, principalId);
      if (result === 'NOT_FOUND') return missing;
      if (result === 'VERSIONS_NOT_RELATED') return { status: 400, data: { error: 'VERSIONS_NOT_RELATED', message: 'These two presentations are not versions of the same presentation.', request_id: requestId } };
      return { status: 200, data: { comparison: result } };
    }
    if (action === 'restore' && method === 'POST') {
      if (!deps.presentationExecutor) return { status: 503, data: { error: 'VERSIONS_UNAVAILABLE', message: 'Version history is not available right now.', request_id: requestId } };
      const restored = deps.presentationExecutor.restoreVersion({ sourcePresentationId: presentationId, tenantId, ownerId: principalId, requestId });
      if (restored.status === 'SUCCESS') return { status: 201, data: restored };
      const status = restored.errorCode === 'PRESENTATION_NOT_FOUND' ? 404 : restored.errorCode === 'VERSION_ALREADY_CURRENT' ? 409 : restored.errorCode === 'PRESENTATION_FILE_MISSING' ? 410 : 500;
      return { status, data: { error: restored.errorCode || 'RESTORE_FAILED', message: restored.errorMessage || 'The version could not be restored.', request_id: requestId } };
    }
  }

  const match = pathname.match(/^\/api\/v1\/creations\/presentations\/([^/]+)(\/download)?$/);
  if (match && method === 'GET') {
    const presentationId = match[1];
    const notFound: ApiResult = { status: 404, data: { error: 'PRESENTATION_NOT_FOUND', message: 'Presentation not found.', request_id: requestId } };
    // unknown id, malformed id, foreign tenant and foreign owner are indistinguishable
    if (!PRESENTATION_ID_PATTERN.test(presentationId)) return notFound;
    const record = deps.presentationStore.get(presentationId, tenantId, principalId);
    if (!record) return notFound;

    if (match[2]) {
      const bytes = deps.presentationStore.getBinary(record.binaryStoragePath);
      if (!bytes || bytes.length === 0) return notFound; // a record whose file is gone is not a download
      const fileName = downloadFileName(record.title);
      return {
        status: 200,
        data: bytes,
        contentType: record.mimeType,
        isBinary: true,
        headers: {
          'Content-Disposition': `attachment; filename="presentation.pptx"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      };
    }

    return {
      status: 200,
      data: {
        presentation: {
          presentationId: record.presentationId,
          title: record.title,
          subtitle: record.subtitle,
          summary: record.summary,
          locale: record.locale,
          slides: record.slides,
          byteLength: record.byteLength,
          artifactId: record.artifactId || null,
          parentPresentationId: record.parentPresentationId || null,
          revisionIndex: record.revisionIndex ?? 1,
          downloadTarget: `/api/v1/creations/presentations/${record.presentationId}/download`,
          createdAt: record.createdAt,
        },
        request_id: requestId,
      },
    };
  }

  return undefined;
};
