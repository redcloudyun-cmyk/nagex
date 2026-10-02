// R10.2-D Increment 4 — Google OAuth connection routes, extracted verbatim
// from server_web.ts. Two registrars, matching the two real dispatch entry
// points the original inline blocks lived in:
//   - handleGoogleOAuthStartRoutes (sync)   — GET /start, GET /start-url,
//     originally inline in handleApiRequest.
//   - handleGoogleOAuthCallbackRoutes (async) — GET /callback, GET
//     /status, POST /disconnect, originally inline in
//     handleAsyncApiRequest (all three await a real googleTokenStore or
//     fetch()-based call).
// pendingGoogleOAuthState is the one-time CSRF nonce used across the
// start->callback round trip. It is genuinely shared mutable state between
// the sync (start/start-url) and async (callback) registrars, so it lives
// here as this module's own state — moved with its only three consumers,
// exactly like approvalQueue/planRegistry/quickWakeConfig before it.
//
// R24.6C — IDENTITY BOUNDARY. The Google connection belongs to the
// authenticated account. Every route here takes the owner (tenant + user)
// ONLY from the server-side session (resolveAuthenticatedIdentity); the
// X-Principal-Id / X-NAgex-Tenant headers, query string and body are never
// used to decide whose token is read, written or revoked. The OAuth
// callback is correlated by the server-held one-time `state` nonce (bound to
// the session identity at /start) AND must arrive with that same session —
// the identifier is never accepted from the browser as authorization.
import crypto from 'node:crypto';
import type { AuditLogger } from '../../governance/audit.logger.js';
import type { IdentityStore } from '../../identity/identity.store.js';
import type { SessionStore } from '../../sessions/session.store.js';
import { buildGoogleAuthorizeUrl, exchangeGoogleAuthorizationCode, readGoogleOAuthConfig } from '../../integrations/google/oauth.client.js';
import { googleTokenStore } from '../../integrations/google/token.store.js';
import { resolveAuthenticatedIdentity, type AuthenticatedIdentity } from '../request-identity.js';
import type { ApiResult, SyncRouteRegistrar, AsyncRouteRegistrar } from '../http-types.js';

function getHeaderValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export interface GoogleOAuthAuthDeps {
  sessionStore: SessionStore;
  identityStore: IdentityStore;
}

const UNAUTHORIZED: ApiResult = { status: 401, data: { error: { code: 'UNAUTHORIZED', message: 'Sign in to manage your Google connection.' } } };

interface PendingGoogleOAuthState {
  tenantId: string;
  principalId: string;
  createdAt: number;
}

const GOOGLE_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const pendingGoogleOAuthStates = new Map<string, PendingGoogleOAuthState>();

function issueGoogleOAuthState(owner: AuthenticatedIdentity): string {
  const state = crypto.randomUUID();
  const now = Date.now();

  for (const [key, pending] of pendingGoogleOAuthStates.entries()) {
    if (now - pending.createdAt > GOOGLE_OAUTH_STATE_TTL_MS) pendingGoogleOAuthStates.delete(key);
  }

  pendingGoogleOAuthStates.set(state, { tenantId: owner.tenantId, principalId: owner.principalId, createdAt: now });
  return state;
}

function consumeGoogleOAuthState(state: string | undefined): PendingGoogleOAuthState | null {
  if (!state) return null;
  const pending = pendingGoogleOAuthStates.get(state);
  pendingGoogleOAuthStates.delete(state);
  if (!pending) return null;
  if (Date.now() - pending.createdAt > GOOGLE_OAUTH_STATE_TTL_MS) return null;
  return pending;
}

export const handleGoogleOAuthStartRoutes: SyncRouteRegistrar<GoogleOAuthAuthDeps> = (method, pathname, _body, headers, _query, deps): ApiResult | undefined => {
  if (pathname === '/api/v1/oauth/google/start' && method === 'GET') {
    const owner = resolveAuthenticatedIdentity(headers, deps);
    if (!owner) return { status: 302, data: null, redirectTo: '/?oauth=google&status=signin_required' };
    const config = readGoogleOAuthConfig();
    if (!config) {
      return { status: 503, data: { error: 'GOOGLE_OAUTH_NOT_CONFIGURED', message: 'GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI must be set.' } };
    }
    const state = issueGoogleOAuthState(owner);
    // Real browser navigation: redirect straight to Google, never hand back
    // the authorize URL as a JSON body for this endpoint. The nonce is bound
    // server-side to the authenticated session's tenant + user.
    return { status: 302, data: null, redirectTo: buildGoogleAuthorizeUrl(config, state) };
  }

  if (pathname === '/api/v1/oauth/google/start-url' && method === 'GET') {
    const owner = resolveAuthenticatedIdentity(headers, deps);
    if (!owner) return UNAUTHORIZED;
    const config = readGoogleOAuthConfig();
    if (!config) {
      return { status: 503, data: { error: 'GOOGLE_OAUTH_NOT_CONFIGURED', message: 'GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI must be set.' } };
    }
    const state = issueGoogleOAuthState(owner);
    return { status: 200, data: { authorizeUrl: buildGoogleAuthorizeUrl(config, state) } };
  }

  return undefined;
};

export interface GoogleOAuthCallbackRouteDeps extends GoogleOAuthAuthDeps {
  auditLogger: AuditLogger;
}

export const handleGoogleOAuthCallbackRoutes: AsyncRouteRegistrar<GoogleOAuthCallbackRouteDeps> = async (method, pathname, _body, headers, query, deps): Promise<ApiResult | undefined> => {
  const { auditLogger } = deps;

  if (pathname === '/api/v1/oauth/google/callback' && method === 'GET') {
    const requestId = `req_oauth_${crypto.randomUUID()}`;
    const pending = consumeGoogleOAuthState(query.state);

    if (query.error) {
      return { status: 302, data: null, redirectTo: '/?oauth=google&status=error' };
    }
    if (!pending || !query.code) {
      return { status: 302, data: null, redirectTo: '/?oauth=google&status=error' };
    }
    // The tenant/user come from the server-held nonce; the callback must also
    // arrive in the SAME authenticated session that started the flow, so a
    // state started by one account can never be completed into another's.
    const caller = resolveAuthenticatedIdentity(headers, deps);
    if (!caller || caller.principalId !== pending.principalId || caller.tenantId !== pending.tenantId) {
      return { status: 302, data: null, redirectTo: '/?oauth=google&status=error' };
    }
    const { tenantId, principalId } = pending;
    const config = readGoogleOAuthConfig();
    if (!config) {
      return { status: 302, data: null, redirectTo: '/?oauth=google&status=error' };
    }
    try {
      const token = await exchangeGoogleAuthorizationCode(config, query.code, fetch, requestId);
      googleTokenStore.saveForPrincipal(tenantId, principalId, token);
      auditLogger.logEvent({ actor: { type: 'user', id: principalId }, tenant_id: tenantId, action: 'oauth:google_connected', resource: { type: 'OAuthConnection', id: 'google_calendar' }, result: 'SUCCESS', request_id: requestId });
      return { status: 302, data: null, redirectTo: '/?oauth=google&status=connected' };
    } catch {
      return { status: 302, data: null, redirectTo: '/?oauth=google&status=error' };
    }
  }
  if (pathname === '/api/v1/oauth/google/status' && method === 'GET') {
    const owner = resolveAuthenticatedIdentity(headers, deps);
    if (!owner) return UNAUTHORIZED;
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_oauth_${crypto.randomUUID()}`;
    const config = readGoogleOAuthConfig();
    if (config) {
      // Touches only the authenticated user's credential; another user in the
      // same tenant can never make this status endpoint borrow their token.
      await googleTokenStore.getValidAccessTokenForPrincipal(owner.tenantId, owner.principalId, config, fetch, requestId);
    }
    const status = googleTokenStore.getStatusForPrincipal(owner.tenantId, owner.principalId);
    return { status: 200, data: { configured: Boolean(config), ...status } };
  }
  if (pathname === '/api/v1/oauth/google/disconnect' && method === 'POST') {
    const owner = resolveAuthenticatedIdentity(headers, deps);
    if (!owner) return UNAUTHORIZED;
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_oauth_${crypto.randomUUID()}`;
    await googleTokenStore.revokeForPrincipal(owner.tenantId, owner.principalId, fetch, requestId);
    auditLogger.logEvent({ actor: { type: 'user', id: owner.principalId }, tenant_id: owner.tenantId, action: 'oauth:google_disconnected', resource: { type: 'OAuthConnection', id: 'google_calendar' }, result: 'SUCCESS', request_id: requestId });
    return { status: 200, data: googleTokenStore.getStatusForPrincipal(owner.tenantId, owner.principalId) };
  }

  return undefined;
};
