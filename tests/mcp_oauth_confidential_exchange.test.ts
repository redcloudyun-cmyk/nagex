// Stage A of the MCP OAuth overnight directive: operator-pinned confidential client authentication (client_secret_post) and Slack's pinned token-response profile.
// A local fake provider asserts the exact form that reaches the wire. No real provider is contacted.
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { exchangeMcpOAuthCode, type McpOAuthClientAuthentication } from '../src/mcp/mcp-oauth-token.js';
import { createMcpOAuthStateStore } from '../src/mcp/mcp-oauth-state.js';
import { McpOAuthProviderRegistry } from '../src/mcp/mcp-oauth-provider-registry.js';
import { completeMcpOAuthCallback } from '../src/mcp/mcp-oauth-callback.js';
import { McpOAuthCredentialVault } from '../src/mcp/mcp-oauth-credential-vault.js';

const owner = { tenantId: 'tenant-a', principalId: 'user-a' };
const resource = 'https://mcp.example.org';
const mcpEndpoint = 'https://mcp.example.org/mcp';
const issuer = 'https://mcp.example.org';
const clientId = 'nagex-slack-like-client';
const redirectUri = 'https://nagex.example.org/api/v1/oauth/mcp/callback';
const SECRET = 'operator-secret-0123456789abcdef';
const policy = { resolve: async () => ['8.8.8.8'] };
const endpoint = 'https://auth.example.org/api/oauth.v2.user.access';

function newPending() {
  const store = createMcpOAuthStateStore();
  const request = store.issue(owner, { resource, issuer, clientId, redirectUri });
  const pending = store.consume(request.state, owner);
  assert.ok(pending);
  return pending;
}
const json = (body: unknown) => ({ status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) });
const slackOk = { ok: true, access_token: 'xoxp-secret-access', token_type: 'user', authed_user: { id: 'U123', scope: 'search:read.public,channels:history' }, team: { id: 'T123' } };

describe('client_secret_post token exchange (operator-pinned)', () => {
  it('sends the secret in the form body only, together with the exact PKCE / client / resource fields', async () => {
    const pending = newPending();
    let form: URLSearchParams | undefined;
    await exchangeMcpOAuthCode(pending, 'code-1', endpoint, 'req', {
      policy, clientAuth: { method: 'client_secret_post', clientSecret: SECRET },
      post: async (url, body) => { assert.equal(url.href, endpoint); assert.equal(url.search, ''); form = new URLSearchParams(body); return json({ token_type: 'Bearer', access_token: 'a', scope: 'x' }); },
    });
    assert.deepEqual([...form!.keys()].sort(), ['client_id', 'client_secret', 'code', 'code_verifier', 'grant_type', 'redirect_uri', 'resource']);
    assert.equal(form!.get('client_secret'), SECRET);
    assert.equal(form!.get('client_id'), clientId);
    assert.equal(form!.get('code_verifier'), pending.codeVerifier);
    assert.equal(form!.get('grant_type'), 'authorization_code');
  });

  it("a public client ('none', the default) never sends a client_secret", async () => {
    const pending = newPending();
    for (const options of [{}, { clientAuth: { method: 'none' } as McpOAuthClientAuthentication }]) {
      let form: URLSearchParams | undefined;
      await exchangeMcpOAuthCode(pending, 'code-1', endpoint, 'req', { policy, ...options, post: async (_u, body) => { form = new URLSearchParams(body); return json({ token_type: 'Bearer', access_token: 'a' }); } });
      assert.equal(form!.has('client_secret'), false);
    }
  });

  it('fails closed BEFORE any request when the secret is missing, empty, oversized or not a plain value, or when a public client carries one', async () => {
    const pending = newPending();
    let posts = 0;
    const post = async () => { posts++; return json({ token_type: 'Bearer', access_token: 'a' }); };
    const bad: McpOAuthClientAuthentication[] = [
      { method: 'client_secret_post' }, { method: 'client_secret_post', clientSecret: '' }, { method: 'client_secret_post', clientSecret: 'x'.repeat(1025) },
      { method: 'client_secret_post', clientSecret: 'line\nbreak' }, { method: 'none', clientSecret: SECRET }, { method: 'client_secret_basic' as never },
    ];
    for (const clientAuth of bad) await assert.rejects(() => exchangeMcpOAuthCode(pending, 'code', endpoint, 'req', { policy, clientAuth, post }), /Could not securely complete MCP authorization/);
    assert.equal(posts, 0);
  });

  it('never reveals the secret, the authorization code or provider text in an error', async () => {
    const pending = newPending();
    const cases = [
      async () => ({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'invalid_client', echo: SECRET }) }),
      async () => { throw new Error('connect failed ' + SECRET); },
      async () => json({ ok: false, error: 'invalid_code', echo: SECRET }),
    ];
    for (const post of cases) {
      try {
        await exchangeMcpOAuthCode(pending, 'code-visible-in-nothing', endpoint, 'req', { policy, responseProfile: 'slack-user-v2', clientAuth: { method: 'client_secret_post', clientSecret: SECRET }, post });
        assert.fail('must reject');
      } catch (error) {
        const text = JSON.stringify(error, Object.getOwnPropertyNames(error));
        assert.doesNotMatch(text, new RegExp(SECRET));
        assert.doesNotMatch(text, /code-visible-in-nothing/);
        assert.doesNotMatch(text, new RegExp(pending.codeVerifier));
      }
    }
  });

  it('reaches a real HTTP token endpoint with exactly the pinned form and no Authorization header (loopback allowed for this test only)', async () => {
    const seen: { auth: string | undefined; ctype: string | undefined; form: URLSearchParams }[] = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        seen.push({ auth: req.headers.authorization, ctype: req.headers['content-type'], form: new URLSearchParams(Buffer.concat(chunks).toString()) });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(slackOk));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/oauth.v2.user.access`;
      const tokens = await exchangeMcpOAuthCode(newPending(), 'real-code', url, 'req', { policy: { allowPrivateNetwork: true }, responseProfile: 'slack-user-v2', clientAuth: { method: 'client_secret_post', clientSecret: SECRET } });
      assert.equal(seen.length, 1);
      assert.equal(seen[0].auth, undefined);
      assert.equal(seen[0].ctype, 'application/x-www-form-urlencoded');
      assert.equal(seen[0].form.get('client_secret'), SECRET);
      assert.equal(seen[0].form.get('code'), 'real-code');
      assert.deepEqual(tokens.scope.sort(), ['channels:history', 'search:read.public']);
      assert.equal(tokens.accessToken, 'xoxp-secret-access');
      // the same server is refused under the production policy (private address, plain http)
      await assert.rejects(() => exchangeMcpOAuthCode(newPending(), 'c', url, 'req', { policy: {} }), /./);
      assert.equal(seen.length, 1);
    } finally { server.close(); }
  });
});

describe('slack-user-v2 response profile', () => {
  const run = (body: unknown, profile: 'slack-user-v2' | 'rfc6749' = 'slack-user-v2') =>
    exchangeMcpOAuthCode(newPending(), 'c', endpoint, 'req', { policy, responseProfile: profile, clientAuth: { method: 'client_secret_post', clientSecret: SECRET }, post: async () => json(body) });

  it('accepts ok:true with token_type "user" and splits comma-separated scopes', async () => {
    const tokens = await run(slackOk);
    assert.equal(tokens.tokenType, 'Bearer');
    assert.deepEqual(tokens.scope.sort(), ['channels:history', 'search:read.public']);
    assert.equal(tokens.refreshToken, null);
    const rotated = await run({ ...slackOk, scope: 'search:read.public channels:history', expires_in: 43200, refresh_token: 'xoxe-1-r' });
    assert.equal(rotated.expiresIn, 43200);
    assert.equal(rotated.refreshToken, 'xoxe-1-r');
  });

  it('rejects ok:false (HTTP 200), a wrong token type, ambiguous or malformed scopes and missing tokens', async () => {
    await assert.rejects(() => run({ ok: false, error: 'invalid_code' }), (e: any) => e.details?.reason === 'PROVIDER_REJECTED:invalid_code');
    await assert.rejects(() => run({ ...slackOk, token_type: 'Bearer' }), (e: any) => e.details?.reason === 'UNSUPPORTED_TOKEN_TYPE');
    await assert.rejects(() => run({ ...slackOk, scope: 'files:read' }), (e: any) => e.details?.reason === 'SCOPE_AMBIGUOUS');
    await assert.rejects(() => run({ ...slackOk, scope: ['a'] }), (e: any) => e.details?.reason === 'SCOPE');
    await assert.rejects(() => run({ ...slackOk, access_token: undefined }), /./);
    await assert.rejects(() => run(null), /./);
    await assert.rejects(() => run({ ok: false, error: 'bad<script>' }), (e: any) => e.details?.reason === 'PROVIDER_REJECTED:unknown');
  });

  it('the generic profile still refuses a "user" token, so a provider cannot be misread', async () => {
    await assert.rejects(() => run(slackOk, 'rfc6749'), (e: any) => e.details?.reason === 'UNSUPPORTED_TOKEN_TYPE');
    await assert.rejects(() => exchangeMcpOAuthCode(newPending(), 'c', endpoint, 'req', { policy, responseProfile: 'whatever' as never, post: async () => json(slackOk) }), /./);
  });
});

describe('operator registration pins client authentication', () => {
  const authDoc = (methods: string[] | null) => ({ issuer, authorization_endpoint: 'https://login.example.org/authorize', token_endpoint: endpoint, code_challenge_methods_supported: ['S256'], ...(methods ? { token_endpoint_auth_methods_supported: methods } : {}) });
  const registration = (extra: Record<string, unknown> = {}, methods: string[] | null = ['client_secret_post']) => ({
    id: 'slack-like', clientId, redirectUri, resource, issuer, requestedScopes: ['search:read.public'], mcpEndpoint,
    tokenAuthMethod: 'client_secret_post' as const, clientSecretRef: 'NAGEX_TEST_SECRET', responseProfile: 'slack-user-v2' as const, displayName: 'Slack-like',
    protectedResourceMetadata: { resource, authorization_servers: [issuer], scopes_supported: ['search:read.public', 'channels:history'] },
    authorizationServerMetadata: authDoc(methods), ...extra,
  });

  it('accepts a confidential registration only when the server advertises client_secret_post, and exposes the pinned contract', () => {
    const registry = new McpOAuthProviderRegistry([registration()]);
    const states = createMcpOAuthStateStore();
    const url = new URL(registry.start('slack-like', owner, states));
    const pending = states.consume(url.searchParams.get('state')!, owner)!;
    assert.deepEqual(registry.tokenClientAuthFor(pending), { method: 'client_secret_post', secretRef: 'NAGEX_TEST_SECRET', responseProfile: 'slack-user-v2' });
    assert.equal(registry.providerFor(pending).mcpEndpoint, mcpEndpoint);
    assert.deepEqual(registry.list().map((p) => p.id), ['slack-like']);
    assert.doesNotMatch(JSON.stringify(registry.list()), /NAGEX_TEST_SECRET|secret/i);
  });

  it('refuses unadvertised or inconsistent authentication choices', () => {
    for (const methods of [null, ['client_secret_basic'], ['none']]) assert.throws(() => new McpOAuthProviderRegistry([registration({}, methods)]), /MCP_OAUTH_TOKEN_AUTH_NOT_ADVERTISED/);
    assert.throws(() => new McpOAuthProviderRegistry([registration({ clientSecretRef: undefined })]), /MCP_OAUTH_CLIENT_SECRET_REF_INVALID/);
    assert.throws(() => new McpOAuthProviderRegistry([registration({ clientSecretRef: 'has space' })]), /MCP_OAUTH_CLIENT_SECRET_REF_INVALID/);
    assert.throws(() => new McpOAuthProviderRegistry([registration({ tokenAuthMethod: 'none', clientSecretRef: 'X' }, ['none'])]), /MCP_OAUTH_CLIENT_SECRET_REF_INVALID/);
    assert.throws(() => new McpOAuthProviderRegistry([registration({ tokenAuthMethod: 'private_key_jwt' })]), /MCP_OAUTH_TOKEN_AUTH_UNSUPPORTED/);
    assert.throws(() => new McpOAuthProviderRegistry([registration({ responseProfile: 'other' })]), /MCP_OAUTH_RESPONSE_PROFILE_INVALID/);
    // a public client is refused when the server lists methods without "none"
    assert.throws(() => new McpOAuthProviderRegistry([registration({ tokenAuthMethod: 'none', clientSecretRef: undefined }, ['client_secret_post'])]), /MCP_OAUTH_TOKEN_AUTH_NOT_ADVERTISED/);
    // ...and tolerated when the server says nothing (legacy public registrations keep working)
    assert.doesNotThrow(() => new McpOAuthProviderRegistry([registration({ tokenAuthMethod: 'none', clientSecretRef: undefined }, null)]));
  });

  it('keeps the bearer-presentation endpoint on the verified resource origin', () => {
    assert.throws(() => new McpOAuthProviderRegistry([registration({ mcpEndpoint: 'https://evil.example/mcp' })]), /MCP_OAUTH_MCP_ENDPOINT_REJECTED/);
    assert.throws(() => new McpOAuthProviderRegistry([registration({ mcpEndpoint: 'http://mcp.example.org/mcp' })]), /MCP_OAUTH_MCP_ENDPOINT_REJECTED/);
    assert.throws(() => new McpOAuthProviderRegistry([registration({ mcpEndpoint: 'https://user:pw@mcp.example.org/mcp' })]), /MCP_OAUTH_MCP_ENDPOINT_REJECTED/);
  });
});

describe('callback applies the pinned authentication and fails closed', () => {
  function setup() {
    const registry = new McpOAuthProviderRegistry([{
      id: 'slack-like', clientId, redirectUri, resource, issuer, requestedScopes: ['search:read.public'], mcpEndpoint, tokenAuthMethod: 'client_secret_post', clientSecretRef: 'NAGEX_TEST_SECRET', responseProfile: 'slack-user-v2',
      protectedResourceMetadata: { resource, authorization_servers: [issuer], scopes_supported: ['search:read.public'] },
      authorizationServerMetadata: { issuer, authorization_endpoint: 'https://login.example.org/authorize', token_endpoint: endpoint, code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['client_secret_post'] },
    }]);
    const states = createMcpOAuthStateStore();
    const vault = new McpOAuthCredentialVault({ NAGEX_TOKEN_ENCRYPTION_KEY: 'cd'.repeat(32) });
    const calls: unknown[] = [];
    const deps = (secret: string | undefined, scope: string[] = ['search:read.public']) => ({
      stateStore: states, vault,
      resolveRequestedScopes: (p: any) => registry.requestedScopesFor(p),
      resolveTrustedTokenEndpoint: async (p: any) => registry.resolveTrustedTokenEndpoint(p),
      resolveClientAuthentication: (p: any) => {
        const pinned = registry.tokenClientAuthFor(p);
        if (pinned.method === 'client_secret_post' && !secret) throw new Error('missing');
        return { clientAuth: pinned.method === 'client_secret_post' ? { method: 'client_secret_post' as const, clientSecret: secret } : { method: 'none' as const }, responseProfile: pinned.responseProfile };
      },
      exchange: (async (_p: any, _c: any, _e: any, _r: any, options: any) => { calls.push(options); return { tokenType: 'Bearer' as const, accessToken: 'tok', refreshToken: null, expiresIn: 3600, scope }; }) as never,
    });
    const begin = () => new URL(registry.start('slack-like', owner, states)).searchParams.get('state')!;
    return { deps, begin, vault, calls, registry };
  }

  it('passes the resolved client authentication and profile to the exchange', async () => {
    const { deps, begin, vault, calls } = setup();
    const result = await completeMcpOAuthCallback(deps(SECRET), owner, { state: begin(), code: 'c' }, 'req');
    assert.equal(result.status, 'CREDENTIAL_STORED');
    assert.deepEqual(calls[0], { clientAuth: { method: 'client_secret_post', clientSecret: SECRET }, responseProfile: 'slack-user-v2' });
    assert.equal(vault.sealedSnapshot().length, 1);
    assert.doesNotMatch(JSON.stringify(vault.sealedSnapshot()), new RegExp(SECRET));
  });

  it('a missing operator secret fails closed: no exchange, nothing stored, the state is spent', async () => {
    const { deps, begin, vault, calls } = setup();
    const state = begin();
    await assert.rejects(() => completeMcpOAuthCallback(deps(undefined), owner, { state, code: 'c' }, 'req'), (e: any) => e.details?.reason === 'CLIENT_AUTH_UNAVAILABLE');
    assert.equal(calls.length, 0);
    assert.equal(vault.sealedSnapshot().length, 0);
    await assert.rejects(() => completeMcpOAuthCallback(deps(SECRET), owner, { state, code: 'c' }, 'req'), (e: any) => e.details?.reason === 'STATE_INVALID_OR_OWNER_MISMATCH');
  });

  it('a grant wider than requested, or a token with no reported scope, is never stored', async () => {
    const wide = setup();
    await assert.rejects(() => completeMcpOAuthCallback(wide.deps(SECRET, ['search:read.public', 'chat:write']), owner, { state: wide.begin(), code: 'c' }, 'req'), (e: any) => e.details?.reason === 'TOKEN_SCOPE_MISMATCH');
    const none = setup();
    await assert.rejects(() => completeMcpOAuthCallback(none.deps(SECRET, []), owner, { state: none.begin(), code: 'c' }, 'req'), (e: any) => e.details?.reason === 'TOKEN_SCOPE_MISMATCH');
    assert.equal(wide.vault.sealedSnapshot().length + none.vault.sealedSnapshot().length, 0);
  });
});
