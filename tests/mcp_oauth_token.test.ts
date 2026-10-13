import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { exchangeMcpOAuthCode } from '../src/mcp/mcp-oauth-token.js';
import { createMcpOAuthStateStore } from '../src/mcp/mcp-oauth-state.js';

const owner = { tenantId: 'tenant-a', principalId: 'user-a' };
const resource = 'https://mcp.example.org/mcp';
const issuer = 'https://auth.example.org';
const clientId = 'nagex-client';
const redirectUri = 'https://nagex.example.org/oauth/mcp/callback';
const newPending = () => {
  const store = createMcpOAuthStateStore();
  const request = store.issue(owner, { resource, issuer, clientId, redirectUri });
  const pending = store.consume(request.state, owner);
  assert.ok(pending);
  return pending;
};
const policy = { resolve: async () => ['8.8.8.8'] };
const endpoint = issuer + '/token';

describe('MCP OAuth guarded authorization code exchange', () => {
  it('sends exact client, PKCE verifier, callback URI and resource only via form POST', async () => {
    const pending = newPending();
    let form: URLSearchParams | undefined;
    const tokens = await exchangeMcpOAuthCode(pending, 'code-abc', endpoint, 'req_test', {
      policy,
      post: async (url, body) => {
        assert.equal(url.href, endpoint);
        form = new URLSearchParams(body);
        return { status: 200, contentType: 'application/json', body: JSON.stringify({ token_type: 'Bearer', access_token: 'secret-access', refresh_token: 'secret-refresh', expires_in: 3600, scope: 'tools.read tools.write' }) };
      },
    });
    assert.equal(form?.get('grant_type'), 'authorization_code');
    assert.equal(form?.get('code'), 'code-abc');
    assert.equal(form?.get('code_verifier'), pending.codeVerifier);
    assert.equal(form?.get('resource'), resource);
    assert.equal(form?.get('client_id'), clientId);
    assert.equal(form?.get('redirect_uri'), redirectUri);
    assert.equal(tokens.accessToken, 'secret-access');
    assert.equal(tokens.refreshToken, 'secret-refresh');
    assert.deepEqual(tokens.scope, ['tools.read', 'tools.write']);
  });

  it('rejects non-Bearer, missing access token, invalid expiry and oversized token response', async () => {
    for (const raw of [
      { token_type: 'DPoP', access_token: 'secret' },
      { token_type: 'Bearer' },
      { token_type: 'Bearer', access_token: 'secret', expires_in: -1 },
      { token_type: 'Bearer', access_token: 'secret', refresh_token: '' },
      { token_type: 'Bearer', access_token: 'secret', scope: 123 },
    ]) {
      await assert.rejects(() => exchangeMcpOAuthCode(newPending(), 'code', endpoint, 'req_bad', {
        policy, post: async () => ({ status: 200, contentType: 'application/json', body: JSON.stringify(raw) }),
      }), /Could not securely complete/);
    }
    await assert.rejects(() => exchangeMcpOAuthCode(newPending(), 'code', endpoint, 'req_large', {
      policy, post: async () => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ token_type: 'Bearer', access_token: 'x'.repeat(17000) }) }),
    }));
  });

  it('rejects redirects, HTML, invalid JSON and token endpoint errors without exposing response secrets', async () => {
    for (const response of [
      { status: 302, contentType: 'application/json', body: '{}' },
      { status: 200, contentType: 'text/html', body: '{}' },
      { status: 400, contentType: 'application/json', body: '{"error_description":"secret-details"}' },
      { status: 200, contentType: 'application/json', body: '{' },
    ]) {
      await assert.rejects(() => exchangeMcpOAuthCode(newPending(), 'code', endpoint, 'req_failure', {
        policy, post: async () => response,
      }), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, /secret-details/);
        return true;
      });
    }
  });

  it('never posts to a disallowed private URL, query-injected endpoint or unresolvable host', async () => {
    let called = false;
    const post = async () => { called = true; return { status: 200, contentType: 'application/json', body: '{}' }; };
    await assert.rejects(() => exchangeMcpOAuthCode(newPending(), 'code', 'http://127.0.0.1/token', 'req_http', { post }));
    await assert.rejects(() => exchangeMcpOAuthCode(newPending(), 'code', 'https://localhost/token', 'req_localhost', { post }));
    await assert.rejects(() => exchangeMcpOAuthCode(newPending(), 'code', endpoint + '?redirect=evil', 'req_query', { policy, post }));
    await assert.rejects(() => exchangeMcpOAuthCode(newPending(), 'code', endpoint, 'req_private', { policy: { resolve: async () => ['10.0.0.10'] }, post }));
    assert.equal(called, false);
  });
});
