import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { handleAsyncApiRequest } from '../src/server_web.js';
import { authAs } from './_s1_session_auth.js';

describe('MCP OAuth callback HTTP fail-closed integration', () => {
  it('does not disclose callback data to unauthenticated visitors', async () => {
    const result = await handleAsyncApiRequest('GET', '/api/v1/oauth/mcp/callback', null, {}, undefined, {
      state: 'forged-state', code: 'private-code',
    });
    assert.equal(result.status, 401);
    assert.doesNotMatch(JSON.stringify(result.data), /forged-state|private-code/);
  });

  it('requires operator-configured trusted OAuth coordinator; never claims connected', async () => {
    const owner = authAs('tenant-mcp', 'user-mcp');
    const result = await handleAsyncApiRequest('GET', '/api/v1/oauth/mcp/callback', null, owner, undefined, {
      state: 'forged-state', code: 'private-code', token_endpoint: 'https://attacker.example/token',
    });
    assert.equal(result.status, 503);
    assert.equal((result.data as any).error.code, 'MCP_OAUTH_NOT_CONFIGURED');
    assert.doesNotMatch(JSON.stringify(result.data), /forged-state|private-code|attacker/);
  });

  it('rejects unconfigured or unauthenticated OAuth start and refuses arbitrary caller provider URLs', async () => {
    const path = '/api/v1/oauth/mcp/start';
    const signedOut = await handleAsyncApiRequest('POST', path, { providerId: 'verified-provider' }, {});
    assert.equal(signedOut.status, 401);
    const owner = authAs('tenant-mcp', 'user-mcp');
    const notConfigured = await handleAsyncApiRequest('POST', path, {
      providerId: 'verified-provider',
      tokenEndpoint: 'https://attacker.example/token',
      redirectUri: 'https://attacker.example/callback',
    }, owner);
    assert.equal(notConfigured.status, 503);
    assert.equal((notConfigured.data as any).error.code, 'MCP_OAUTH_NOT_CONFIGURED');
    assert.doesNotMatch(JSON.stringify(notConfigured.data), /attacker/);
    const wrongMethod = await handleAsyncApiRequest('GET', path, null, owner);
    assert.equal(wrongMethod.status, 405);
  });

  it('rejects non-GET methods without consuming OAuth state', async () => {
    const result = await handleAsyncApiRequest('POST', '/api/v1/oauth/mcp/callback', {}, authAs('tenant-mcp', 'user-mcp'));
    assert.equal(result.status, 405);
  });
});
