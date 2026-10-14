// NAgex HTTP entry point for MCP OAuth: provider availability, start, callback and (re)connect.
// Fail-closed: start / callback answer 503 until a trusted, operator-configured coordinator exists. Owner identity comes only from the verified NAgex session,
// never from query parameters, and no token URL, client id, redirect URI or secret is ever accepted from a request. No credential is returned in any body,
// redirect or log: the callback only reports WHETHER a credential was stored and whether the MCP server was then verified.
import crypto from 'node:crypto';
import type { IdentityStore } from '../../identity/identity.store.js';
import type { SessionStore } from '../../sessions/session.store.js';
import { resolveAuthenticatedIdentity } from '../request-identity.js';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';
import { completeMcpOAuthCallback, type McpOAuthCallbackDeps } from '../../mcp/mcp-oauth-callback.js';
import type { McpOAuthProviderRegistry } from '../../mcp/mcp-oauth-provider-registry.js';
import type { McpOAuthStateStore } from '../../mcp/mcp-oauth-state.js';
import type { McpOAuthRuntime } from '../../mcp/mcp-oauth-runtime.js';
import type { McpService } from '../../mcp/mcp.service.js';
import { NagexError } from '../../common/errors.js';

export interface McpOAuthCallbackRouteDeps {
  sessionStore: SessionStore;
  identityStore: IdentityStore;
  // Explicitly injected trusted coordinator (tests). Production uses oauthRuntime.
  oauth?: McpOAuthCallbackDeps;
  providerRegistry?: McpOAuthProviderRegistry;
  pendingStates?: McpOAuthStateStore;
  oauthRuntime?: McpOAuthRuntime;
  // After the credential is stored the SAME authenticated owner's connection is verified through the existing McpService (initialize + tools/list).
  mcpService?: McpService;
}

type McpOAuthOutcome =
  | { status: 'MCP_CONNECTED_VERIFIED'; provider: string; connectionId: string; tools: number }
  | { status: 'OAUTH_CREDENTIAL_STORED'; provider: string; reason: string };

const SAFE_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;

function html(headers: Record<string, string | string[] | undefined>): boolean {
  const accept = headers.accept ?? headers.Accept;
  return /text\/html/i.test(Array.isArray(accept) ? accept.join(',') : String(accept ?? ''));
}

function backToApp(status: string, provider: string, reason?: string): ApiResult {
  const query = new URLSearchParams({ mcp_oauth: status, provider });
  if (reason && SAFE_CODE.test(reason)) query.set('reason', reason);
  return { status: 302, data: null, redirectTo: `/?${query.toString()}#settings/connections` };
}

export const handleMcpOAuthRoutes: AsyncRouteRegistrar<McpOAuthCallbackRouteDeps> = async (
  method, pathname, _body, headers, query, deps,
): Promise<ApiResult | undefined> => {
  const routes = ['/api/v1/oauth/mcp/callback', '/api/v1/oauth/mcp/start', '/api/v1/oauth/mcp/providers', '/api/v1/oauth/mcp/connect'];
  if (!routes.includes(pathname)) return undefined;
  const expected = pathname.endsWith('/start') || pathname.endsWith('/connect') ? 'POST' : 'GET';
  if (method !== expected) return { status: 405, data: { error: { code: 'METHOD_NOT_ALLOWED' } } };
  const owner = resolveAuthenticatedIdentity(headers, deps);
  if (!owner) return { status: 401, data: { error: { code: 'UNAUTHORIZED' } } };

  // Non-secret availability for the Connections screen. Never a credential, never an operator value.
  if (pathname.endsWith('/providers')) {
    const statuses = deps.oauthRuntime ? await deps.oauthRuntime.statuses() : [];
    return { status: 200, data: { providers: statuses } };
  }

  // No MCP OAuth flow is exposed until an operator has explicitly wired the trusted registry, the single-use state store and the encrypted vault.
  const coordinator = deps.oauth && deps.providerRegistry && deps.pendingStates
    ? { oauth: deps.oauth, providerRegistry: deps.providerRegistry, pendingStates: deps.pendingStates }
    : await deps.oauthRuntime?.coordinator() ?? undefined;
  if (!coordinator || coordinator.oauth.stateStore !== coordinator.pendingStates)
    return { status: 503, data: { error: { code: 'MCP_OAUTH_NOT_CONFIGURED' } } };
  const ownerRef = { tenantId: owner.tenantId, principalId: owner.principalId };

  if (pathname.endsWith('/start')) {
    const providerId = _body?.providerId;
    if (typeof providerId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(providerId))
      return { status: 400, data: { error: { code: 'MCP_OAUTH_PROVIDER_INVALID' } } };
    try {
      const authorizeUrl = coordinator.providerRegistry.start(providerId, ownerRef, coordinator.pendingStates);
      return { status: 200, data: { authorizeUrl } };
    } catch {
      return { status: 404, data: { error: { code: 'MCP_OAUTH_PROVIDER_NOT_AVAILABLE' } } };
    }
  }

  const connectStoredCredential = async (binding: { providerId: string; displayName: string; mcpEndpoint: string; resource: string; issuer: string; clientId: string; scopes: string[] }, requestId: string): Promise<McpOAuthOutcome> => {
    if (!deps.mcpService) return { status: 'OAUTH_CREDENTIAL_STORED', provider: binding.providerId, reason: 'MCP_NOT_AVAILABLE' };
    try {
      const { view } = await deps.mcpService.connectOAuth({ ...ownerRef, requestId }, { name: binding.displayName, mcpEndpoint: binding.mcpEndpoint, binding: { providerId: binding.providerId, resource: binding.resource, issuer: binding.issuer, clientId: binding.clientId, scopes: binding.scopes } });
      if (view.status === 'CONNECTED') return { status: 'MCP_CONNECTED_VERIFIED', provider: binding.providerId, connectionId: view.connectionId, tools: view.tools.length };
      return { status: 'OAUTH_CREDENTIAL_STORED', provider: binding.providerId, reason: view.reason && SAFE_CODE.test(view.reason) ? view.reason : view.status };
    } catch (error) {
      // Token persistence is not proof of a working server: report exactly that, with a stable code and nothing from the provider.
      return { status: 'OAUTH_CREDENTIAL_STORED', provider: binding.providerId, reason: error instanceof NagexError && SAFE_CODE.test(error.code) ? error.code : 'MCP_DISCOVERY_FAILED' };
    }
  };

  // Retry discovery with the credential already stored (no new sign-in).
  if (pathname.endsWith('/connect')) {
    const providerId = _body?.providerId;
    if (typeof providerId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(providerId)) return { status: 400, data: { error: { code: 'MCP_OAUTH_PROVIDER_INVALID' } } };
    const binding = coordinator.providerRegistry.bindingFor(providerId);
    if (!binding) return { status: 404, data: { error: { code: 'MCP_OAUTH_PROVIDER_NOT_AVAILABLE' } } };
    const outcome = await connectStoredCredential(binding, 'req_mcp_oauth_' + crypto.randomUUID());
    return { status: outcome.status === 'MCP_CONNECTED_VERIFIED' ? 200 : 409, data: outcome };
  }

  const requestId = 'req_mcp_oauth_' + crypto.randomUUID();
  try {
    const result = await completeMcpOAuthCallback(
      coordinator.oauth, ownerRef,
      { state: query.state, code: query.code, error: query.error },
      requestId,
    );
    // Legacy shape when nothing can verify the server afterwards.
    if (!deps.mcpService) return { status: 200, data: { status: result.status, resource: result.resource } };
    const provider = coordinator.providerRegistry.providerByCredential({ resource: result.resource, issuer: result.issuer, clientId: result.clientId });
    if (!provider) return { status: 200, data: { status: 'OAUTH_CREDENTIAL_STORED', provider: 'unknown', reason: 'PROVIDER_UNKNOWN' } };
    const outcome = await connectStoredCredential({ providerId: provider.id, displayName: provider.displayName, mcpEndpoint: provider.mcpEndpoint, resource: result.resource, issuer: result.issuer, clientId: result.clientId, scopes: result.scopes }, requestId);
    if (html(headers)) return backToApp(outcome.status === 'MCP_CONNECTED_VERIFIED' ? 'connected' : 'stored', provider.id, outcome.status === 'OAUTH_CREDENTIAL_STORED' ? outcome.reason : undefined);
    return { status: 200, data: outcome };
  } catch {
    // No token details, HTTP response body, code or identity enters logs.
    if (html(headers)) return backToApp('failed', 'unknown');
    return { status: 400, data: { error: { code: 'MCP_OAUTH_CALLBACK_FAILED' } } };
  }
};
