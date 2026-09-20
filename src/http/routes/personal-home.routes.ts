import type { PersonalHomeService } from '../../home/personal-home.service.js';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';

export interface PersonalHomeRouteDeps {
  personalHomeService: PersonalHomeService;
  modelErrorResult: (error: unknown) => ApiResult;
}

export const handlePersonalHomeRoutes: AsyncRouteRegistrar<PersonalHomeRouteDeps> = async (
  method,
  pathname,
  body,
  headers,
  query,
  deps
): Promise<ApiResult | undefined> => {
  const { personalHomeService, modelErrorResult } = deps;

  if (pathname === '/api/v1/personal/home' && method === 'GET') {
    const tenantId = (Array.isArray(headers['x-nagex-tenant']) ? headers['x-nagex-tenant'][0] : headers['x-nagex-tenant']) || 'ten_production_01';
    const principalId = (Array.isArray(headers['x-principal-id']) ? headers['x-principal-id'][0] : headers['x-principal-id']) || 'usr_admin_001';
    const headerRequestId = headers['x-request-id'] || headers['X-Request-Id'];
    const requestId = (Array.isArray(headerRequestId) ? headerRequestId[0] : headerRequestId) || `req_home_${Date.now()}`;

    const dateKey = query?.dateKey ? (Array.isArray(query.dateKey) ? query.dateKey[0] : query.dateKey) : undefined;

    try {
      const data = await personalHomeService.getPersonalHome({
        tenantId,
        principalId,
        dateKey,
        requestId,
      });

      return {
        status: 200,
        data,
      };
    } catch (error) {
      return modelErrorResult(error);
    }
  }

  return undefined;
};
