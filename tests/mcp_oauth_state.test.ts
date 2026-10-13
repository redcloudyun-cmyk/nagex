import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';
import { buildMcpOAuthAuthorizeUrl, createMcpOAuthStateStore, MCP_OAUTH_STATE_TTL_MS } from '../src/mcp/mcp-oauth-state.js';

const owner = { tenantId: 'ten-a', principalId: 'user-a' };
const other = { tenantId: 'ten-b', principalId: 'user-a' };
const context = { resource: 'https://mcp.example.org/mcp', issuer: 'https://id.example.org', clientId: 'nge-client', redirectUri: 'https://nagex.example.org/oauth/mcp/callback' };

describe('MCP OAuth pending authorization state', () => {
  it('generates a real S256 challenge and binds the verifier to its one-time state', () => {
    const store = createMcpOAuthStateStore();
    const request = store.issue(owner, context, 1000);
    assert.match(request.state, /^[A-Za-z0-9_-]{43}$/);
    assert.match(request.codeChallenge, /^[A-Za-z0-9_-]{43}$/);
    const pending = store.consume(request.state, owner, 1001);
    assert.ok(pending);
    assert.equal(crypto.createHash('sha256').update(pending.codeVerifier, 'ascii').digest('base64url'), request.codeChallenge);
    assert.equal(store.consume(request.state, owner, 1002), null, 'replay is refused');
  });
  it('rejects a forged tenant and burns the mismatched state', () => {
    const store = createMcpOAuthStateStore();
    const request = store.issue(owner, context, 1000);
    assert.equal(store.consume(request.state, other, 1001), null);
    assert.equal(store.consume(request.state, owner, 1002), null);
  });
  it('rejects expiration, future-state clock reversal and malformed input', () => {
    const store = createMcpOAuthStateStore();
    const request = store.issue(owner, context, 1000);
    assert.equal(store.consume(request.state, owner, 1000 + MCP_OAUTH_STATE_TTL_MS), null);
    const future = store.issue(owner, context, 3000);
    assert.equal(store.consume(future.state, owner, 2999), null);
    assert.equal(store.consume('fake', owner), null);
  });
  it('builds authorization code URL with state, PKCE and exact resource audience', () => {
    const store = createMcpOAuthStateStore();
    const request = store.issue(owner, context, 1000);
    const uri = buildMcpOAuthAuthorizeUrl({
      authorizationEndpoint: 'https://id.example.org/authorize', clientId: context.clientId,
      redirectUri: context.redirectUri, resource: context.resource, scope: ['read:tools'], request,
    });
    const url = new URL(uri);
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('state'), request.state);
    assert.equal(url.searchParams.get('code_challenge'), request.codeChallenge);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('resource'), context.resource);
    assert.equal(url.searchParams.get('redirect_uri'), context.redirectUri);
  });
  it('refuses query parameter injection, unsafe endpoints and invalid scopes', () => {
    const request = createMcpOAuthStateStore().issue(owner, context);
    const params = { authorizationEndpoint: 'https://id.example.org/authorize', clientId: context.clientId, redirectUri: context.redirectUri, resource: context.resource, request };
    assert.throws(() => buildMcpOAuthAuthorizeUrl({ ...params, authorizationEndpoint: 'https://id.example.org/authorize?state=evil' }));
    assert.throws(() => buildMcpOAuthAuthorizeUrl({ ...params, authorizationEndpoint: 'http://id.example.org/authorize' }));
    assert.throws(() => buildMcpOAuthAuthorizeUrl({ ...params, scope: ['bad scope'] }));
    assert.throws(() => createMcpOAuthStateStore().issue(owner, { ...context, redirectUri: 'javascript:alert(1)' }));
  });
});
