// R17 — Creation HTTP Route Module
import { DEFAULT_GOOGLE_TENANT_ID } from '../../integrations/google/token.store.js';
import { NagexError } from '../../common/errors.js';
import type { CreationService } from '../../creation/creation.service.js';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';

function getHeaderValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export interface CreationRouteDeps {
  creationService: CreationService;
}

export const handleCreationRoutes: AsyncRouteRegistrar<CreationRouteDeps> = async (method, pathname, body, headers, query, deps): Promise<ApiResult | undefined> => {
  const { creationService } = deps;

  if (pathname === '/api/v1/creations/generate' && method === 'POST') {
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
    const principalId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_cr_${Date.now()}`;
    const prompt = typeof body?.prompt === 'string' ? body.prompt : '';

    if (!prompt.trim()) {
      throw new NagexError({ code: 'PROMPT_REQUIRED', category: 'VALIDATION', message: 'prompt parameter is required for creation.', request_id: requestId });
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
