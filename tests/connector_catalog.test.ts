// Normalized connector catalog: the definitions are honest (nothing LIVE without an engine behind it, nothing PLANNED/UNSUPPORTED can look connected) and the
// per-user connection state is read from the real stores - never invented, never shared between users.
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { CapabilityRegistry } from '../src/capabilities/capability.registry.js';
import { CAPABILITY_BACKING, CALENDAR_SCOPE, CONNECTOR_CATALOG, CONNECTOR_CATEGORIES, GMAIL_SCOPE } from '../src/connectors/connector-catalog.js';
import { ConnectorCatalogService, type ConnectorStateSources } from '../src/connectors/connector-catalog.service.js';
import { handleAsyncApiRequest } from '../src/server_web.js';
import { authAs } from './_s1_session_auth.js';

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ME = { tenantId: 'ten_cat', principalId: 'usr_cat_a' };
const byId = async (sources: ConnectorStateSources) => new Map((await new ConnectorCatalogService(sources).resolve(ME)).connectors.map((connector) => [connector.id, connector]));

describe('catalog definitions', () => {
  it('has stable unique ids, a valid category, an icon and English + Korean copy for every connector', () => {
    const categories = new Set(CONNECTOR_CATEGORIES.map((category) => category.id));
    const seen = new Set<string>();
    for (const connector of CONNECTOR_CATALOG) {
      assert.match(connector.id, ID_PATTERN, connector.id);
      assert.equal(seen.has(connector.id), false, `duplicate id ${connector.id}`);
      seen.add(connector.id);
      assert.ok(categories.has(connector.category), `${connector.id} category`);
      assert.ok(connector.icon && connector.provider && connector.name, `${connector.id} basics`);
      assert.ok(connector.description.en.trim() && /[가-힣]/.test(connector.description.ko), `${connector.id} description EN + KO`);
    }
    for (const category of CONNECTOR_CATEGORIES) assert.ok(category.label.en && /[가-힣]/.test(category.label.ko), `${category.id} label`);
  });

  it('a LIVE connector claims only capabilities that real registry entries back, and has a real state source', () => {
    const registry = new CapabilityRegistry();
    for (const connector of CONNECTOR_CATALOG.filter((entry) => entry.availability === 'LIVE')) {
      assert.ok(connector.stateSource, `${connector.id} needs a real state source`);
      assert.ok(connector.capabilities.length > 0, `${connector.id} must say what it can do`);
      for (const token of connector.capabilities) {
        assert.ok(token in CAPABILITY_BACKING, `${connector.id}: unknown capability token ${token}`);
        for (const capabilityId of CAPABILITY_BACKING[token]) assert.equal(registry.has(capabilityId), true, `${token} -> ${capabilityId} is not a registered capability`);
      }
    }
  });

  it('a PLANNED or UNSUPPORTED connector advertises no capability, has no state source, and states what it would need', () => {
    for (const connector of CONNECTOR_CATALOG.filter((entry) => entry.availability !== 'LIVE')) {
      assert.deepEqual(connector.capabilities, [], `${connector.id} must not advertise capabilities`);
      assert.equal(connector.stateSource, null, connector.id);
      assert.ok(connector.setup && connector.setup.en.trim() && /[가-힣]/.test(connector.setup.ko), `${connector.id} must explain the requirement in EN + KR`);
      assert.match(connector.setup!.en, /^(Not available yet|Not supported)/, `${connector.id} must say plainly that it is not available`);
    }
  });

  it('records the status of every provider the AGEX catalog showed that the product asked about', () => {
    const expected: Record<string, string> = { slack: 'LIVE', 'microsoft-teams': 'PLANNED', zoom: 'PLANNED', 'world-bank': 'PLANNED', similarweb: 'UNSUPPORTED', x: 'UNSUPPORTED', coingecko: 'PLANNED', ahrefs: 'UNSUPPORTED', brand24: 'UNSUPPORTED', morningstar: 'UNSUPPORTED' };
    for (const [id, availability] of Object.entries(expected)) assert.equal(CONNECTOR_CATALOG.find((entry) => entry.id === id)?.availability, availability, id);
  });
});

describe('connection state comes from the real sources', () => {
  it('a source saying CONNECTED never makes a PLANNED or UNSUPPORTED connector connected, and unwired sources are unavailable (not "not connected")', async () => {
    const all = await byId({
      google: async () => ({ state: 'CONNECTED', reason: null, scopes: [GMAIL_SCOPE, CALENDAR_SCOPE] }),
      github: async () => ({ state: 'CONNECTED', reason: null, account: 'octocat' }),
      slack: () => ({ configured: true, linked: 1, account: 'Acme' }),
      telegram: () => ({ configured: true, linked: 1, account: null }),
      mcp: () => ({ servers: [{ status: 'CONNECTED' }] }),
    });
    for (const connector of all.values()) {
      if (connector.availability === 'LIVE') assert.equal(connector.connection.state, 'CONNECTED', connector.id);
      else assert.equal(connector.connection.state, 'UNAVAILABLE', `${connector.id} cannot be connected`);
    }
    assert.equal(all.get('github')!.connection.account, 'octocat');
    const none = await byId({});
    for (const connector of none.values()) assert.equal(connector.connection.state, 'UNAVAILABLE', connector.id);
  });

  it('Gmail and Calendar share ONE read of the Google grant and each shows its own scope truth', async () => {
    let reads = 0;
    const all = await byId({ google: async () => { reads += 1; return { state: 'CONNECTED', reason: null, scopes: [CALENDAR_SCOPE] }; } });
    assert.equal(reads, 1);
    assert.equal(all.get('google-calendar')!.connection.state, 'CONNECTED');
    assert.deepEqual({ state: all.get('gmail')!.connection.state, reason: all.get('gmail')!.connection.reason }, { state: 'REAUTH_REQUIRED', reason: 'MISSING_SCOPE' });
  });

  it('OAuth states map faithfully: not configured -> setup required, revoked -> reconnect, provider failure -> error', async () => {
    const check = async (state: 'UNAVAILABLE' | 'NOT_CONNECTED' | 'CONNECTING' | 'REAUTH_REQUIRED' | 'ERROR', expected: string) => {
      const all = await byId({ google: async () => ({ state, reason: null, scopes: [] }), github: async () => ({ state, reason: null, account: null }) });
      assert.equal(all.get('gmail')!.connection.state, expected, `google ${state}`);
      assert.equal(all.get('github')!.connection.state, expected, `github ${state}`);
    };
    await check('UNAVAILABLE', 'SETUP_REQUIRED');
    await check('NOT_CONNECTED', 'NOT_CONNECTED');
    await check('CONNECTING', 'CONNECTING');
    await check('REAUTH_REQUIRED', 'REAUTH_REQUIRED');
    await check('ERROR', 'ERROR');
  });

  it('a source that throws is an ERROR for its connectors only - never connected, never silently "not connected"', async () => {
    const all = await byId({ google: async () => { throw new Error('boom'); }, github: async () => ({ state: 'NOT_CONNECTED', reason: null, account: null }) });
    assert.equal(all.get('gmail')!.connection.state, 'ERROR');
    assert.equal(all.get('google-calendar')!.connection.state, 'ERROR');
    assert.equal(all.get('github')!.connection.state, 'NOT_CONNECTED');
  });

  it('chat channels: not configured on the server -> setup required; configured but not linked -> not connected; linked -> connected with a count', async () => {
    const slack = async (status: { configured: boolean; linked: number }) => (await byId({ slack: () => ({ ...status, account: null }) })).get('slack')!.connection;
    assert.equal((await slack({ configured: false, linked: 0 })).state, 'SETUP_REQUIRED');
    assert.equal((await slack({ configured: false, linked: 3 })).state, 'SETUP_REQUIRED', 'links cannot make an unconfigured server connected');
    assert.equal((await slack({ configured: true, linked: 0 })).state, 'NOT_CONNECTED');
    const linked = await slack({ configured: true, linked: 2 });
    assert.deepEqual({ state: linked.state, count: linked.count }, { state: 'CONNECTED', count: 2 });
  });

  it('custom MCP servers: none -> not connected; a rejected credential or changed identity surfaces as reconnect; all unreachable -> error', async () => {
    const mcp = async (statuses: string[]) => (await byId({ mcp: () => ({ servers: statuses.map((status) => ({ status })) }) })).get('mcp-custom')!.connection;
    assert.equal((await mcp([])).state, 'NOT_CONNECTED');
    assert.deepEqual(await mcp(['CONNECTED', 'CONNECTED']), { state: 'CONNECTED', reason: null, account: null, count: 2 });
    assert.deepEqual({ ...(await mcp(['CONNECTED', 'AUTH_REQUIRED'])) }, { state: 'REAUTH_REQUIRED', reason: 'CREDENTIAL_REJECTED', account: null, count: 2 });
    assert.equal((await mcp(['IDENTITY_MISMATCH'])).reason, 'SERVER_IDENTITY_CHANGED');
    assert.equal((await mcp(['ERROR'])).state, 'ERROR');
  });
});

describe('server-owned connect actions (not optimistic UI badges)', () => {
  it('offers OAuth only when the actual provider is configured, and never for unsupported apps', async () => {
    const available = await byId({
      google: async () => ({ state: 'NOT_CONNECTED', reason: null, scopes: [] }),
      github: async () => ({ state: 'NOT_CONNECTED', reason: null, account: null }),
      slack: () => ({ configured: true, linked: 0, account: null }),
      telegram: () => ({ configured: false, linked: 0, account: null }),
      mcp: () => ({ servers: [] }),
    });
    assert.deepEqual(available.get('gmail')!.action, { kind: 'OAUTH', provider: 'google', startPath: '/api/v1/oauth/google/start' });
    assert.deepEqual(available.get('google-calendar')!.action, { kind: 'OAUTH', provider: 'google', startPath: '/api/v1/oauth/google/start' });
    assert.deepEqual(available.get('github')!.action, { kind: 'OAUTH', provider: 'github', startPath: '/api/v1/oauth/github/start' });
    assert.deepEqual(available.get('slack')!.action, { kind: 'CHANNEL_LINK', provider: 'slack', startPath: '/api/v1/integrations/slack/identity/link/challenge' });
    assert.equal(available.get('telegram')!.action.kind, 'NONE');
    assert.equal(available.get('mcp-custom')!.action.kind, 'ADVANCED_MCP');
    for (const entry of available.values()) {
      if (entry.availability !== 'LIVE') assert.equal(entry.action.kind, 'NONE', entry.id);
    }

    const unconfigured = await byId({
      google: async () => ({ state: 'UNAVAILABLE', reason: 'OAUTH_NOT_CONFIGURED', scopes: [] }),
      github: async () => ({ state: 'UNAVAILABLE', reason: 'OAUTH_NOT_CONFIGURED', account: null }),
    });
    assert.equal(unconfigured.get('gmail')!.action.kind, 'NONE');
    assert.equal(unconfigured.get('github')!.action.kind, 'NONE');
  });

  it('does not issue a second Connect action after connection; missing Google scope needs explicit reauthorization', async () => {
    const connected = await byId({
      google: async () => ({ state: 'CONNECTED', reason: null, scopes: [CALENDAR_SCOPE] }),
      github: async () => ({ state: 'CONNECTED', reason: null, account: 'octocat' }),
    });
    assert.deepEqual(connected.get('google-calendar')!.action, { kind: 'NONE', reason: 'ALREADY_CONNECTED' });
    assert.equal(connected.get('github')!.action.kind, 'NONE');
    assert.deepEqual(connected.get('gmail')!.action, { kind: 'OAUTH', provider: 'google', startPath: '/api/v1/oauth/google/start' });
  });
});

describe('HTTP: GET /api/v1/connectors/catalog', () => {
  const envBackup = process.env.NAGEX_MCP_ALLOW_PRIVATE_NETWORK;
  let testServer: { url: string; close(): Promise<void> };
  before(async () => {
    process.env.NAGEX_MCP_ALLOW_PRIVATE_NETWORK = '1';
    const mod = await import(pathToFileURL(path.resolve('scripts/mcp-test-server.mjs')).href);
    testServer = await mod.startMcpTestServer({ token: 'catalog-token' });
  });
  after(async () => {
    await testServer.close();
    if (envBackup === undefined) delete process.env.NAGEX_MCP_ALLOW_PRIVATE_NETWORK; else process.env.NAGEX_MCP_ALLOW_PRIVATE_NETWORK = envBackup;
  });
  const call = (method: string, pathname: string, body: Record<string, unknown> | null, headers: Record<string, string>) => handleAsyncApiRequest(method, pathname, body, headers);

  it('requires a session, and returns the same catalog shape for everyone', async () => {
    assert.equal((await call('GET', '/api/v1/connectors/catalog', null, {})).status, 401);
    const res = await call('GET', '/api/v1/connectors/catalog', null, authAs('ten_cat', 'usr_cat_http_a'));
    assert.equal(res.status, 200);
    const data = res.data as any;
    assert.equal(data.connectors.length, CONNECTOR_CATALOG.length);
    assert.deepEqual(data.categories.map((category: any) => category.id), CONNECTOR_CATEGORIES.map((category) => category.id));
    const stateOf = (id: string) => data.connectors.find((connector: any) => connector.id === id).connection.state;
    for (const id of ['gmail', 'google-calendar', 'github']) assert.ok(['NOT_CONNECTED', 'SETUP_REQUIRED'].includes(stateOf(id)), `${id} for a fresh user is ${stateOf(id)}`);
    for (const connector of data.connectors.filter((entry: any) => entry.availability !== 'LIVE')) {
      assert.equal(connector.connection.state, 'UNAVAILABLE', connector.id);
      assert.equal(connector.action.kind, 'NONE', connector.id);
    }
    for (const connector of data.connectors) {
      if (connector.action.kind === 'OAUTH') {
        assert.ok(['/api/v1/oauth/google/start', '/api/v1/oauth/github/start'].includes(connector.action.startPath));
        assert.equal(connector.availability, 'LIVE');
      }
    }
    assert.doesNotMatch(JSON.stringify(data), /bearerToken|catalog-token|access_token|client_secret/i);
  });

  it('shows a custom MCP server as connected only for its owner', async () => {
    const owner = authAs('ten_cat', 'usr_cat_http_owner');
    const other = authAs('ten_cat', 'usr_cat_http_other');
    const mcpState = async (headers: Record<string, string>) => ((await call('GET', '/api/v1/connectors/catalog', null, headers)).data as any).connectors.find((connector: any) => connector.id === 'mcp-custom').connection;
    assert.equal((await mcpState(owner)).state, 'NOT_CONNECTED');
    const added = await call('POST', '/api/v1/mcp/servers', { name: 'Catalog test', url: testServer.url, bearerToken: 'catalog-token' }, owner);
    assert.equal(added.status, 201, JSON.stringify(added.data));
    assert.deepEqual(await mcpState(owner), { state: 'CONNECTED', reason: null, account: null, count: 1 });
    assert.equal((await mcpState(other)).state, 'NOT_CONNECTED', 'another user does not see it');
    const forged = { ...other, 'X-Principal-Id': 'usr_cat_http_owner', 'X-NAgex-Tenant': 'ten_cat' };
    assert.equal((await mcpState(forged)).state, 'NOT_CONNECTED', 'forged identity headers are ignored');
    await call('DELETE', `/api/v1/mcp/servers/${(added.data as any).server.connectionId}`, null, owner);
    assert.equal((await mcpState(owner)).state, 'NOT_CONNECTED');
  });
});
