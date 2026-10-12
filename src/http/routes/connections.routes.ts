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
import type { CalendarConnectionState, GoogleCalendarConnectionService } from '../../integrations/google/calendar-connection.js';
import type { GitHubConnectionService } from '../../integrations/github/github-connection.js';
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
  calendarConnection?: GoogleCalendarConnectionService;
  githubConnection?: GitHubConnectionService;
}

// The state names the UI shows. Google is read from the per-user connection (token store), never from a local copy.
const GOOGLE_STATE_TO_RECORD_STATUS: Record<CalendarConnectionState, AppConnectionRecord['status']> = {
  NOT_CONNECTED: 'NOT_CONNECTED',
  CONNECTING: 'CONNECTING',
  CONNECTED: 'CONNECTED',
  REAUTH_REQUIRED: 'REAUTH_REQUIRED',
  ERROR: 'ERROR',
  UNAVAILABLE: 'UNAVAILABLE',
};

function withCanonicalStatus(record: AppConnectionRecord, tenantId: string, userId: string): AppConnectionRecord {
  if (record.provider !== 'google') {
    const unsupported = record.provider === 'microsoft';
    return { ...record, status: unsupported ? 'UNAVAILABLE' : record.status };
  }
  const connected = googleTokenStore.getStatusForPrincipal(tenantId, userId).connected;
  return { ...record, status: connected ? 'CONNECTED' : 'DISCONNECTED' };
}

function parseWindow(query: Record<string, string>): { days: number; maxResults: number } {
  const days = Math.min(14, Math.max(1, Math.floor(Number(query.days)) || 7));
  const maxResults = Math.min(50, Math.max(1, Math.floor(Number(query.maxResults)) || 20));
  return { days, maxResults };
}

// A provider failure is reported as one, with the status a client can act on; every other state is a normal answer.
function statusForState(state: CalendarConnectionState, reason: string | null): number {
  if (state !== 'ERROR') return 200;
  return reason === 'PROVIDER_TIMEOUT' ? 504 : 502;
}

export const handleConnectionsRoutes: AsyncRouteRegistrar<ConnectionsRouteDeps> = async (method, pathname, _body, headers, query, deps): Promise<ApiResult | undefined> => {
  const { connectionStore, auditLogger, calendarConnection } = deps;
  if (!pathname.startsWith('/api/v1/connections')) return undefined;
  const owner = resolveAuthenticatedIdentity(headers, deps);
  if (!owner) return { status: 401, data: { error: { code: 'UNAUTHORIZED', message: 'Sign in to view or manage connected apps.' } } };
  const tenantId = owner.tenantId;
  const userId = owner.principalId;

  // Google Calendar: identity is the verified session only; query/body can never name a user or tenant.
  if (pathname === '/api/v1/connections/google-calendar' && method === 'GET') {
    if (!calendarConnection) return { status: 503, data: { error: { code: 'CALENDAR_CONNECTION_NOT_CONFIGURED', message: 'Calendar connection status is not available.' } } };
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_conn_${crypto.randomUUID()}`;
    const connection = await calendarConnection.getStatus({ tenantId, principalId: userId, requestId }, { verify: query.verify === '1' || query.verify === 'true' });
    return { status: statusForState(connection.state, connection.reason), data: { connection } };
  }

  if (pathname === '/api/v1/connections/google-calendar/events' && method === 'GET') {
    if (!calendarConnection) return { status: 503, data: { error: { code: 'CALENDAR_CONNECTION_NOT_CONFIGURED', message: 'Calendar events are not available.' } } };
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_conn_${crypto.randomUUID()}`;
    const { days, maxResults } = parseWindow(query);
    const now = new Date();
    const result = await calendarConnection.readEvents(
      { tenantId, principalId: userId, requestId },
      { timeMin: now.toISOString(), timeMax: new Date(now.getTime() + days * 24 * 3600 * 1000).toISOString(), maxResults },
    );
    return { status: statusForState(result.connection.state, result.connection.reason), data: { connection: result.connection, events: result.events, total: result.events.length } };
  }

  if (pathname === '/api/v1/connections' && method === 'GET') {
    const googleStatus = calendarConnection ? await calendarConnection.getStatus({ tenantId, principalId: userId, requestId: `req_conn_${crypto.randomUUID()}` }) : null;
    // GitHub is a built-in connected app: its state is derived from the per-user token store, never from a local copy.
    const githubStatus = deps.githubConnection ? await deps.githubConnection.getStatus({ tenantId, principalId: userId, requestId: `req_conn_${crypto.randomUUID()}` }) : null;
    const connections = connectionStore.listConnections(tenantId, userId).map((r) => {
      const record = withCanonicalStatus(r, tenantId, userId);
      if (record.provider === 'github') {
        return {
          ...record,
          status: githubStatus ? githubStatus.state : 'UNAVAILABLE',
          accountName: githubStatus?.account?.login,
          detail: githubStatus ? { reason: githubStatus.reason, retryable: githubStatus.retryable, connectPath: githubStatus.connectPath, verifiedAt: githubStatus.verifiedAt, privateAccess: githubStatus.privateAccess } : { reason: 'OAUTH_NOT_CONFIGURED', retryable: false, connectPath: null, verifiedAt: null, privateAccess: false },
          consentAuthority: { observeAllowed: false, contentReadAllowed: false, proactiveUseAllowed: false, executeAllowed: false, reason: 'Connection state is not consent or execution authority.' },
        };
      }
      if (record.provider === 'google' && googleStatus) {
        return {
          ...record,
          status: GOOGLE_STATE_TO_RECORD_STATUS[googleStatus.state],
          detail: { reason: googleStatus.reason, retryable: googleStatus.retryable, connectPath: googleStatus.connectPath, missingScopes: googleStatus.missingScopes, verifiedAt: googleStatus.verifiedAt },
          consentAuthority: {
            observeAllowed: false,
            contentReadAllowed: false,
            proactiveUseAllowed: false,
            executeAllowed: false,
            reason: 'Connection state is not consent or execution authority.',
          },
        };
      }
      return {
        ...record,
        consentAuthority: {
          observeAllowed: false,
          contentReadAllowed: false,
          proactiveUseAllowed: false,
          executeAllowed: false,
          reason: 'Connection state is not consent or execution authority.',
        },
      };
    });
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
    if (provider === 'microsoft') {
      return { status: 501, data: { error: { code: 'PROVIDER_DISCONNECT_NOT_SUPPORTED', message: `No disconnect integration exists for "${provider}".` } } };
    }
    const record = withCanonicalStatus(connectionStore.disconnect(tenantId, userId, provider), tenantId, userId);
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
