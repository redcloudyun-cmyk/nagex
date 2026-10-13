// MCP end-to-end certification against an ISOLATED, repository-controlled MCP server (scripts/mcp-test-server.mjs): real HTTP between NAgex's production
// client and a protocol-conformant Streamable HTTP server, driven through NAgex's production HTTP routes, Capability Broker and approval store.
// This is NOT certification against a third-party MCP provider; see docs/evidence/NAGEX_MCP_PRODUCTION_CERTIFICATION_20261013.md.
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AuditLogger } from '../src/governance/audit.logger.js';
import { ActionApprovalStore } from '../src/governance/action-approval.store.js';
import { ExecutionStore } from '../src/governance/execution.store.js';
import { CapabilityBroker } from '../src/capabilities/capability-broker.js';
import { CapabilityRegistry } from '../src/capabilities/capability.registry.js';
import { PersistentMcpConnectionStore } from '../src/mcp/mcp-connection.store.js';
import { McpService } from '../src/mcp/mcp.service.js';
import { actionApprovals, handleAsyncApiRequest } from '../src/server_web.js';
import { authAs } from './_s1_session_auth.js';

const TENANT = 'ten_mcp_e2e';
const TOKEN = 'e2e-secret-token-7f3a';
const envBackup = process.env.NAGEX_MCP_ALLOW_PRIVATE_NETWORK;

interface TestServer {
  url: string; state: { notes: string[]; log: Array<{ method: string; tool?: string; authorized: boolean }>; deletes: number };
  setToken(token: string): void; rename(name: string): void; setToolDescription(tool: string, description: string): void;
  callsTo(tool: string): number; liveSessions(): number; close(): Promise<void>;
}
let startServer: (options?: Record<string, unknown>) => Promise<TestServer>;
let server: TestServer;

before(async () => {
  process.env.NAGEX_MCP_ALLOW_PRIVATE_NETWORK = '1'; // the isolated server listens on loopback
  const mod = await import(pathToFileURL(path.resolve('scripts/mcp-test-server.mjs')).href);
  startServer = mod.startMcpTestServer;
});
after(() => { if (envBackup === undefined) delete process.env.NAGEX_MCP_ALLOW_PRIVATE_NETWORK; else process.env.NAGEX_MCP_ALLOW_PRIVATE_NETWORK = envBackup; });
beforeEach(async () => { server = await startServer({ token: TOKEN }); });
afterEach(async () => { await server.close(); });

const session = (user: string, tenant = TENANT) => authAs(tenant, user);
const call = (method: string, pathname: string, body: Record<string, unknown> | null, headers: Record<string, string>) => handleAsyncApiRequest(method, pathname, body, headers);
const data = (res: { data: unknown }): any => res.data;

async function addServer(user: string, name = 'Isolated test server', token: string | null = TOKEN, url = server.url): Promise<any> {
  const res = await call('POST', '/api/v1/mcp/servers', { name, url, ...(token ? { bearerToken: token } : {}) }, session(user));
  assert.equal(res.status, 201, JSON.stringify(res.data));
  return data(res).server;
}
const enable = async (user: string, id: string, tool: string) => assert.equal((await call('POST', `/api/v1/mcp/servers/${id}/tools/${tool}`, { enabled: true }, session(user))).status, 200);
const invoke = (user: string, id: string, tool: string, args: Record<string, unknown>, approvalId?: string) =>
  call('POST', `/api/v1/mcp/servers/${id}/tools/${tool}/invoke`, { arguments: args, ...(approvalId ? { approvalId } : {}) }, session(user));

describe('registration, discovery and schema compatibility', () => {
  it('initializes over Streamable HTTP, pins the server identity, discovers every tool DISABLED, and never returns the credential', async () => {
    const view = await addServer('usr_e2e_1');
    assert.equal(view.status, 'CONNECTED');
    assert.equal(view.identity.serverName, 'NAgex MCP Test Server');
    assert.equal(view.identity.protocolVersion, '2025-06-18');
    assert.deepEqual(view.tools.map((tool: any) => tool.name).sort(), ['add_numbers', 'always_fails', 'echo', 'list_notes', 'record_note', 'slow_echo']);
    assert.ok(view.tools.every((tool: any) => tool.enabled === false && /^[a-f0-9]{16,}$/.test(tool.schemaHash)));
    assert.equal(view.hasCredential, true);
    assert.doesNotMatch(JSON.stringify(view), new RegExp(TOKEN));
    assert.equal(server.liveSessions(), 0, 'every session opened during discovery was ended');
  });

  it('pages through a long tool list (server pagination) and accepts a text/event-stream tool response', async () => {
    await server.close();
    server = await startServer({ token: TOKEN, pageSize: 2, sse: true });
    const view = await addServer('usr_e2e_page');
    assert.equal(view.tools.length, 6);
    await enable('usr_e2e_page', view.connectionId, 'echo');
    const pending = data(await invoke('usr_e2e_page', view.connectionId, 'echo', { message: 'sse' })).approval;
    actionApprovals.approve(pending.approvalId, TENANT, 'usr_e2e_page');
    const done = await invoke('usr_e2e_page', view.connectionId, 'echo', { message: 'sse' }, pending.approvalId);
    assert.equal(done.status, 200);
    assert.equal(data(done).result.text, 'echo: sse');
  });

  it('refuses a server that rejects the credential, and an unauthenticated NAgex caller never reaches any server', async () => {
    const wrong = await call('POST', '/api/v1/mcp/servers', { name: 'x', url: server.url, bearerToken: 'wrong' }, session('usr_e2e_2'));
    assert.equal(wrong.status, 502);
    assert.equal(data(wrong).error.code, 'MCP_SERVER_AUTH_FAILED');
    assert.equal(((await call('GET', '/api/v1/mcp/servers', null, session('usr_e2e_2'))).data as any).total, 0, 'nothing is stored when discovery fails');
    const before401 = server.state.log.length;
    assert.equal((await call('POST', '/api/v1/mcp/servers', { name: 'x', url: server.url, bearerToken: TOKEN }, {})).status, 401);
    assert.equal(server.state.log.length, before401, 'no request left NAgex for an unauthenticated caller');
  });
});

describe('explicit enablement and approval-bound execution', () => {
  it('a disabled tool cannot be invoked; an enabled tool still needs a hash-bound one-time approval, and the server sees exactly one call', async () => {
    const user = 'usr_e2e_3';
    const view = await addServer(user);
    const id = view.connectionId;
    assert.equal((await invoke(user, id, 'echo', { message: 'hi' })).status, 403, 'disabled tool');
    assert.equal(server.callsTo('echo'), 0);
    await enable(user, id, 'echo');

    const pending = await invoke(user, id, 'echo', { message: 'hi' });
    assert.equal(pending.status, 202);
    const approvalId = data(pending).approval.approvalId;
    assert.equal(server.callsTo('echo'), 0, 'nothing is sent before approval');
    assert.equal((await invoke(user, id, 'echo', { message: 'hi' }, approvalId)).status, 409, 'an approval that was not granted executes nothing');

    actionApprovals.approve(approvalId, TENANT, user);
    const tampered = await invoke(user, id, 'echo', { message: 'something else' }, approvalId);
    assert.notEqual(tampered.status, 200, 'an approval is bound to the exact arguments');
    assert.equal(server.callsTo('echo'), 0);

    const done = await invoke(user, id, 'echo', { message: 'hi' }, approvalId);
    assert.equal(done.status, 200);
    assert.equal(data(done).result.text, 'echo: hi');
    assert.deepEqual(data(done).result.verification, { status: 'UNVERIFIED', reason: 'MCP_PROVIDER_RESPONSE_ONLY' });
    assert.equal(data(done).result.outcome, 'TOOL_RESPONDED');
    assert.equal(server.callsTo('echo'), 1);
    assert.equal((await invoke(user, id, 'echo', { message: 'hi' }, approvalId)).status, 409, 'replay is refused');
    assert.equal(server.callsTo('echo'), 1);
    assert.equal(server.liveSessions(), 0, 'no server-side session is left open');
  });

  it('a state-changing tool is approval-gated like any other: without approval the server state is unchanged', async () => {
    const user = 'usr_e2e_4';
    const view = await addServer(user);
    await enable(user, view.connectionId, 'record_note');
    const pending = await invoke(user, view.connectionId, 'record_note', { text: 'remember this' });
    assert.equal(pending.status, 202);
    assert.deepEqual(server.state.notes, []);
    actionApprovals.approve(data(pending).approval.approvalId, TENANT, user);
    assert.equal((await invoke(user, view.connectionId, 'record_note', { text: 'remember this' }, data(pending).approval.approvalId)).status, 200);
    assert.deepEqual(server.state.notes, ['remember this']);
  });

  it('arguments are validated against the discovered schema before any approval is requested', async () => {
    const user = 'usr_e2e_5';
    const view = await addServer(user);
    await enable(user, view.connectionId, 'add_numbers');
    const bad = await invoke(user, view.connectionId, 'add_numbers', { a: 'one', b: 2 });
    assert.equal(bad.status, 400);
    assert.equal(data(bad).error.code, 'MCP_INVALID_ARGUMENTS');
    assert.equal(server.callsTo('add_numbers'), 0);
  });

  it('a tool that reports an error is surfaced as an error outcome and recorded as a failed execution', async () => {
    const user = 'usr_e2e_6';
    const view = await addServer(user);
    await enable(user, view.connectionId, 'always_fails');
    const pending = data(await invoke(user, view.connectionId, 'always_fails', {})).approval;
    actionApprovals.approve(pending.approvalId, TENANT, user);
    const done = await invoke(user, view.connectionId, 'always_fails', {}, pending.approvalId);
    assert.equal(done.status, 200);
    assert.equal(data(done).result.isError, true);
    assert.equal(data(done).result.outcome, 'TOOL_REPORTED_ERROR');
  });
});

describe('isolation between users and tenants', () => {
  it('another user (same tenant or another tenant) cannot see, enable, invoke or spend the approval of the owner\'s server', async () => {
    const owner = 'usr_e2e_owner';
    const view = await addServer(owner);
    const id = view.connectionId;
    await enable(owner, id, 'echo');
    const pending = data(await invoke(owner, id, 'echo', { message: 'mine' })).approval;
    actionApprovals.approve(pending.approvalId, TENANT, owner);
    for (const [user, tenant] of [['usr_e2e_other', TENANT], [owner, 'ten_mcp_e2e_other']] as const) {
      const headers = session(user, tenant);
      assert.equal(((await call('GET', '/api/v1/mcp/servers', null, headers)).data as any).total, 0);
      assert.equal((await call('GET', `/api/v1/mcp/servers/${id}`, null, headers)).status, 404);
      assert.equal((await call('POST', `/api/v1/mcp/servers/${id}/tools/echo`, { enabled: false }, headers)).status, 404);
      assert.equal((await call('POST', `/api/v1/mcp/servers/${id}/tools/echo/invoke`, { arguments: { message: 'mine' }, approvalId: pending.approvalId }, headers)).status, 404);
      assert.equal((await call('POST', `/api/v1/mcp/servers/${id}/reconnect`, { bearerToken: TOKEN }, headers)).status, 404);
      assert.equal((await call('DELETE', `/api/v1/mcp/servers/${id}`, null, headers)).status, 404);
    }
    assert.equal(server.callsTo('echo'), 0, 'the foreign attempts never reached the server');
    assert.equal((await invoke(owner, id, 'echo', { message: 'mine' }, pending.approvalId)).status, 200, 'the owner is unaffected');
  });
});

describe('server changes, credential expiry and removal', () => {
  it('a rotated credential makes the server AUTH_REQUIRED (no approval spent), and reconnecting restores it', async () => {
    const user = 'usr_e2e_rot';
    const view = await addServer(user);
    const id = view.connectionId;
    await enable(user, id, 'echo');
    const pending = data(await invoke(user, id, 'echo', { message: 'later' })).approval;
    actionApprovals.approve(pending.approvalId, TENANT, user);
    server.setToken('rotated-token');
    const failed = await invoke(user, id, 'echo', { message: 'later' }, pending.approvalId);
    assert.equal(failed.status, 502);
    assert.equal(data(failed).error.code, 'MCP_SERVER_AUTH_FAILED');
    assert.equal(data(await call('GET', `/api/v1/mcp/servers/${id}`, null, session(user))).server.status, 'AUTH_REQUIRED');
    assert.equal(server.callsTo('echo'), 0);
    assert.equal((await call('POST', `/api/v1/mcp/servers/${id}/reconnect`, { bearerToken: 'rotated-token' }, session(user))).status, 200);
    assert.equal((await invoke(user, id, 'echo', { message: 'later' }, pending.approvalId)).status, 200, 'the approval was not spent by the failed attempt');
  });

  it('a changed tool definition disables that tool until the owner enables it again; a server that stops identifying as itself is blocked', async () => {
    const user = 'usr_e2e_chg';
    const view = await addServer(user);
    const id = view.connectionId;
    await enable(user, id, 'echo');
    server.setToolDescription('echo', 'Now does something else entirely.');
    const refreshed = data(await call('POST', `/api/v1/mcp/servers/${id}/refresh`, {}, session(user))).server;
    const echo = refreshed.tools.find((tool: any) => tool.name === 'echo');
    assert.equal(echo.enabled, false);
    assert.equal(echo.changedSinceEnabled, true);
    assert.equal((await invoke(user, id, 'echo', { message: 'x' })).status, 403);
    await enable(user, id, 'echo');
    assert.equal((await invoke(user, id, 'echo', { message: 'x' })).status, 202);

    server.rename('Impostor');
    const mismatch = data(await call('POST', `/api/v1/mcp/servers/${id}/refresh`, {}, session(user))).server;
    assert.equal(mismatch.status, 'IDENTITY_MISMATCH');
    assert.ok(mismatch.tools.every((tool: any) => tool.enabled === false));
  });

  it('removing a server unregisters its tools and deletes the record', async () => {
    const user = 'usr_e2e_rm';
    const view = await addServer(user);
    await enable(user, view.connectionId, 'echo');
    assert.equal((await call('DELETE', `/api/v1/mcp/servers/${view.connectionId}`, null, session(user))).status, 200);
    assert.equal(((await call('GET', '/api/v1/mcp/servers', null, session(user))).data as any).total, 0);
    assert.equal((await invoke(user, view.connectionId, 'echo', { message: 'x' })).status, 404);
  });
});

describe('timeouts, restart and the remote check script', () => {
  function buildService(store: PersistentMcpConnectionStore, timeoutMs?: number) {
    const audit = new AuditLogger();
    const approvals = new ActionApprovalStore();
    const registry = new CapabilityRegistry();
    const executions = new ExecutionStore();
    const service = new McpService({ store, approvals, audit, registry, executions, timeoutMs, policy: () => ({ allowPrivateNetwork: true }) });
    process.env.NAGEX_TEST_IDEMPOTENCY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-idem-'));
    const broker = new CapabilityBroker({} as never, {} as never, {} as never, audit, registry, `mcp_e2e_${Math.random().toString(36).slice(2)}`, 'NAGEX_TEST_IDEMPOTENCY_DIR', undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, service);
    return { service, approvals, registry, executions, broker };
  }
  const A = { tenantId: TENANT, principalId: 'usr_e2e_svc', requestId: 'req_e2e_svc' };
  const keyEnv = () => ({ NAGEX_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64') } as NodeJS.ProcessEnv);

  it('a server that does not answer in time fails the call with MCP_TIMEOUT, records a FAILED execution, and does not disable the owner\'s tools', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-mcp-e2e-'));
    const ctx = buildService(new PersistentMcpConnectionStore({ filePath: path.join(dir, 'mcp.json'), env: keyEnv() }), 1_000);
    const view = await ctx.service.addServer(A, { name: 'Slow', url: server.url, bearerToken: TOKEN });
    ctx.service.setToolEnabled(A, view.connectionId, 'slow_echo', true);
    const capabilityId = view.tools.find((tool) => tool.name === 'slow_echo')!.capabilityId;
    const payload = { arguments: { delay_ms: 4_000, message: 'late' } };
    const req = (extra: Record<string, unknown> = {}) => ({ capabilityId, tenantId: A.tenantId, principalId: A.principalId, requestId: `req_${Math.random().toString(36).slice(2)}`, payload, source: 'WEB' as const, ...extra });
    const approval = (await ctx.broker.execute(req()) as any).approval;
    ctx.approvals.approve(approval.approvalId, A.tenantId, A.principalId);
    await assert.rejects(() => ctx.broker.execute(req({ approvalId: approval.approvalId })), (error: any) => error.code === 'MCP_TIMEOUT');
    assert.equal(ctx.executions.list().filter((entry) => entry.approvalId === approval.approvalId)[0]?.status, 'FAILED');
    assert.equal(ctx.service.get(A, view.connectionId).status, 'CONNECTED', 'a slow server is not a rejected credential');
    assert.equal(ctx.registry.has(capabilityId), true);
  });

  it('connections, the pinned identity and enabled tools survive a restart (encrypted file, restored for the owner only) and still execute through approval', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-mcp-e2e-'));
    const file = path.join(dir, 'mcp.json');
    const first = buildService(new PersistentMcpConnectionStore({ filePath: file, env: keyEnv() }));
    assert.equal(first.service.durable, true);
    const view = await first.service.addServer(A, { name: 'Persistent', url: server.url, bearerToken: TOKEN });
    first.service.setToolEnabled(A, view.connectionId, 'echo', true);
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), new RegExp(`${TOKEN}|Persistent|NAgex MCP Test Server`), 'the file on disk is encrypted');

    // "restart": a brand-new process state built from the same file
    const second = buildService(new PersistentMcpConnectionStore({ filePath: file, env: keyEnv() }));
    second.service.hydrate();
    assert.equal(second.service.list(A).length, 1);
    assert.equal(second.service.list({ ...A, principalId: 'usr_someone_else' }).length, 0);
    const capabilityId = view.tools.find((tool) => tool.name === 'echo')!.capabilityId;
    assert.equal(second.registry.has(capabilityId), true, 'the enabled tool is registered again after the restart');
    const req = (extra: Record<string, unknown> = {}) => ({ capabilityId, tenantId: A.tenantId, principalId: A.principalId, requestId: `req_${Math.random().toString(36).slice(2)}`, payload: { arguments: { message: 'after restart' } }, source: 'WEB' as const, ...extra });
    const approval = (await second.broker.execute(req()) as any).approval;
    assert.equal(approval.status, 'PENDING', 'a restart never turns an enabled tool into an auto-approved one');
    second.approvals.approve(approval.approvalId, A.tenantId, A.principalId);
    const done = await second.broker.execute(req({ approvalId: approval.approvalId })) as any;
    assert.equal(done.result.text, 'echo: after restart');
  });

  it('scripts/mcp-remote-check.mjs passes its read-only protocol checks against the isolated server', async () => {
    const out = await new Promise<{ code: number; text: string }>((resolve) => {
      execFile(process.execPath, ['scripts/mcp-remote-check.mjs'], { env: { ...process.env, MCP_CHECK_URL: server.url, MCP_CHECK_TOKEN: TOKEN, NAGEX_MCP_ALLOW_PRIVATE_NETWORK: '1' }, timeout: 30_000 }, (error, stdout, stderr) => resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, text: `${stdout}${stderr}` }));
    });
    assert.equal(out.code, 0, out.text);
    assert.match(out.text, /PASS initialize handshake/);
    assert.match(out.text, /PASS tools\/list - 6 advertised, 6 accepted/);
    assert.doesNotMatch(out.text, new RegExp(TOKEN), 'the token is never printed');
  });

  it('the same protocol path works over HTTPS (TLS) - certificate trusted explicitly for this run only', async (testContext) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-mcp-tls-'));
    const key = path.join(dir, 'key.pem');
    const cert = path.join(dir, 'cert.pem');
    const generated = await new Promise<boolean>((resolve) => {
      execFile('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { timeout: 30_000 }, (error) => resolve(!error));
    });
    if (!generated) { testContext.skip('openssl is not available to create a throwaway certificate; the HTTPS variant was NOT run'); return; }
    const tls = await startServer({ token: TOKEN, tls: { key, cert } });
    try {
      assert.match(tls.url, /^https:\/\//);
      const out = await new Promise<{ code: number; text: string }>((resolve) => {
        execFile(process.execPath, ['scripts/mcp-remote-check.mjs'], { env: { ...process.env, MCP_CHECK_URL: tls.url, MCP_CHECK_TOKEN: TOKEN, NAGEX_MCP_ALLOW_PRIVATE_NETWORK: '1', NODE_EXTRA_CA_CERTS: cert }, timeout: 30_000 }, (error, stdout, stderr) => resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, text: `${stdout}${stderr}` }));
      });
      assert.equal(out.code, 0, out.text);
      assert.match(out.text, /PASS initialize handshake/);
      // without the explicit trust the client must refuse the certificate (it is not publicly trusted)
      const untrusted = await new Promise<{ code: number; text: string }>((resolve) => {
        execFile(process.execPath, ['scripts/mcp-remote-check.mjs'], { env: { ...process.env, MCP_CHECK_URL: tls.url, MCP_CHECK_TOKEN: TOKEN, NAGEX_MCP_ALLOW_PRIVATE_NETWORK: '1', NODE_EXTRA_CA_CERTS: '' }, timeout: 30_000 }, (error, stdout, stderr) => resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, text: `${stdout}${stderr}` }));
      });
      assert.notEqual(untrusted.code, 0, 'an untrusted certificate must not be accepted');
      assert.match(untrusted.text, /MCP_UNREACHABLE|FAIL/);
    } finally {
      await tls.close();
    }
  });
});
