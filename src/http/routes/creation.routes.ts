// R17 — Creation HTTP Route Module
import { DEFAULT_GOOGLE_TENANT_ID } from '../../integrations/google/token.store.js';
import { NagexError } from '../../common/errors.js';
import type { CreationService } from '../../creation/creation.service.js';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';

import type { ImageExecutor } from '../../creation/executors/image-executor.js';

function getHeaderValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export interface CreationRouteDeps {
  creationService: CreationService;
  imageExecutor?: ImageExecutor;
}

export const handleCreationRoutes: AsyncRouteRegistrar<CreationRouteDeps> = async (method, pathname, body, headers, query, deps): Promise<ApiResult | undefined> => {
  const { creationService, imageExecutor } = deps;

  if (pathname === '/api/v1/creations/generate' && method === 'POST') {
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
    const principalId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
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
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
    const principalId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';

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
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
    const principalId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
    const limit = Number(query.limit) || 50;

    const creations = creationService.listCreations(tenantId, principalId, limit);
    return { status: 200, data: { creations } };
  }

  if (pathname.startsWith('/api/v1/creations/') && method === 'GET') {
    const creationId = pathname.slice('/api/v1/creations/'.length);
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
    const principalId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';

    const creation = creationService.getCreation(creationId, tenantId, principalId);
    if (!creation) {
      return { status: 404, data: { error: 'CREATION_NOT_FOUND', message: `Creation ${creationId} not found.` } };
    }
    const lineage = creationService.getLineage(creation.parentCreationId || creation.creationId, tenantId, principalId);
    return { status: 200, data: { creation, lineage } };
  }

  return undefined;
};
