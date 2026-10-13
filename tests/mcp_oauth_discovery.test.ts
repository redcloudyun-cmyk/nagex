import assert from 'node:assert/strict';
import http from 'node:http';
import { after, describe, it } from 'node:test';
import { getMcpOAuthMetadata } from '../src/mcp/mcp-oauth-discovery.js';

const policy = { allowPrivateNetwork: true };
describe('MCP OAuth guarded discovery', () => {
  it('fetches a real bounded JSON response over local HTTP only under explicit test policy', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ resource: 'https://example.org/mcp', authorization_servers: ['https://auth.example.org'] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const url = `http://127.0.0.1:${address.port}/.well-known/oauth-protected-resource`;
      await assert.rejects(() => getMcpOAuthMetadata(url, 'req_live_local'), /MCP server URL must use https|MCP server URL/);
      const doc = await getMcpOAuthMetadata(url, 'req_test_local', { policy }) as Record<string, unknown>;
      assert.equal(doc.resource, 'https://example.org/mcp');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('rejects redirect before following it', async () => {
    let fetchCount = 0;
    await assert.rejects(() => getMcpOAuthMetadata('https://metadata.example.org/doc', 'req_redirect', {
      policy: { resolve: async () => ['8.8.8.8'] },
      get: async () => { fetchCount++; return { status: 302, contentType: 'application/json', body: '{}'}; },
    }), /Could not safely discover/);
    assert.equal(fetchCount, 1);
  });

  it('rejects invalid JSON, oversized payload, content type and upstream auth failures', async () => {
    const opts = { policy: { resolve: async () => ['8.8.8.8'] } };
    for (const response of [
      { status: 200, contentType: 'text/html', body: '{}' },
      { status: 200, contentType: 'application/json', body: 'not-json' },
      { status: 401, contentType: 'application/json', body: '{}' },
      { status: 200, contentType: 'application/json', body: ' '.repeat(65 * 1024) },
    ]) {
      await assert.rejects(() => getMcpOAuthMetadata('https://metadata.example.org/doc', 'req_bad', { ...opts, get: async () => response }));
    }
  });

  it('refuses unsafe addresses before issuing any HTTP request', async () => {
    let called = false;
    const get = async () => { called = true; return { status: 200, contentType: 'application/json', body: '{}' }; };
    await assert.rejects(() => getMcpOAuthMetadata('http://127.0.0.1/private', 'req_private', { get }));
    await assert.rejects(() => getMcpOAuthMetadata('https://localhost/.well-known/oauth', 'req_localhost', { get }));
    await assert.rejects(() => getMcpOAuthMetadata('https://metadata.example.org/doc', 'req_dns', { policy: { resolve: async () => ['10.1.2.3'] }, get }));
    assert.equal(called, false);
  });
});
