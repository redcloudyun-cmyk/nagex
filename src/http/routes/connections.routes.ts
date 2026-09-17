// R18 — Connected Apps HTTP Route Module
import { DEFAULT_GOOGLE_TENANT_ID } from '../../integrations/google/token.store.js';
import type { ConnectionStore } from '../../workspace/connections.store.js';
import type { ConnectionProvider } from '../../workspace/connections.types.js';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';

function getHeaderValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export interface ConnectionsRouteDeps {
  connectionStore: ConnectionStore;
}

export const handleConnectionsRoutes: AsyncRouteRegistrar<ConnectionsRouteDeps> = async (method, pathname, body, headers, _query, deps): Promise<ApiResult | undefined> => {
  const { connectionStore } = deps;
  const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
  const userId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';

  if (pathname === '/api/v1/connections' && method === 'GET') {
    const connections = connectionStore.listConnections(tenantId, userId);
    return { status: 200, data: { connections, total: connections.length } };
  }

  if (pathname.startsWith('/api/v1/connections/') && pathname.endsWith('/disconnect') && method === 'POST') {
    const provider = pathname.slice('/api/v1/connections/'.length, pathname.length - '/disconnect'.length) as ConnectionProvider;
    const record = connectionStore.disconnect(tenantId, userId, provider);
    return { status: 200, data: record };
  }

  if (pathname.startsWith('/api/v1/connections/') && pathname.endsWith('/sync') && method === 'POST') {
    const provider = pathname.slice('/api/v1/connections/'.length, pathname.length - '/sync'.length) as ConnectionProvider;
    const record = connectionStore.updateConnection({
      tenantId,
      userId,
      provider,
      status: 'CONNECTED',
      syncCursor: `cursor_${Date.now()}`,
    });
    return { status: 200, data: record };
  }

  return undefined;
};
