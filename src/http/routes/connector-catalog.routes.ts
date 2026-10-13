// GET /api/v1/connectors/catalog - the normalized connector catalog with the signed-in user's REAL connection state. Identity comes only from the
// verified session; the catalog itself is static metadata and the state is read from the stores that own it (see connector-catalog.service.ts).
import type { IdentityStore } from '../../identity/identity.store.js';
import type { SessionStore } from '../../sessions/session.store.js';
import type { ConnectorCatalogService } from '../../connectors/connector-catalog.service.js';
import { resolveAuthenticatedIdentity } from '../request-identity.js';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';

export interface ConnectorCatalogRouteDeps {
  sessionStore: SessionStore;
  identityStore: IdentityStore;
  connectorCatalog?: ConnectorCatalogService;
}

export const handleConnectorCatalogRoutes: AsyncRouteRegistrar<ConnectorCatalogRouteDeps> = async (method, pathname, _body, headers, _query, deps): Promise<ApiResult | undefined> => {
  if (pathname === '/api/v1/connectors/catalog' && method === 'GET') {
    const owner = resolveAuthenticatedIdentity(headers, deps);
    if (!owner) return { status: 401, data: { error: { code: 'UNAUTHORIZED', message: 'Sign in to see your connected apps.' } } };
    if (!deps.connectorCatalog) return { status: 503, data: { error: { code: 'CONNECTOR_CATALOG_NOT_AVAILABLE', message: 'The connector catalog is not available.' } } };
    const catalog = await deps.connectorCatalog.resolve({ tenantId: owner.tenantId, principalId: owner.principalId });
    return { status: 200, data: catalog };
  }
  return undefined;
};
