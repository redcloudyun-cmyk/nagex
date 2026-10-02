// R18 — Connected Apps HTTP Route Module
//
// R24.6C — identity comes ONLY from the authenticated session (never the
// X-Principal-Id / X-NAgex-Tenant headers): the same owner the OAuth routes
// use, so this path and /api/v1/oauth/google/status cannot diverge.
//
// R24.6B — this is a compatibility read path, NOT a second source of truth.
// The Google connection's canonical owner is googleTokenStore (durable,
// encrypted, per-principal; surfaced by GET /api/v1/oauth/google/status and
// mutated only by /api/v1/oauth/google/{start,callback,disconnect}). The
// in-memory ConnectionStore row for 'google' used to be an independent
// mutable copy (always DISCONNECTED after a restart, and POST .../sync could
// mark it CONNECTED with no real connection). Now:
//   - GET reports the google status derived from googleTokenStore;
//   - google disconnect delegates to googleTokenStore.revokeForPrincipal (the
//     same canonical writer POST /api/v1/oauth/google/disconnect uses) and
//     reports the resulting canonical state — it never edits a local copy;
//   - google sync is rejected (nothing to sync; state is owned by OAuth);
//   - sync for a provider with no real integration is rejected instead of
//     fabricating CONNECTED.
import crypto from 'node:crypto';
import type { AuditLogger } from '../../governance/audit.logger.js';
import { googleTokenStore } from '../../integrations/google/token.store.js';
import type { IdentityStore } from '../../identity/identity.store.js';
import type { SessionStore } from '../../sessions/session.store.js';
import { resolveAuthenticatedIdentity } from '../request-identity.js';
import type { ConnectionStore } from '../../workspace/connections.store.js';
import type { AppConnectionRecord, ConnectionProvider } from '../../workspace/connections.types.js';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';

function getHeaderValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export interface ConnectionsRouteDeps {
  connectionStore: ConnectionStore;
  auditLogger?: AuditLogger;
  sessionStore: SessionStore;
  identityStore: IdentityStore;
}

function withCanonicalStatus(record: AppConnectionRecord, tenantId: string, userId: string): AppConnectionRecord {
  if (record.provider !== 'google') return record;
  const connected = googleTokenStore.getStatusForPrincipal(tenantId, userId).connected;
  return { ...record, status: connected ? 'CONNECTED' : 'DISCONNECTED' };
}

export const handleConnectionsRoutes: AsyncRouteRegistrar<ConnectionsRouteDeps> = async (method, pathname, _body, headers, _query, deps): Promise<ApiResult | undefined> => {
  const { connectionStore, auditLogger } = deps;
  if (!pathname.startsWith('/api/v1/connections')) return undefined;
  const owner = resolveAuthenticatedIdentity(headers, deps);
  if (!owner) return { status: 401, data: { error: { code: 'UNAUTHORIZED', message: 'Sign in to view or manage connected apps.' } } };
  const tenantId = owner.tenantId;
  const userId = owner.principalId;

  if (pathname === '/api/v1/connections' && method === 'GET') {
    const connections = connectionStore.listConnections(tenantId, userId).map((r) => withCanonicalStatus(r, tenantId, userId));
    return { status: 200, data: { connections, total: connections.length } };
  }

  if (pathname.startsWith('/api/v1/connections/') && pathname.endsWith('/disconnect') && method === 'POST') {
    const provider = pathname.slice('/api/v1/connections/'.length, pathname.length - '/disconnect'.length) as ConnectionProvider;
    if (provider === 'google') {
      const requestId = getHeaderValue(headers, 'x-request-id') || `req_conn_${crypto.randomUUID()}`;
      await googleTokenStore.revokeForPrincipal(tenantId, userId, fetch, requestId);
      auditLogger?.logEvent({ actor: { type: 'user', id: userId }, tenant_id: tenantId, action: 'oauth:google_disconnected', resource: { type: 'OAuthConnection', id: 'google_calendar' }, result: 'SUCCESS', request_id: requestId });
      return { status: 200, data: withCanonicalStatus(connectionStore.disconnect(tenantId, userId, provider), tenantId, userId) };
    }
    const record = connectionStore.disconnect(tenantId, userId, provider);
    return { status: 200, data: record };
  }

  if (pathname.startsWith('/api/v1/connections/') && pathname.endsWith('/sync') && method === 'POST') {
    const provider = pathname.slice('/api/v1/connections/'.length, pathname.length - '/sync'.length) as ConnectionProvider;
    if (provider === 'google') {
      return { status: 409, data: { error: { code: 'CONNECTION_MANAGED_BY_OAUTH', message: 'Google connection state is owned by the OAuth connection; there is nothing to sync here.' } } };
    }
    return { status: 501, data: { error: { code: 'PROVIDER_SYNC_NOT_SUPPORTED', message: `No sync integration exists for "${provider}".` } } };
  }

  return undefined;
};
