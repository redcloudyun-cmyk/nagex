// End-to-end of the MCP OAuth product journey against a LOCAL FAKE provider that mimics Slack's shape (confidential client, client_secret_post, "user" tokens, ok:false
// on HTTP 200) and an ISOLATED MCP server (scripts/mcp-test-server.mjs) that only accepts the token the fake provider issued:
//   operator registration -> start (PKCE) -> authenticated callback -> encrypted owner-bound token -> MCP initialize + tools/list -> tools OFF -> enable ->
//   existing Human Approval -> one-time broker-governed call -> truthful, UNVERIFIED result; plus expiry, restart, revoke, disconnect and isolation.
// This is NOT a real-provider certification: no Slack workspace, app or account is contacted. Provider and MCP hosts are fake https names that are never resolved;
// the wire-level forms are asserted on loopback servers.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import { after, before, beforeEach, afterEach, describe, it } from 'node:test';
import { AuditLogger } from '../src/governance/audit.logger.js';
import { ActionApprovalStore } from '../src/governance/action-approval.store.js';
import { ExecutionStore } from '../src/governance/execution.store.js';
import { CapabilityBroker } from '../src/capabilities/capability-broker.js';
import { CapabilityRegistry } from '../src/capabilities/capability.registry.js';
import { PersistentMcpConnectionStore } from '../src/mcp/mcp-connection.store.js';
import { McpService } from '../src/mcp/mcp.service.js';
import { createHttpMcpTransport } from '../src/mcp/mcp-client.js';
import { McpOAuthRuntime } from '../src/mcp/mcp-oauth-runtime.js';
import type { McpOAuthProviderTemplate } from '../src/mcp/mcp-oauth-providers.js';
import { exchangeMcpOAuthCode } from '../src/mcp/mcp-oauth-token.js';
import { handleMcpOAuthRoutes } from '../src/http/routes/mcp-oauth.routes.js';
import { handleMcpRoutes } from '../src/http/routes/mcp.routes.js';
import { identityStore, sessionStore } from '../src/server_web.js';
import { authAs } from './_s1_session_auth.js';

const RESOURCE = 'https://mcp.fakeslack.test';
const MCP_URL = 'https://mcp.fakeslack.test/mcp';
const AUTHORIZE = 'https://fakeslack.test/oauth/v2_user/authorize';
const TOKEN_URL = 'https://fakeslack.test/api/oauth.v2.user.access';
const CALLBACK = 'https://nagex.example.test/api/v1/oauth/mcp/callback';
const SECRET = 'fake-operator-client-secret-aaaa1111';
const CLIENT_ID = 'fake-operator-client-1';
const SCOPES = ['search:read.public', 'channels:history'];
const TENANT = 'ten_mcp_oauth_e2e';
const KEY = Buffer.alloc(32, 7).toString('base64');

const TEMPLATE: McpOAuthProviderTemplate = {
  id: 'fakeslack', displayName: 'Fake Slack', mcpEndpoint: MCP_URL, resource: RESOURCE,
  protectedResourceMetadataUrl: `${RESOURCE}/.well-known/oauth-protected-resource`, authorizationServerMetadataUrl: `${RESOURCE}/.well-known/oauth-authorization-server`,
  tokenAuthMethod: 'client_secret_post', responseProfile: 'slack-user-v2', envPrefix: 'NAGEX_MCP_OAUTH_FAKESLACK', defaultScopes: SCOPES,
};
const operatorEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  NAGEX_MCP_OAUTH_ENABLED: '1', NAGEX_TOKEN_ENCRYPTION_KEY: KEY,
  NAGEX_MCP_OAUTH_FAKESLACK_CLIENT_ID: CLIENT_ID, NAGEX_MCP_OAUTH_FAKESLACK_CLIENT_SECRET: SECRET, NAGEX_MCP_OAUTH_FAKESLACK_REDIRECT_URI: CALLBACK, ...extra,
});
const metadataFor = (url: string): unknown => {
  if (url.endsWith('/oauth-protected-resource')) return { resource: RESOURCE, authorization_servers: [RESOURCE], scopes_supported: ['search:read.public', 'channels:history', 'chat:write'] };
  if (url.endsWith('/oauth-authorization-server')) return { issuer: RESOURCE, authorization_endpoint: AUTHORIZE, token_endpoint: TOKEN_URL, code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['client_secret_post'] };
  throw new Error('unexpected metadata url');
};

// ── fake authorization server (loopback) ────────────────────────────────────────────────────────────────────────────────
interface Grant { challenge: string; scope: string; expiresIn?: number; mode: 'ok' | 'denied' | 'overscope' }
interface FakeAs { port: number; forms: URLSearchParams[]; grant(challenge: string, options?: Partial<Grant>): string; lastToken(): string | null; close(): Promise<void> }
async function startFakeAs(onToken: (token: string) => void): Promise<FakeAs> {
  const grants = new Map<string, Grant>();
  const forms: URLSearchParams[] = [];
  let last: string | null = null;
  let counter = 0;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const form = new URLSearchParams(Buffer.concat(chunks).toString());
      forms.push(form);
      const reply = (body: unknown) => { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
      const grant = grants.get(form.get('code') ?? '');
      grants.delete(form.get('code') ?? '');
      const pkceOk = grant && crypto.createHash('sha256').update(form.get('code_verifier') ?? '', 'ascii').digest('base64url') === grant.challenge;
      if (req.headers.authorization || form.get('client_secret') !== SECRET || form.get('client_id') !== CLIENT_ID || form.get('redirect_uri') !== CALLBACK || form.get('grant_type') !== 'authorization_code' || form.get('resource') !== RESOURCE) return reply({ ok: false, error: 'invalid_client_auth' });
      if (!grant || !pkceOk || grant.mode === 'denied') return reply({ ok: false, error: 'invalid_code' });
      last = `xoxp-fake-${++counter}-${crypto.randomBytes(6).toString('hex')}`;
      onToken(last);
      reply({ ok: true, access_token: last, token_type: 'user', authed_user: { id: 'U1', scope: grant.mode === 'overscope' ? `${grant.scope},chat:write` : grant.scope }, team: { id: 'T1' }, ...(grant.expiresIn ? { expires_in: grant.expiresIn } : {}) });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port, forms,
    grant: (challenge, options = {}) => { const code = `code-${crypto.randomBytes(8).toString('hex')}`; grants.set(code, { challenge, scope: SCOPES.join(','), mode: 'ok', ...options }); return code; },
    lastToken: () => last,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

function postTo(port: number, body: string): Promise<{ status: number; contentType: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/token', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, contentType: String(res.headers['content-type'] ?? ''), body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

interface TestMcp { url: string; state: { log: Array<{ method: string; tool?: string; authorized: boolean }> }; setToken(t: string): void; callsTo(tool: string): number; close(): Promise<void> }
let startMcp: (options?: Record<string, unknown>) => Promise<TestMcp>;
const envBackup = process.env.NAGEX_MCP_ALLOW_PRIVATE_NETWORK;
before(async () => { startMcp = (await import(pathToFileURL(path.resolve('scripts/mcp-test-server.mjs')).href)).startMcpTestServer; });
after(() => { if (envBackup === undefined) delete process.env.NAGEX_MCP_ALLOW_PRIVATE_NETWORK; else process.env.NAGEX_MCP_ALLOW_PRIVATE_NETWORK = envBackup; });

// ── a complete NAgex-side stack (runtime + McpService + broker) on temp files; "restart" = build it again over the same files ───────────────────────────
interface Stack { runtime: McpOAuthRuntime; service: McpService; approvals: ActionApprovalStore; registry: CapabilityRegistry; executions: ExecutionStore; broker: CapabilityBroker; store: PersistentMcpConnectionStore; clock: { now: number } }
function buildStack(dir: string, env: NodeJS.ProcessEnv, mcpPort: () => number, asPort: () => number, clock = { now: Date.now() }): Stack {
  const audit = new AuditLogger();
  const approvals = new ActionApprovalStore();
  const registry = new CapabilityRegistry();
  const executions = new ExecutionStore();
  const runtime = new McpOAuthRuntime({
    env, templates: [TEMPLATE], storeFile: path.join(dir, 'oauth.json'), now: () => clock.now, policy: { resolve: async () => ['8.8.8.8'] },
    getMetadata: async (url) => metadataFor(url),
    exchange: (pending, code, endpoint, requestId, options) => exchangeMcpOAuthCode(pending, code, endpoint, requestId, { ...options, policy: { resolve: async () => ['8.8.8.8'] }, post: (_u, body) => postTo(asPort(), body) }),
  });
  const base = createHttpMcpTransport({ allowPrivateNetwork: true });
  const store = new PersistentMcpConnectionStore({ filePath: path.join(dir, 'mcp.json'), env });
  const service = new McpService({ store, approvals, audit, registry, executions, oauth: runtime, policy: () => ({ resolve: async () => ['8.8.8.8'] }), timeoutMs: 5_000,
    transport: (request) => base({ ...request, url: new URL(`http://127.0.0.1:${mcpPort()}/mcp`) }) });
  service.hydrate();
  process.env.NAGEX_TEST_IDEMPOTENCY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-idem-'));
  const broker = new CapabilityBroker({} as never, {} as never, {} as never, audit, registry, `mcp_oauth_${Math.random().toString(36).slice(2)}`, 'NAGEX_TEST_IDEMPOTENCY_DIR', undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, service);
  return { runtime, service, approvals, registry, executions, broker, store, clock };
}

let dir: string; let mcp: TestMcp; let as: FakeAs; let stack: Stack;
const uniq = () => `usr_${crypto.randomBytes(4).toString('hex')}`;
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-mcp-oauth-e2e-'));
  mcp = await startMcp({ token: 'not-issued-yet' });
  as = await startFakeAs((token) => mcp.setToken(token));
  stack = buildStack(dir, operatorEnv(), () => mcp.url ? Number(new URL(mcp.url).port) : 0, () => as.port);
});
afterEach(async () => { await mcp.close(); await as.close(); });

const oauthRoute = (method: string, pathname: string, body: Record<string, unknown> | null, headers: Record<string, string>, query: Record<string, string> = {}, s: Stack = stack) =>
  handleMcpOAuthRoutes(method, pathname, body, headers, query, { sessionStore, identityStore, oauthRuntime: s.runtime, mcpService: s.service }) as Promise<any>;
const mcpRoute = (method: string, pathname: string, body: Record<string, unknown> | null, headers: Record<string, string>, s: Stack = stack) =>
  handleMcpRoutes(method, pathname, body, headers, {}, { sessionStore, identityStore, mcpService: s.service, capabilityBroker: s.broker }) as Promise<any>;

// Signs a user in through the fake provider and returns the callback result.
async function connect(user: string, options: Partial<Grant> = {}, headers: Record<string, string> = {}, s: Stack = stack) {
  const session = authAs(TENANT, user);
  const started = await oauthRoute('POST', '/api/v1/oauth/mcp/start', { providerId: 'fakeslack' }, session, {}, s);
  assert.equal(started.status, 200, JSON.stringify(started.data));
  const url = new URL(started.data.authorizeUrl);
  const code = as.grant(url.searchParams.get('code_challenge')!, options);
  const callback = await oauthRoute('GET', '/api/v1/oauth/mcp/callback', null, { ...session, ...headers }, { state: url.searchParams.get('state')!, code }, s);
  return { session, url, code, callback };
}

describe('operator activation is opt-in and fail-closed', () => {
  it('is DISABLED by default and answers 503; partial configuration is SETUP_REQUIRED naming only the missing items, never a value', async () => {
    const off = buildStack(dir, { NAGEX_TOKEN_ENCRYPTION_KEY: KEY }, () => 0, () => 0);
    const user = authAs(TENANT, uniq());
    assert.equal((await oauthRoute('GET', '/api/v1/oauth/mcp/providers', null, user, {}, off)).data.providers[0].state, 'DISABLED');
    assert.equal((await oauthRoute('POST', '/api/v1/oauth/mcp/start', { providerId: 'fakeslack' }, user, {}, off)).status, 503);

    const partial = buildStack(dir, operatorEnv({ NAGEX_MCP_OAUTH_FAKESLACK_CLIENT_SECRET: '', NAGEX_MCP_OAUTH_FAKESLACK_REDIRECT_URI: 'http://insecure.example/cb' }), () => 0, () => 0);
    const listed = await oauthRoute('GET', '/api/v1/oauth/mcp/providers', null, user, {}, partial);
    assert.equal(listed.data.providers[0].state, 'SETUP_REQUIRED');
    assert.deepEqual([...listed.data.providers[0].missing].sort(), ['CLIENT_SECRET', 'REDIRECT_URI']);
    assert.doesNotMatch(JSON.stringify(listed.data), new RegExp(`${SECRET}|${CLIENT_ID}|insecure`));
    assert.equal((await oauthRoute('POST', '/api/v1/oauth/mcp/start', { providerId: 'fakeslack' }, user, {}, partial)).status, 503);

    const noKey = buildStack(dir, operatorEnv({ NAGEX_TOKEN_ENCRYPTION_KEY: '' }), () => 0, () => 0);
    assert.deepEqual((await oauthRoute('GET', '/api/v1/oauth/mcp/providers', null, user, {}, noKey)).data.providers[0].missing, ['ENCRYPTION_KEY']);
    assert.equal((await oauthRoute('POST', '/api/v1/oauth/mcp/start', { providerId: 'fakeslack' }, user, {}, noKey)).status, 503);
  });

  it('a provider whose published metadata does not verify is UNAVAILABLE with a reason code (no Connect, no start)', async () => {
    const bad = new McpOAuthRuntime({ env: operatorEnv(), templates: [TEMPLATE], storeFile: path.join(dir, 'bad.json'), getMetadata: async (url) => (url.endsWith('-resource') ? { resource: 'https://evil.example', authorization_servers: [RESOURCE] } : metadataFor(url)) });
    const [status] = await bad.statuses();
    assert.equal(status.state, 'UNAVAILABLE');
    assert.match(String(status.reason), /^MCP_OAUTH_METADATA_REJECTED:RESOURCE_MISMATCH$/);
    assert.equal(await bad.coordinator(), null);
    const noSecretAdvert = new McpOAuthRuntime({ env: operatorEnv(), templates: [TEMPLATE], storeFile: path.join(dir, 'bad2.json'), getMetadata: async (url) => (url.endsWith('-server') ? { ...(metadataFor(url) as object), token_endpoint_auth_methods_supported: ['client_secret_basic'] } : metadataFor(url)) });
    assert.equal((await noSecretAdvert.statuses())[0].reason, 'MCP_OAUTH_TOKEN_AUTH_NOT_ADVERTISED');
  });

  it('start and callback need a signed-in NAgex session', async () => {
    assert.equal((await oauthRoute('POST', '/api/v1/oauth/mcp/start', { providerId: 'fakeslack' }, {})).status, 401);
    assert.equal((await oauthRoute('GET', '/api/v1/oauth/mcp/callback', null, {}, { state: 'x', code: 'y' })).status, 401);
    assert.equal((await oauthRoute('GET', '/api/v1/oauth/mcp/providers', null, {})).status, 401);
  });
});

describe('sign-in to verified, approval-governed tool use', () => {
  it('connects through the provider, stores only an encrypted owner-bound token, discovers tools OFF, and runs an approved call once', async () => {
    const user = uniq();
    const listed = (await oauthRoute('GET', '/api/v1/oauth/mcp/providers', null, authAs(TENANT, user))).data.providers[0];
    assert.equal(listed.state, 'AVAILABLE');

    const { session, url, code, callback } = await connect(user);
    // authorization request: pinned client, exact callback, S256, resource and the operator's scopes - nothing from the request
    assert.equal(url.origin + url.pathname, AUTHORIZE);
    assert.equal(url.searchParams.get('client_id'), CLIENT_ID);
    assert.equal(url.searchParams.get('redirect_uri'), CALLBACK);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('resource'), RESOURCE);
    assert.deepEqual(url.searchParams.get('scope')!.split(' ').sort(), [...SCOPES].sort());
    assert.doesNotMatch(url.toString(), new RegExp(SECRET));

    // the token endpoint saw exactly one confidential exchange with the PKCE verifier
    assert.equal(as.forms.length, 1);
    assert.equal(as.forms[0].get('client_secret'), SECRET);
    assert.equal(as.forms[0].get('code'), code);

    // the outcome says what is true: credential stored AND server verified
    assert.equal(callback.status, 200, JSON.stringify(callback.data));
    assert.equal(callback.data.status, 'MCP_CONNECTED_VERIFIED');
    assert.equal(callback.data.tools, 6);
    const everything = JSON.stringify(callback);
    const token = as.lastToken()!;
    for (const secret of [token, SECRET, code]) assert.ok(!everything.includes(secret), 'neither the token, the client secret nor the code is returned');

    // encrypted at rest, bound to the owner; the connection holds only a binding
    const vaultFile = fs.readFileSync(path.join(dir, 'oauth.json'), 'utf8');
    assert.ok(!vaultFile.includes(token) && !vaultFile.includes(SECRET));
    assert.ok(!fs.readFileSync(path.join(dir, 'mcp.json'), 'utf8').includes(token));
    const principalId = user;
    const view = stack.service.list({ tenantId: TENANT, principalId, requestId: 'r' })[0];
    assert.equal(view.status, 'CONNECTED');
    assert.deepEqual({ providerId: view.oauth?.providerId, scopes: [...(view.oauth?.scopes ?? [])].sort() }, { providerId: 'fakeslack', scopes: [...SCOPES].sort() });
    assert.equal(view.hasCredential, true);
    assert.doesNotMatch(JSON.stringify(view), new RegExp(token));
    assert.ok(view.tools.every((tool) => tool.enabled === false), 'every discovered tool is OFF by default');
    assert.equal(mcp.callsTo('echo'), 0);

    // the MCP server was reached with the issued token (and rejected anything else)
    assert.ok(mcp.state.log.some((entry) => entry.method === 'initialize' && entry.authorized));
    assert.equal(mcp.state.log.filter((entry) => !entry.authorized).length, 0, 'the MCP server never saw an unauthenticated request');

    // enable with consent, then the existing approval path
    assert.equal((await mcpRoute('POST', `/api/v1/mcp/servers/${view.connectionId}/tools/echo`, { enabled: true }, session)).status, 200);
    const first = await mcpRoute('POST', `/api/v1/mcp/servers/${view.connectionId}/tools/echo/invoke`, { arguments: { message: 'hello slack' } }, session);
    assert.equal(first.status, 202, 'no approval, no call');
    assert.equal(mcp.callsTo('echo'), 0);
    const approvalId = first.data.approval.approvalId;
    stack.approvals.approve(approvalId, TENANT, principalId);
    const done = await mcpRoute('POST', `/api/v1/mcp/servers/${view.connectionId}/tools/echo/invoke`, { arguments: { message: 'hello slack' }, approvalId }, session);
    assert.equal(done.status, 200, JSON.stringify(done.data));
    assert.equal(done.data.result.text, 'echo: hello slack');
    assert.equal(done.data.result.outcome, 'TOOL_RESPONDED');
    assert.deepEqual(done.data.result.verification, { status: 'UNVERIFIED', reason: 'MCP_PROVIDER_RESPONSE_ONLY' });
    assert.equal(mcp.callsTo('echo'), 1);
    // one-time: the same approval cannot run it again
    const replay = await mcpRoute('POST', `/api/v1/mcp/servers/${view.connectionId}/tools/echo/invoke`, { arguments: { message: 'hello slack' }, approvalId }, session).catch((e) => ({ status: e.code }));
    assert.notEqual(replay.status, 200);
    assert.equal(mcp.callsTo('echo'), 1);
  });

  it('a browser navigation (Accept: text/html) is sent back to Connections with a status, never a credential', async () => {
    const { callback } = await connect(uniq(), {}, { accept: 'text/html,application/xhtml+xml' });
    assert.equal(callback.status, 302);
    const target = new URL(`https://app.example${callback.redirectTo}`);
    assert.equal(target.searchParams.get('mcp_oauth'), 'connected');
    assert.equal(target.searchParams.get('provider'), 'fakeslack');
    assert.equal(target.hash, '#settings/connections');
    assert.ok(!callback.redirectTo.includes(as.lastToken()!));
  });

  it('survives a restart: the token is decrypted for its owner, tools stay enabled, and every call still needs a fresh approval', async () => {
    const user = uniq();
    const { session } = await connect(user);
    const first = stack.service.list({ tenantId: TENANT, principalId: user, requestId: 'r' })[0];
    stack.service.setToolEnabled({ tenantId: TENANT, principalId: user, requestId: 'r' }, first.connectionId, 'echo', true);
    const second = buildStack(dir, operatorEnv(), () => Number(new URL(mcp.url).port), () => as.port);
    const view = second.service.list({ tenantId: TENANT, principalId: user, requestId: 'r' })[0];
    assert.equal(view.status, 'CONNECTED');
    assert.equal(view.tools.find((t) => t.name === 'echo')?.enabled, true);
    const refreshed = await mcpRoute('POST', `/api/v1/mcp/servers/${view.connectionId}/refresh`, null, session, second);
    assert.equal(refreshed.status, 200, JSON.stringify(refreshed.data));
    const call = await mcpRoute('POST', `/api/v1/mcp/servers/${view.connectionId}/tools/echo/invoke`, { arguments: { message: 'after restart' } }, session, second);
    assert.equal(call.status, 202, 'a restart never turns an enabled tool into an auto-approved one');
    // another account never sees it
    const intruder = authAs(TENANT, uniq());
    assert.equal((await mcpRoute('GET', `/api/v1/mcp/servers/${view.connectionId}`, null, intruder, second)).status, 404);
  });
});

describe('every failure leaves nothing connected', () => {
  const noConnections = (user: string) => stack.service.list({ tenantId: TENANT, principalId: user, requestId: 'r' }).length === 0;
  const vaultSize = () => stack.runtime.credentialStore!.sealedSnapshot().length;

  it('provider denial, a foreign callback, replay and a code the provider rejects store nothing', async () => {
    const user = uniq();
    const session = authAs(TENANT, user);
    const start = async () => { const s = await oauthRoute('POST', '/api/v1/oauth/mcp/start', { providerId: 'fakeslack' }, session); const u = new URL(s.data.authorizeUrl); return { state: u.searchParams.get('state')!, challenge: u.searchParams.get('code_challenge')! }; };

    let flow = await start();
    assert.equal((await oauthRoute('GET', '/api/v1/oauth/mcp/callback', null, session, { state: flow.state, error: 'access_denied' })).status, 400);
    assert.equal(as.forms.length, 0, 'a denied callback never reaches the token endpoint');
    // the denied state is spent: a later injected code cannot reuse it
    assert.equal((await oauthRoute('GET', '/api/v1/oauth/mcp/callback', null, session, { state: flow.state, code: as.grant(flow.challenge) })).status, 400);

    flow = await start();
    const other = authAs('ten_other_org', user);
    assert.equal((await oauthRoute('GET', '/api/v1/oauth/mcp/callback', null, other, { state: flow.state, code: as.grant(flow.challenge) })).status, 400, 'another tenant cannot finish this flow');
    assert.equal(as.forms.length, 0);
    assert.equal((await oauthRoute('GET', '/api/v1/oauth/mcp/callback', null, session, { state: flow.state, code: as.grant(flow.challenge) })).status, 400, 'the state is consumed even by a failed foreign attempt');

    flow = await start();
    assert.equal((await oauthRoute('GET', '/api/v1/oauth/mcp/callback', null, session, { state: flow.state, code: 'code-the-provider-never-issued' })).status, 400);
    assert.equal(as.forms.length, 1);
    assert.equal(vaultSize(), 0);
    assert.ok(noConnections(user));
  });

  it('a provider that grants more than was requested, or reports nothing it can be checked against, is never stored', async () => {
    const user = uniq();
    const over = await connect(user, { mode: 'overscope' });
    assert.equal(over.callback.status, 400);
    const denied = await connect(user, { mode: 'denied' });
    assert.equal(denied.callback.status, 400);
    assert.equal(vaultSize(), 0);
    assert.ok(noConnections(user));
  });

  it('a stored credential is NOT a connection: when the MCP server fails, the outcome is OAUTH_CREDENTIAL_STORED, and a retry verifies it', async () => {
    const user = uniq();
    const down = await startMcp({ token: 'x' });
    const port = Number(new URL(down.url).port);
    await down.close();
    const broken = buildStack(dir, operatorEnv(), () => port, () => as.port);
    const { callback, session } = await connect(user, {}, {}, broken);
    assert.equal(callback.status, 200);
    assert.equal(callback.data.status, 'OAUTH_CREDENTIAL_STORED');
    assert.notEqual(callback.data.status, 'MCP_CONNECTED_VERIFIED');
    assert.match(callback.data.reason, /^[A-Z][A-Z0-9_]+$/);
    assert.equal(broken.service.list({ tenantId: TENANT, principalId: user, requestId: 'r' }).length, 0, 'nothing is shown as connected');
    assert.equal(broken.runtime.credentialStore!.sealedSnapshot().length, 1, 'the credential itself is kept');

    // the server is back: retry with the stored credential, no new login
    const healthy = buildStack(dir, operatorEnv(), () => Number(new URL(mcp.url).port), () => as.port);
    const retry = await oauthRoute('POST', '/api/v1/oauth/mcp/connect', { providerId: 'fakeslack' }, session, {}, healthy);
    assert.equal(retry.status, 200, JSON.stringify(retry.data));
    assert.equal(retry.data.status, 'MCP_CONNECTED_VERIFIED');
  });

  it('an expired token means REAUTH_REQUIRED: tools switch off, nothing is called, and signing in again restores the same connection', async () => {
    const user = uniq();
    const principal = { tenantId: TENANT, principalId: user, requestId: 'r' };
    const { session, callback } = await connect(user, { expiresIn: 100 });
    assert.equal(callback.data.status, 'MCP_CONNECTED_VERIFIED');
    const id = stack.service.list(principal)[0].connectionId;
    stack.service.setToolEnabled(principal, id, 'echo', true);
    const before = mcp.state.log.length;

    stack.clock.now = Date.now() + 200_000;     // past the provider-declared lifetime
    const attempt = await mcpRoute('POST', `/api/v1/mcp/servers/${id}/tools/echo/invoke`, { arguments: { message: 'late' } }, session);
    assert.equal(attempt.status, 409, JSON.stringify(attempt.data));
    assert.equal(attempt.data.error.code, 'MCP_OAUTH_REAUTH_REQUIRED');
    assert.equal(mcp.state.log.length, before, 'no request at all reached the MCP server with an expired credential');
    const expired = stack.service.get(principal, id);
    assert.equal(expired.status, 'AUTH_REQUIRED');
    assert.equal(expired.reason, 'OAUTH_TOKEN_EXPIRED');
    assert.ok(stack.service.toolsFor(principal).length === 0, 'the planner is no longer offered the tool');
    assert.equal((await mcpRoute('POST', `/api/v1/mcp/servers/${id}/reconnect`, { bearerToken: 'pasted' }, session)).status, 409, 'a provider connection never takes a pasted credential');

    stack.clock.now = Date.now();
    const again = await connect(user, { expiresIn: 3600 });
    assert.equal(again.callback.data.status, 'MCP_CONNECTED_VERIFIED');
    assert.equal(again.callback.data.connectionId, id, 'the same connection is re-verified, not duplicated');
    assert.equal(stack.service.list(principal).length, 1);
    assert.equal(stack.service.get(principal, id).status, 'CONNECTED');
  });

  it('a token the MCP server revokes turns the connection into AUTH_REQUIRED and no call is made', async () => {
    const user = uniq();
    const principal = { tenantId: TENANT, principalId: user, requestId: 'r' };
    const { session } = await connect(user);
    const id = stack.service.list(principal)[0].connectionId;
    stack.service.setToolEnabled(principal, id, 'echo', true);
    mcp.setToken('revoked-upstream');
    const refreshed = await mcpRoute('POST', `/api/v1/mcp/servers/${id}/refresh`, null, session);
    assert.ok(refreshed.status >= 400);
    assert.equal(stack.service.get(principal, id).status, 'AUTH_REQUIRED');
    assert.equal(mcp.callsTo('echo'), 0);
  });
});

describe('disconnect and isolation', () => {
  it('disconnect removes the connection, its tools and the stored credential; the file no longer holds it', async () => {
    const user = uniq();
    const principal = { tenantId: TENANT, principalId: user, requestId: 'r' };
    const { session } = await connect(user);
    const view = stack.service.list(principal)[0];
    stack.service.setToolEnabled(principal, view.connectionId, 'echo', true);
    const capabilityId = view.tools.find((t) => t.name === 'echo')!.capabilityId;
    assert.equal(stack.registry.has(capabilityId), true);
    assert.equal(stack.runtime.credentialStore!.sealedSnapshot().length, 1);

    assert.equal((await mcpRoute('DELETE', `/api/v1/mcp/servers/${view.connectionId}`, null, session)).status, 200);
    assert.equal(stack.registry.has(capabilityId), false);
    assert.equal(stack.service.list(principal).length, 0);
    assert.equal(stack.runtime.credentialStore!.sealedSnapshot().length, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'oauth.json'), 'utf8')).records, []);
    const afterRestart = buildStack(dir, operatorEnv(), () => Number(new URL(mcp.url).port), () => as.port);
    assert.equal(afterRestart.service.list(principal).length, 0);
    assert.equal(afterRestart.runtime.credentialStore!.sealedSnapshot().length, 0);
  });

  it('two accounts connect independently; neither sees, enables, calls or reuses the other\'s credential', async () => {
    const a = uniq(); const b = uniq();
    const A = await connect(a);
    const idA = stack.service.list({ tenantId: TENANT, principalId: a, requestId: 'r' })[0].connectionId;
    const intruder = authAs(TENANT, b);
    for (const [method, route, body] of [['GET', `/api/v1/mcp/servers/${idA}`, null], ['POST', `/api/v1/mcp/servers/${idA}/refresh`, null], ['POST', `/api/v1/mcp/servers/${idA}/tools/echo`, { enabled: true }], ['DELETE', `/api/v1/mcp/servers/${idA}`, null]] as const) {
      assert.equal((await mcpRoute(method, route, body as Record<string, unknown> | null, intruder)).status, 404, `${method} ${route}`);
    }
    assert.equal(stack.service.list({ tenantId: TENANT, principalId: a, requestId: 'r' }).length, 1, 'the owner is unaffected');
    // B has no credential: connecting with "the stored one" finds nothing to use
    const noCredential = await oauthRoute('POST', '/api/v1/oauth/mcp/connect', { providerId: 'fakeslack' }, intruder);
    assert.equal(noCredential.status, 409);
    assert.equal(noCredential.data.status, 'OAUTH_CREDENTIAL_STORED');
    assert.equal(noCredential.data.reason, 'MCP_OAUTH_REAUTH_REQUIRED');
    assert.equal(stack.service.list({ tenantId: TENANT, principalId: b, requestId: 'r' }).length, 0);
    // the same user id in another tenant is a different owner
    const sameUserOtherTenant = authAs('ten_elsewhere', a);
    assert.equal((await oauthRoute('POST', '/api/v1/oauth/mcp/connect', { providerId: 'fakeslack' }, sameUserOtherTenant)).status, 409);
    assert.ok(A.callback.data.status === 'MCP_CONNECTED_VERIFIED');
  });

  it('an unknown provider id and malformed requests are refused without touching anything', async () => {
    const user = authAs(TENANT, uniq());
    assert.equal((await oauthRoute('POST', '/api/v1/oauth/mcp/start', { providerId: 'not-registered' }, user)).status, 404);
    assert.equal((await oauthRoute('POST', '/api/v1/oauth/mcp/start', { providerId: '../x' }, user)).status, 400);
    assert.equal((await oauthRoute('POST', '/api/v1/oauth/mcp/start', {}, user)).status, 400);
    assert.equal((await oauthRoute('POST', '/api/v1/oauth/mcp/connect', { providerId: 'nope' }, user)).status, 404);
    assert.equal((await oauthRoute('GET', '/api/v1/oauth/mcp/start', null, user)).status, 405);
    assert.equal(as.forms.length, 0);
  });
});
