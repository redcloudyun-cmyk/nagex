import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { handleAsyncApiRequest } from '../src/server_web.js';
import { authAs } from './_s1_session_auth.js';
import { createMcpOAuthStateStore } from '../src/mcp/mcp-oauth-state.js';
import { McpOAuthProviderRegistry } from '../src/mcp/mcp-oauth-provider-registry.js';
import { McpOAuthCredentialVault } from '../src/mcp/mcp-oauth-credential-vault.js';

const resource = 'https://mcp.example.org/mcp';
const issuer = 'https://oauth.example.org';
const clientId = 'operator-client';
const redirectUri = 'https://nagex.example.org/api/v1/oauth/mcp/callback';
const registration = {
  id: 'trusted-mcp', clientId, redirectUri, resource, issuer, requestedScopes: ['tools.read'],
  protectedResourceMetadata: { resource, authorization_servers: [issuer], scopes_supported: ['tools.read'] },
  authorizationServerMetadata: { issuer, authorization_endpoint: issuer + '/authorize',
    token_endpoint: issuer + '/token', code_challenge_methods_supported: ['S256'] },
};

function harness() {
  const states = createMcpOAuthStateStore();
  const providers = new McpOAuthProviderRegistry([registration]);
  const vault = new McpOAuthCredentialVault({ NAGEX_TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32) });
  let exchanges = 0;
  const coordinator = {
    providerRegistry: providers,
    pendingStates: states,
    oauth: {
      stateStore: states, vault,
      resolveRequestedScopes: (pending: any) => providers.requestedScopesFor(pending),
      resolveTrustedTokenEndpoint: async (pending: { issuer: string; resource: string; clientId: string; redirectUri: string }) => providers.resolveTrustedTokenEndpoint(pending as any),
      exchange: async () => {
        exchanges++;
        return { tokenType: 'Bearer' as const, accessToken: 'secret-access', refreshToken: null, expiresIn: 3600, scope: ['tools.read'] };
      },
    },
  };
  const call = (method: string, pathname: string, body: Record<string, unknown> | null, headers: Record<string, string>, query: Record<string, string> = {}) =>
    handleAsyncApiRequest(method, pathname, body, headers, undefined, query,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      { mcpOAuthCoordinator: coordinator });
  return { call, vault, getExchanges: () => exchanges };
}

describe('MCP OAuth canonical HTTP router end-to-end with isolated trusted coordinator', () => {
  it('a signed-in owner starts a pinned provider and completes a one-time callback with encrypted storage', async () => {
    const h = harness();
    const owner = authAs('tenant-mcp-http', 'owner-mcp-http');
    const start = await h.call('POST', '/api/v1/oauth/mcp/start', { providerId: 'trusted-mcp' }, owner);
    assert.equal(start.status, 200, JSON.stringify(start.data));
    const url = new URL((start.data as any).authorizeUrl);
    assert.equal(url.origin, issuer);
    assert.equal(url.searchParams.get('resource'), resource);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    const state = url.searchParams.get('state')!;
    const callback = await h.call('GET', '/api/v1/oauth/mcp/callback', null, owner, { state, code: 'provider-code' });
    assert.equal(callback.status, 200, JSON.stringify(callback.data));
    // With the MCP service wired, a stored credential is reported as exactly that until the MCP server itself verifies: the injected vault here is not the service's
    // credential source and the endpoint is not a reachable MCP server, so this is NOT a verified connection (token persistence is not proof of a working server).
    assert.equal((callback.data as any).status, 'OAUTH_CREDENTIAL_STORED');
    assert.notEqual((callback.data as any).status, 'MCP_CONNECTED_VERIFIED');
    assert.equal(h.getExchanges(), 1);
    // The metadata parser canonicalizes an origin-only issuer to a trailing-slash URL.
    // Credential identity must use that exact pinned canonical URI, not the raw fixture spelling.
    const expectedIdentity = { tenantId: 'tenant-mcp-http', principalId: 'owner-mcp-http', resource, issuer: new URL(issuer).href, clientId };
    const snapshot = h.vault.sealedSnapshot();
    assert.equal(snapshot.length, 1, 'callback must store exactly one encrypted record in the injected vault');
    assert.deepEqual(snapshot[0].identity, expectedIdentity, 'credential owner must match the authenticated session tenant/principal and pinned MCP resource');
    const stored = h.vault.load(expectedIdentity);
    assert.ok(stored, 'owner must be able to retrieve their own encrypted credential');
    assert.equal(stored.tokens.accessToken, 'secret-access');
    assert.doesNotMatch(JSON.stringify(h.vault.sealedSnapshot()), /secret-access/);
    const replay = await h.call('GET', '/api/v1/oauth/mcp/callback', null, owner, { state, code: 'provider-code' });
    assert.equal(replay.status, 400);
    assert.equal(h.getExchanges(), 1);
  });

  it('forged tenant callback cannot steal credentials, or cause provider token exchange', async () => {
    const h = harness();
    const owner = authAs('tenant-mcp-http', 'owner-mcp-http');
    const attacker = authAs('other-tenant-mcp', 'owner-mcp-http');
    const start = await h.call('POST', '/api/v1/oauth/mcp/start', { providerId: 'trusted-mcp' }, owner);
    const state = new URL((start.data as any).authorizeUrl).searchParams.get('state')!;
    const stolen = await h.call('GET', '/api/v1/oauth/mcp/callback', null, attacker, { state, code: 'provider-code' });
    assert.equal(stolen.status, 400);
    assert.equal(h.getExchanges(), 0);
    assert.equal(h.vault.load({ tenantId: 'tenant-mcp-http', principalId: 'owner-mcp-http', resource, issuer, clientId }), null);
    assert.equal((await h.call('GET', '/api/v1/oauth/mcp/callback', null, owner, { state, code: 'provider-code' })).status, 400);
  });

  it('unlisted provider, unauthenticated start and caller-supplied URL cannot bypass operator registration', async () => {
    const h = harness();
    const owner = authAs('tenant-mcp-http', 'owner-mcp-http');
    assert.equal((await h.call('POST', '/api/v1/oauth/mcp/start', { providerId: 'trusted-mcp' }, {})).status, 401);
    assert.equal((await h.call('POST', '/api/v1/oauth/mcp/start', { providerId: 'not-listed' }, owner)).status, 404);
    const result = await h.call('POST', '/api/v1/oauth/mcp/start', {
      providerId: 'not-listed', tokenEndpoint: 'https://attacker.example/token', redirectUri: 'https://attacker.example/cb',
    }, owner);
    assert.equal(result.status, 404);
    assert.equal(h.getExchanges(), 0);
  });
});
