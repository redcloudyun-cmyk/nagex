import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseProtectedResourceMetadata, parseAuthorizationServerMetadata } from '../src/mcp/mcp-oauth-metadata.js';

const resource = 'https://mcp.example.org/mcp';
const issuer = 'https://login.example.org/oauth';
const protectedDoc = () => ({ resource, authorization_servers: [issuer], scopes_supported: ['tools:read'] });
const authDoc = () => ({
  issuer, authorization_endpoint: 'https://login.example.org/oauth/authorize',
  token_endpoint: 'https://login.example.org/oauth/token', code_challenge_methods_supported: ['S256'],
});

describe('MCP OAuth discovery metadata, no outbound request', () => {
  it('accepts exact resource and HTTPS issuer with bounded metadata', () => {
    assert.deepEqual(parseProtectedResourceMetadata(protectedDoc(), resource), {
      resource, authorizationServers: [issuer], scopesSupported: ['tools:read'],
    });
    assert.deepEqual(parseAuthorizationServerMetadata(authDoc(), issuer), {
      issuer, authorizationEndpoint: 'https://login.example.org/oauth/authorize',
      tokenEndpoint: 'https://login.example.org/oauth/token', codeChallengeMethodsSupported: ['S256'],
    });
  });
  it('fails closed on resource confusion and issuer substitution', () => {
    assert.throws(() => parseProtectedResourceMetadata({ ...protectedDoc(), resource: 'https://evil.example/mcp' }, resource), /invalid OAuth metadata/);
    assert.throws(() => parseAuthorizationServerMetadata({ ...authDoc(), issuer: 'https://evil.example/oauth' }, issuer), /invalid OAuth metadata/);
  });
  it('rejects credentials, fragments, insecure and missing endpoint URLs', () => {
    for (const authorization_servers of [['http://login.example.org'], ['https://user:pass@login.example.org'], ['https://login.example.org/#fragment'], []]) {
      assert.throws(() => parseProtectedResourceMetadata({ ...protectedDoc(), authorization_servers }, resource));
    }
    for (const endpoint of ['http://login.example.org/token', 'https://login.example.org/token#x', 'https://user:pass@login.example.org/token', 'file:///etc/passwd', 'javascript:alert(1)']) {
      assert.throws(() => parseAuthorizationServerMetadata({ ...authDoc(), token_endpoint: endpoint }, issuer));
    }
  });
  it('requires PKCE S256 and bounded arrays', () => {
    assert.throws(() => parseAuthorizationServerMetadata({ ...authDoc(), code_challenge_methods_supported: ['plain'] }, issuer));
    assert.throws(() => parseAuthorizationServerMetadata({ ...authDoc(), code_challenge_methods_supported: undefined }, issuer));
    assert.throws(() => parseProtectedResourceMetadata({ ...protectedDoc(), authorization_servers: Array(9).fill(issuer) }, resource));
    assert.throws(() => parseProtectedResourceMetadata({ ...protectedDoc(), scopes_supported: [42] }, resource));
    assert.throws(() => parseProtectedResourceMetadata([], resource));
  });
});
