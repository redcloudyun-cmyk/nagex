// NAgex HTTP entry point for MCP OAuth callbacks.
// This route is intentionally fail-closed until a trusted, operator-certified
// OAuth coordinator is installed. It never accepts token URLs or owner IDs
// from callback query parameters. No credentials are returned in HTTP bodies.
import crypto from 'node:crypto';
import type { IdentityStore } from '../../identity/identity.store.js';
import type { SessionStore } from '../../sessions/session.store.js';
import { resolveAuthenticatedIdentity } from '../request-identity.js';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';
import { completeMcpOAuthCallback, type McpOAuthCallbackDeps } from '../../mcp/mcp-oauth-callback.js';

export interface McpOAuthCallbackRouteDeps {
  sessionStore: SessionStore;
  identityStore: IdentityStore;
  // Optional until an operator-configured, trust-pinned coordinator is wired.
  oauth?: McpOAuthCallbackDeps;
}

export const handleMcpOAuthCallbackRoute: AsyncRouteRegistrar<McpOAuthCallbackRouteDeps> = async (
  method, pathname, _body, headers, query, deps,
): Promise<ApiResult | undefined> => {
  if (pathname !== '/api/v1/oauth/mcp/callback') return undefined;
  if (method !== 'GET') return { status: 405, data: { error: { code: 'METHOD_NOT_ALLOWED' } } };
  const owner = resolveAuthenticatedIdentity(headers, deps);
  if (!owner) return { status: 401, data: { error: { code: 'UNAUTHORIZED' } } };
  // Never consume state when the operator has not installed trusted discovery,
  // issuer pinning and an encrypted credential store.
  if (!deps.oauth) return { status: 503, data: { error: { code: 'MCP_OAUTH_NOT_CONFIGURED' } } };

  try {
    const result = await completeMcpOAuthCallback(
      deps.oauth, { tenantId: owner.tenantId, principalId: owner.principalId },
      { state: query.state, code: query.code, error: query.error },
      'req_mcp_oauth_' + crypto.randomUUID(),
    );
    return { status: 200, data: { status: result.status, resource: result.resource } };
  } catch {
    // No token details, HTTP response body, code or identity enters logs.
    return { status: 400, data: { error: { code: 'MCP_OAUTH_CALLBACK_FAILED' } } };
  }
};
