// R17 — Creation HTTP Route Module
import { NagexError } from '../../common/errors.js';
import type { CreationService } from '../../creation/creation.service.js';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';

import type { ImageExecutor } from '../../creation/executors/image-executor.js';
// R23.7C-C — canonical image-serving route. Reuses the exact ImageStore
// instance ImageExecutor writes through (see create-nagex-application.ts)
// and its existing tenant/owner authorization (ImageStore.get()) — no new
// or duplicated authorization logic.
import type { ImageStore, ImageRecord } from '../../creation/image.store.js';
// R23.7C-C — shared identity resolver: a real nagex_session cookie (when
// present and valid) takes precedence over X-NAgex-Tenant/X-Principal-Id
// headers for the two routes that must agree on identity (generate and
// image GET), so a native <img> request and its originating POST resolve
// to the same real user. See src/http/request-identity.ts for the full
// rationale.
import { resolveRequestIdentity } from '../request-identity.js';
import type { SessionStore } from '../../sessions/session.store.js';

function getHeaderValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

// R23.7C-C — canonical desktop creation-history fix. A real IMAGE creation
// (type==='IMAGE' in the generate handler above) is never written to
// CreationStore — it lives only in ImageStore (domain-owning record) and
// is thinly projected into ArtifactStore for cross-domain surfaces like
// Personal Home's Recent Creations. GET /api/v1/creations previously read
// CreationStore exclusively, so a completed image could never appear in
// the Studio's own #create-history-list — this is the exact
// historyVisibilityDesktop=FAIL root cause. This projects the real
// ImageRecord (not ArtifactStore's lossy preview, which embeds the
// provider id and would leak it into consumer UI) into the same response
// shape the frontend already expects from a CreationRecord. No new store,
// no dual-write: ImageStore remains the single source of truth for image
// domain data, merged at the HTTP-response boundary only.
function imageRecordToCreationListItem(img: ImageRecord): Record<string, unknown> {
  const canonicalUrl = `/api/v1/creations/images/${img.imageId}`;
  return {
    creationId: img.imageId,
    tenantId: img.tenantId,
    ownerId: img.ownerId,
    type: 'IMAGE',
    status: 'COMPLETED',
    prompt: img.prompt,
    recipe: { stylePreset: img.style, aspectRatio: img.aspectRatio },
    imageUrl: canonicalUrl,
    outputAssetUrl: canonicalUrl,
    thumbnailUrl: canonicalUrl,
    mimeType: img.mimeType,
    parentCreationId: img.parentImageId,
    artifactId: img.artifactId,
    createdAt: img.createdAt,
    updatedAt: img.updatedAt,
  };
}

export interface CreationRouteDeps {
  creationService: CreationService;
  imageExecutor?: ImageExecutor;
  // R23.7C-C — optional so existing test harnesses that never touch the
  // image-serving route (e.g. test 19's mockCreationService setup) keep
  // working unmodified; the route itself fails closed (503-equivalent,
  // never a fake 200) if this is unset while imageExecutor is configured.
  imageStore?: ImageStore;
  // R23.7C-C — optional so existing test harnesses that never wire session
  // identity keep working unmodified via the existing header/default
  // fallback in resolveRequestIdentity().
  sessionStore?: SessionStore;
}

export const handleCreationRoutes: AsyncRouteRegistrar<CreationRouteDeps> = async (method, pathname, body, headers, query, deps): Promise<ApiResult | undefined> => {
  const { creationService, imageExecutor, imageStore, sessionStore } = deps;

  if (pathname === '/api/v1/creations/generate' && method === 'POST') {
    const { tenantId, principalId } = resolveRequestIdentity(headers, { sessionStore });
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_cr_${Date.now()}`;
    const prompt = typeof body?.prompt === 'string' ? body.prompt : '';

    if (!prompt.trim()) {
      throw new NagexError({ code: 'PROMPT_REQUIRED', category: 'VALIDATION', message: 'prompt parameter is required for creation.', request_id: requestId });
    }

    if ((body?.recipe as any)?.type === 'IMAGE' || body?.creationKind === 'IMAGE' || body?.type === 'IMAGE') {
      if (!imageExecutor) {
        throw new NagexError({ code: 'UNAVAILABLE', category: 'INTERNAL', message: 'Image executor not available.', request_id: requestId });
      }

      const result = await imageExecutor.execute({
        creationKind: 'IMAGE',
        prompt,
        sourceRefs: body?.sourceRefs as any,
        options: {
          style: (body?.recipe as any)?.style || (body?.recipe as any)?.stylePreset,
          aspectRatio: (body?.recipe as any)?.aspectRatio,
          transparentBackground: (body?.recipe as any)?.transparentBackground,
          locale: (body?.recipe as any)?.locale,
        },
        tenantId,
        ownerId: principalId,
        requestId,
      });

      if (result.status === 'FAILED' || result.status === 'UNAVAILABLE' || !result.artifactId) {
        return { status: 400, data: { status: result.status, error: result.errorCode, message: result.errorMessage } };
      }

      // Convert result to legacy format expected by UI if needed, or return raw result
      const creation = {
        creationId: result.creationId,
        tenantId,
        ownerId: principalId,
        type: 'TEXT_TO_IMAGE',
        status: 'COMPLETED',
        prompt,
        recipe: body?.recipe as any,
        imageUrl: result.openTarget,
        outputAssetUrl: result.openTarget,
        thumbnailUrl: result.openTarget,
        mimeType: result.mimeType,
        createdAt: result.createdAt,
        updatedAt: result.createdAt,
        artifactId: result.artifactId,
      };

      return { status: 201, data: creation };
    }

    const creation = await creationService.generateCreation({
      tenantId,
      ownerId: principalId,
      prompt,
      recipe: body?.recipe as any,
      referenceImageId: typeof body?.referenceImageId === 'string' ? body.referenceImageId : undefined,
      parentCreationId: typeof body?.parentCreationId === 'string' ? body.parentCreationId : undefined,
    });

    return { status: 201, data: creation };
  }

  if (pathname.startsWith('/api/v1/creations/') && pathname.endsWith('/variation') && method === 'POST') {
    const parentCreationId = pathname.slice('/api/v1/creations/'.length, pathname.length - '/variation'.length);
    const { tenantId, principalId } = resolveRequestIdentity(headers, { sessionStore });

    try {
      if (imageExecutor) {
        // Since we don't have creation type in the payload reliably for variations,
        // we can try fetching from ImageStore inside executeRevision or just route to imageExecutor
        // but imageExecutor.executeRevision will throw if it's not found in ImageStore.
        try {
          const result = await imageExecutor.executeRevision({
            parentImageId: parentCreationId,
            instruction: (typeof body?.promptModifier === 'string' ? body.promptModifier : typeof body?.prompt === 'string' ? body.prompt : ''),
            tenantId,
            ownerId: principalId,
            requestId: getHeaderValue(headers, 'x-request-id') || `req_cr_${Date.now()}`,
          });

          if (result.errorCode !== 'IMAGE_NOT_FOUND') {
            if (result.status === 'FAILED' || result.status === 'UNAVAILABLE' || !result.artifactId) {
              return { status: 400, data: { status: result.status, error: result.errorCode, message: result.errorMessage } };
            }

            return { status: 201, data: {
              creationId: result.creationId,
              tenantId,
              ownerId: principalId,
              type: 'IMAGE',
              prompt: result.title || '',
              status: 'COMPLETED',
              imageUrl: result.openTarget,
              outputAssetUrl: result.openTarget,
              thumbnailUrl: result.openTarget,
              mimeType: result.mimeType,
              createdAt: result.createdAt,
              updatedAt: result.createdAt,
              artifactId: result.artifactId,
            } };
          }
        } catch (imageErr: any) {
          // Fall through to creationService
        }
      }

      const variation = await creationService.generateVariation({
        tenantId,
        ownerId: principalId,
        parentCreationId,
        promptModifier: typeof body?.promptModifier === 'string' ? body.promptModifier : undefined,
        recipeOverrides: body?.recipeOverrides as any,
      });
      return { status: 201, data: variation };
    } catch (err: any) {
      if (err.message?.includes('CREATION_NOT_FOUND')) {
        return { status: 404, data: { error: 'CREATION_NOT_FOUND', message: `Creation ${parentCreationId} not found.` } };
      }
      throw err;
    }
  }

  if (pathname === '/api/v1/creations' && method === 'GET') {
    const { tenantId, principalId } = resolveRequestIdentity(headers, { sessionStore });
    const limit = Number(query.limit) || 50;

    // Merge the two domain-owned stores at the response boundary: legacy/
    // text creations from CreationStore, real images from ImageStore.
    // Their id namespaces (cr_ / img_) never overlap, so no duplicate
    // representation of the same creation can occur — both are already
    // tenant+owner filtered by their own store, and the merge only
    // re-sorts and truncates to `limit`, it does not re-check authorization.
    const textCreations = creationService.listCreations(tenantId, principalId, limit);
    const imageCreations = imageStore ? imageStore.list(tenantId, principalId, limit).map(imageRecordToCreationListItem) : [];
    const creations = [...textCreations, ...imageCreations]
      .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, limit);
    return { status: 200, data: { creations } };
  }

  // R23.7C-C — canonical image-serving route. Must be checked before the
  // generic '/api/v1/creations/:id' handler below, or that handler
  // absorbs this path (treating "images/<id>" as a literal creationId
  // and 404ing against the wrong store) — this was the exact root cause
  // of the BROKEN_SUCCESS_CONTRACT this route fixes.
  if (pathname.startsWith('/api/v1/creations/images/') && method === 'GET') {
    const imageId = pathname.slice('/api/v1/creations/images/'.length);
    // R23.7C-C — same resolver as the generate route above: a native
    // same-origin <img> request carries the nagex_session cookie
    // automatically, so a real logged-in user's own images resolve without
    // any custom JS header. Callers with no valid session fall back to the
    // existing header/default behavior unchanged.
    const { tenantId, principalId } = resolveRequestIdentity(headers, { sessionStore });
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_img_${Date.now()}`;

    if (!imageStore) {
      throw new NagexError({ code: 'IMAGE_SERVING_UNAVAILABLE', category: 'INTERNAL', message: 'Image serving is not configured on this server.', request_id: requestId });
    }
    if (!imageId) {
      return { status: 404, data: { error: 'IMAGE_NOT_FOUND', message: 'Image not found.' } };
    }

    // Reuses ImageStore.get()'s existing strict tenant+owner equality
    // check unchanged — a wrong tenant, wrong owner, and a genuinely
    // unknown imageId are all indistinguishable from this route's
    // perspective, all producing the identical 404 below. Never a
    // separate "exists but not yours" response that would disclose
    // existence to an unauthorized caller.
    const imageRecord = imageStore.get(imageId, tenantId, principalId);
    if (!imageRecord) {
      return { status: 404, data: { error: 'IMAGE_NOT_FOUND', message: 'Image not found.' } };
    }

    const binary = imageStore.getBinary(imageRecord.binaryStoragePath);
    if (!binary || binary.length === 0) {
      // A real, authorized record exists but its binary is missing —
      // truthful 404, never a fabricated 200 with empty/wrong bytes, and
      // never a filesystem path or provider URL in the response.
      return { status: 404, data: { error: 'IMAGE_NOT_FOUND', message: 'Image not found.' } };
    }

    return { status: 200, data: binary, contentType: imageRecord.mimeType, isBinary: true };
  }

  if (pathname.startsWith('/api/v1/creations/') && method === 'GET') {
    const creationId = pathname.slice('/api/v1/creations/'.length);
    const { tenantId, principalId } = resolveRequestIdentity(headers, { sessionStore });

    const creation = creationService.getCreation(creationId, tenantId, principalId);
    if (creation) {
      const lineage = creationService.getLineage(creation.parentCreationId || creation.creationId, tenantId, principalId);
      return { status: 200, data: { creation, lineage } };
    }

    // Not a CreationStore record — check whether it is a real image
    // (clicking a history card built from imageRecordToCreationListItem
    // above calls this same generic GET with an img_ id). Reuses
    // ImageStore.get()'s existing tenant+owner authorization unchanged.
    if (imageStore) {
      const imageRecord = imageStore.get(creationId, tenantId, principalId);
      if (imageRecord) {
        const lineage = imageStore.getLineage(imageRecord.parentImageId || imageRecord.imageId, tenantId, principalId).map(imageRecordToCreationListItem);
        return { status: 200, data: { creation: imageRecordToCreationListItem(imageRecord), lineage } };
      }
    }

    return { status: 404, data: { error: 'CREATION_NOT_FOUND', message: `Creation ${creationId} not found.` } };
  }

  return undefined;
};
