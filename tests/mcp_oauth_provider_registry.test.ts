import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { McpOAuthProviderRegistry } from '../src/mcp/mcp-oauth-provider-registry.js';
import { createMcpOAuthStateStore } from '../src/mcp/mcp-oauth-state.js';

const resource = 'https://mcp.example.org/mcp';
const issuer = 'https://id.example.org/oauth';
const callback = 'https://nagex.example.org/api/v1/oauth/mcp/callback';
const record = () => ({
  id: 'verified-provider', resource, issuer, clientId: 'registered-client',
  redirectUri: callback, requestedScopes: ['tools.read'],
  protectedResourceMetadata: { resource, authorization_servers: [issuer], scopes_supported: ['tools.read'] },
  authorizationServerMetadata: { issuer, authorization_endpoint: 'https://id.example.org/oauth/authorize',
    token_endpoint: 'https://id.example.org/oauth/token', code_challenge_methods_supported: ['S256'] },
});
const owner = { tenantId: 'tenant-a', principalId: 'principal-a' };

describe('operator-certified MCP OAuth provider registry', () => {
  it('produces only a verified provider authorize URL with bound PKCE and a fixed callback', () => {
    const registry = new McpOAuthProviderRegistry([record()]);
    const states = createMcpOAuthStateStore();
    const url = new URL(registry.start('verified-provider', owner, states));
    assert.equal(url.origin, 'https://id.example.org');
    assert.equal(url.searchParams.get('client_id'), 'registered-client');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('redirect_uri'), callback);
    assert.equal(url.searchParams.get('resource'), resource);
    assert.equal(url.searchParams.get('scope'), 'tools.read');
    const pending = states.consume(url.searchParams.get('state')!, owner);
    assert.ok(pending);
    assert.equal(registry.resolveTrustedTokenEndpoint(pending), 'https://id.example.org/oauth/token');
  });
  it('refuses unregistered providers and substituted trusted token identities', () => {
    const registry = new McpOAuthProviderRegistry([record()]);
    const states = createMcpOAuthStateStore();
    assert.throws(() => registry.start('attacker-provider', owner, states));
    const url = new URL(registry.start('verified-provider', owner, states));
    const pending = states.consume(url.searchParams.get('state')!, owner);
    assert.ok(pending);
    assert.throws(() => registry.resolveTrustedTokenEndpoint({ ...pending, clientId: 'forged-client' }));
    assert.throws(() => registry.resolveTrustedTokenEndpoint({ ...pending, resource: 'https://evil.example/mcp' }));
  });
  it('rejects issuer substitution, unadvertised scope, callback manipulation and duplicate ids', () => {
    assert.throws(() => new McpOAuthProviderRegistry([{ ...record(), issuer: 'https://different.example' }]));
    assert.throws(() => new McpOAuthProviderRegistry([{ ...record(), requestedScopes: ['admin'] }]));
    assert.throws(() => new McpOAuthProviderRegistry([{ ...record(), redirectUri: 'https://evil.example/callback' }]));
    assert.throws(() => new McpOAuthProviderRegistry([record(), record()]));
  });
});
