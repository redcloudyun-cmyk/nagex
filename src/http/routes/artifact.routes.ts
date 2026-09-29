import type { ArtifactStore } from '../../artifacts/artifact.store.js';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';

export const handleArtifactRoutes: AsyncRouteRegistrar<{ artifactStore: ArtifactStore }> = async (method, pathname, _body, headers, query, deps): Promise<ApiResult | undefined> => {
  const tenantId = String(headers['x-nagex-tenant'] || 'ten_production_01');
  const ownerId = String(headers['x-principal-id'] || 'usr_admin_001');
  if (pathname === '/api/v1/artifacts' && method === 'GET') {
    return { status: 200, data: { artifacts: deps.artifactStore.list(tenantId, ownerId, Number(query.limit) || 20) } };
  }
  if (pathname.startsWith('/api/v1/artifacts/') && method === 'GET') {
    const artifactId = pathname.slice('/api/v1/artifacts/'.length);
    const artifact = deps.artifactStore.get(artifactId, tenantId, ownerId);
    return artifact ? { status: 200, data: { artifact } } : { status: 404, data: { error: 'ARTIFACT_NOT_FOUND' } };
  }
  return undefined;
};
