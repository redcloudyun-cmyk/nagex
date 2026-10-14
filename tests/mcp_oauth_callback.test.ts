import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { completeMcpOAuthCallback, type McpOAuthCallbackDeps } from '../src/mcp/mcp-oauth-callback.js';
import { createMcpOAuthStateStore } from '../src/mcp/mcp-oauth-state.js';
import { McpOAuthCredentialVault } from '../src/mcp/mcp-oauth-credential-vault.js';

const owner = { tenantId: 'tenant-test', principalId: 'user-test' };
const context = { resource: 'https://mcp.example.org/mcp', issuer: 'https://login.example.org', clientId: 'nagex-test', redirectUri: 'https://nagex.example.org/oauth/mcp/callback' };
const token = { tokenType: 'Bearer' as const, accessToken: 'secret-code-exchanged', refreshToken: null, expiresIn: 3600, scope: ['tools.read'] };
const env = { NAGEX_TOKEN_ENCRYPTION_KEY: '12'.repeat(32) };
function setup() {
  const stateStore = createMcpOAuthStateStore();
  const vault = new McpOAuthCredentialVault(env);
  let exchanges = 0;
  let resolved = 0;
  const deps: McpOAuthCallbackDeps = {
    stateStore, vault,
    resolveRequestedScopes: () => ['tools.read'],
    resolveTrustedTokenEndpoint: async (pending) => {
      resolved++;
      assert.equal(pending.issuer, context.issuer);
      return 'https://login.example.org/token';
    },
    exchange: async (pending, code, endpoint) => {
      exchanges++;
      assert.equal(code, 'test-code');
      assert.equal(endpoint, 'https://login.example.org/token');
      assert.equal(pending.owner.tenantId, owner.tenantId);
      return token;
    },
  };
  return { stateStore, vault, deps, getExchanges: () => exchanges, getResolves: () => resolved };
}
describe('MCP OAuth callback transaction', () => {
  it('completes one verified transaction, persists owner-scoped encrypted credentials, rejects replay', async () => {
    const p = setup();
    const issued = p.stateStore.issue(owner, context, 1000);
    const result = await completeMcpOAuthCallback(p.deps, owner, { state: issued.state, code: 'test-code' }, 'req_ok', 1001);
    assert.deepEqual(result, { status: 'CREDENTIAL_STORED', resource: context.resource, issuer: context.issuer, clientId: context.clientId, scopes: ['tools.read'] });
    const stored = p.vault.load({ ...owner, resource: context.resource, issuer: context.issuer, clientId: context.clientId });
    assert.deepEqual(stored?.tokens, token);
    assert.doesNotMatch(JSON.stringify(p.vault.sealedSnapshot()), /secret-code-exchanged/);
    await assert.rejects(() => completeMcpOAuthCallback(p.deps, owner, { state: issued.state, code: 'test-code' }, 'req_replay', 1002));
    assert.equal(p.getExchanges(), 1);
  });

  it('rejects a callback from a different tenant without calling the provider or writing tokens', async () => {
    const p = setup();
    const issued = p.stateStore.issue(owner, context, 1000);
    await assert.rejects(() => completeMcpOAuthCallback(p.deps, { ...owner, tenantId: 'other' }, { state: issued.state, code: 'test-code' }, 'req_wrong', 1001));
    assert.equal(p.getExchanges(), 0);
    assert.equal(p.getResolves(), 0);
    await assert.rejects(() => completeMcpOAuthCallback(p.deps, owner, { state: issued.state, code: 'test-code' }, 'req_replay', 1002));
  });

  it('consumes OAuth state on denial and missing code, and leaks no details to callers', async () => {
    for (const query of [{ error: 'access_denied' }, { code: '' }, { code: 42 }]) {
      const p = setup();
      const issued = p.stateStore.issue(owner, context, 1000);
      await assert.rejects(
        () => completeMcpOAuthCallback(p.deps, owner, { ...query, state: issued.state }, 'req_denied', 1001),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.doesNotMatch(err.message, /access_denied|test-code|secret/i);
          return true;
        },
      );
      assert.equal(p.getExchanges(), 0);
      await assert.rejects(() => completeMcpOAuthCallback(p.deps, owner, { state: issued.state, code: 'test-code' }, 'req_after_denied', 1002));
    }
  });

  it('rejects over-scoped, unspecified and unregistered grants without saving a token', async () => {
    for (const scope of [['tools.read', 'tools.admin'], [], ['tools.admin']]) {
      const p = setup();
      const issued = p.stateStore.issue(owner, context, 1000);
      p.deps.exchange = async () => ({ ...token, scope });
      await assert.rejects(
        () => completeMcpOAuthCallback(p.deps, owner, { state: issued.state, code: 'test-code' }, 'req_scope', 1001),
        /could not be completed/i,
      );
      assert.equal(p.vault.sealedSnapshot().length, 0, 'unexpected scope must not be stored');
      await assert.rejects(() => completeMcpOAuthCallback(p.deps, owner, { state: issued.state, code: 'test-code' }, 'req_replay', 1002));
    }
  });

  it('does not claim success when encrypted persistence fails; it still burns state', async () => {
    const p = setup();
    const issued = p.stateStore.issue(owner, context, 1000);
    p.deps.vault = { save: () => { throw new Error('storage offline'); } };
    await assert.rejects(() => completeMcpOAuthCallback(p.deps, owner, { state: issued.state, code: 'test-code' }, 'req_disk', 1001), /storage offline/);
    await assert.rejects(() => completeMcpOAuthCallback(p.deps, owner, { state: issued.state, code: 'test-code' }, 'req_replay', 1002));
  });
});
