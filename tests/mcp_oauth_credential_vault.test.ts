import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';
import { McpOAuthCredentialVault } from '../src/mcp/mcp-oauth-credential-vault.js';

const env = { NAGEX_TOKEN_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex') };
const identity = { tenantId: 'tenant-a', principalId: 'user-a', resource: 'https://mcp.example.org/mcp', issuer: 'https://id.example.org', clientId: 'client-a' };
const tokens = { accessToken: 'access-secret-123', refreshToken: 'refresh-secret-456', tokenType: 'Bearer' as const, expiresIn: 3600, scope: ['tools.read'] };

describe('MCP OAuth owner-bound encrypted credential vault', () => {
  it('refuses storage when key is unavailable or invalid', () => {
    assert.throws(() => new McpOAuthCredentialVault({}), /MCP_OAUTH_ENCRYPTION_REQUIRED/);
    assert.throws(() => new McpOAuthCredentialVault({ NAGEX_TOKEN_ENCRYPTION_KEY: 'bad' }), /MCP_OAUTH_ENCRYPTION_REQUIRED/);
  });
  it('seals credentials and only loads for the same complete tenant/user/resource/issuer/client tuple', () => {
    const vault = new McpOAuthCredentialVault(env);
    vault.save(identity, tokens, 42);
    const snapshot = JSON.stringify(vault.sealedSnapshot());
    assert.doesNotMatch(snapshot, /access-secret-123|refresh-secret-456/);
    assert.deepEqual(vault.load(identity), { identity, tokens, storedAt: 42 });
    for (const foreign of [
      { ...identity, tenantId: 'tenant-b' }, { ...identity, principalId: 'user-b' },
      { ...identity, resource: 'https://other.example.org/mcp' },
      { ...identity, issuer: 'https://other-id.example.org' },
      { ...identity, clientId: 'another-client' },
    ]) assert.equal(vault.load(foreign), null);
  });
  it('disconnect deletes only the requested connection, without touching other users', () => {
    const vault = new McpOAuthCredentialVault(env);
    const other = { ...identity, principalId: 'user-b' };
    vault.save(identity, tokens);
    vault.save(other, tokens);
    assert.equal(vault.remove(identity), true);
    assert.equal(vault.load(identity), null);
    assert.ok(vault.load(other));
    assert.equal(vault.remove(identity), false);
  });
});
