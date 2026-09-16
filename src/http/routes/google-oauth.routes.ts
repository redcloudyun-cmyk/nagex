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
import crypto from 'node:crypto';
import type { AuditLogger } from '../../governance/audit.logger.js';
import { buildGoogleAuthorizeUrl, exchangeGoogleAuthorizationCode, readGoogleOAuthConfig } from '../../integrations/google/oauth.client.js';
import { googleTokenStore, DEFAULT_GOOGLE_TENANT_ID } from '../../integrations/google/token.store.js';
import type { ApiResult, SyncRouteRegistrar, AsyncRouteRegistrar } from '../http-types.js';

function getHeaderValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

let pendingGoogleOAuthState: string | null = null;

export const handleGoogleOAuthStartRoutes: SyncRouteRegistrar<Record<string, never>> = (method, pathname): ApiResult | undefined => {
  if (pathname === '/api/v1/oauth/google/start' && method === 'GET') {
    const config = readGoogleOAuthConfig();
    if (!config) {
      return { status: 503, data: { error: 'GOOGLE_OAUTH_NOT_CONFIGURED', message: 'GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI must be set.' } };
    }
    pendingGoogleOAuthState = crypto.randomUUID();
    // Real browser navigation: redirect straight to Google, never hand back
    // the authorize URL as a JSON body for this endpoint.
    return { status: 302, data: null, redirectTo: buildGoogleAuthorizeUrl(config, pendingGoogleOAuthState) };
  }

  if (pathname === '/api/v1/oauth/google/start-url' && method === 'GET') {
    const config = readGoogleOAuthConfig();
    if (!config) {
      return { status: 503, data: { error: 'GOOGLE_OAUTH_NOT_CONFIGURED', message: 'GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI must be set.' } };
    }
    pendingGoogleOAuthState = crypto.randomUUID();
    return { status: 200, data: { authorizeUrl: buildGoogleAuthorizeUrl(config, pendingGoogleOAuthState) } };
  }

  return undefined;
};

export interface GoogleOAuthCallbackRouteDeps {
  auditLogger: AuditLogger;
}

export const handleGoogleOAuthCallbackRoutes: AsyncRouteRegistrar<GoogleOAuthCallbackRouteDeps> = async (method, pathname, _body, headers, query, deps): Promise<ApiResult | undefined> => {
  const { auditLogger } = deps;

  if (pathname === '/api/v1/oauth/google/callback' && method === 'GET') {
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
    const requestId = `req_oauth_${crypto.randomUUID()}`;
    const expectedState = pendingGoogleOAuthState;
    pendingGoogleOAuthState = null; // one-time use, prevents callback replay

    if (query.error) {
      return { status: 302, data: null, redirectTo: '/?oauth=google&status=error' };
    }
    if (!query.state || !expectedState || query.state !== expectedState || !query.code) {
      return { status: 302, data: null, redirectTo: '/?oauth=google&status=error' };
    }
    const config = readGoogleOAuthConfig();
    if (!config) {
      return { status: 302, data: null, redirectTo: '/?oauth=google&status=error' };
    }
    try {
      const token = await exchangeGoogleAuthorizationCode(config, query.code, fetch, requestId);
      googleTokenStore.save(tenantId, token);
      auditLogger.logEvent({ actor: { type: 'user', id: 'usr_admin_001' }, tenant_id: tenantId, action: 'oauth:google_connected', resource: { type: 'OAuthConnection', id: 'google_calendar' }, result: 'SUCCESS', request_id: requestId });
      return { status: 302, data: null, redirectTo: '/?oauth=google&status=connected' };
    } catch {
      return { status: 302, data: null, redirectTo: '/?oauth=google&status=error' };
    }
  }
  if (pathname === '/api/v1/oauth/google/status' && method === 'GET') {
    const tid = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_oauth_${crypto.randomUUID()}`;
    const config = readGoogleOAuthConfig();
    if (config) {
      // Touches (and transparently refreshes + persists) the token if it's
      // expired, so "connected" reflects real usability, not stale state.
      await googleTokenStore.getValidAccessToken(tid, config, fetch, requestId);
    }
    const status = googleTokenStore.getStatus(tid);
    return { status: 200, data: { configured: Boolean(config), ...status } };
  }
  if (pathname === '/api/v1/oauth/google/disconnect' && method === 'POST') {
    const tid = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
    const principalId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_oauth_${crypto.randomUUID()}`;
    await googleTokenStore.revoke(tid, fetch, requestId);
    auditLogger.logEvent({ actor: { type: 'user', id: principalId }, tenant_id: tid, action: 'oauth:google_disconnected', resource: { type: 'OAuthConnection', id: 'google_calendar' }, result: 'SUCCESS', request_id: requestId });
    return { status: 200, data: googleTokenStore.getStatus(tid) };
  }

  return undefined;
};
