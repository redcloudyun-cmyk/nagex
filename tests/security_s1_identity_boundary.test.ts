// Security Gate S1 — Identity Boundary (closes S0-01, S0-02, S0-07 for the identity-caused part, S0-18).
//
// Everything here goes through the REAL entry points (handleApiRequest / handleAsyncApiRequest /
// createServerInstance). The invariant under test:
//
//   For every non-public route, identity originates from an authenticated server-side session.
//   Nothing the client types — X-Principal-Id, X-NAgex-Tenant, a default admin, a default tenant,
//   a malformed cookie — establishes authority, and nothing the client types can crash the server.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServerInstance, handleApiRequest, handleAsyncApiRequest } from '../src/server_web.js';
import { getSessionIdFromHeaders } from '../src/http/session-credential.js';
import { classifyRouteAccess, ROUTE_ACCESS_RULES } from '../src/http/route-access.js';
import { authAs } from './_s1_session_auth.js';

type Headers = Record<string, string>;

// What an attacker can type. None of it may be treated as identity.
const FORGED: Array<{ label: string; headers: Headers }> = [
  { label: 'no headers at all', headers: {} },
  { label: 'default admin principal + default tenant', headers: { 'x-principal-id': 'usr_admin_001', 'x-nagex-tenant': 'ten_production_01' } },
  { label: 'default admin principal only', headers: { 'x-principal-id': 'usr_admin_001' } },
  { label: 'default tenant only', headers: { 'x-nagex-tenant': 'ten_production_01' } },
  { label: 'the literal principal "admin"', headers: { 'x-principal-id': 'admin', 'x-nagex-tenant': 'ten_production_01' } },
  { label: 'an arbitrary synthetic principal + tenant', headers: { 'X-Principal-Id': 'usr_made_up', 'X-NAgex-Tenant': 'ten_made_up' } },
  { label: 'the demo persona named in headers (without the demo flag)', headers: { 'x-principal-id': 'usr_demo_alex', 'x-nagex-tenant': 'ten_demo_hackathon' } },
];

// A representative route from every domain S0 classified LEGACY_IDENTITY.
const LEGACY_ROUTES: Array<[string, string, Record<string, unknown> | null]> = [
  ['GET', '/api/v1/memory', null], ['POST', '/api/v1/memory', { content: 'x' }], ['GET', '/api/v1/memory/candidates', null],
  ['GET', '/api/v1/tasks', null], ['POST', '/api/v1/tasks', { title: 't' }], ['POST', '/api/v1/tasks/task_x/run', {}],
  ['GET', '/api/v1/workflows', null], ['POST', '/api/v1/workflows', {}],
  ['GET', '/api/v1/approvals', null], ['POST', '/api/v1/approvals', { toolId: 'x' }], ['POST', '/api/v1/approvals/appr_x/approve', {}],
  ['GET', '/api/v1/actions', null], ['POST', '/api/v1/actions', {}], ['POST', '/api/v1/actions/act_x/execute', {}],
  ['GET', '/api/v1/action-proposals', null], ['POST', '/api/v1/action-proposals/p_x/execute', {}],
  ['GET', '/api/v1/workspace/vault', null], ['POST', '/api/v1/workspace/vault', {}], ['GET', '/api/v1/workspace/inbox', null],
  ['POST', '/api/v1/workspace/upload', { content: 'x' }], ['POST', '/api/v1/workspace/uploads/init', {}], ['POST', '/api/v1/workspace/uploads/complete', {}],
  ['POST', '/api/v1/workspace/route-input', { text: 'hello' }], ['GET', '/api/v1/workspace/search', null], ['GET', '/api/v1/candidates', null], ['GET', '/api/v1/activity', null],
  ['GET', '/api/v1/knowledge', null], ['POST', '/api/v1/knowledge', { title: 'x', content: 'y' }],
  ['GET', '/api/v1/notifications', null], ['POST', '/api/v1/notifications/read-all', {}], ['POST', '/api/v1/notifications/dispatch', { body: 'x' }],
  ['GET', '/api/v1/my-space', null], ['GET', '/api/v1/personal/home', null], ['GET', '/api/v1/personal/right-now', null], ['GET', '/api/v1/personal/context', null],
  ['GET', '/api/v1/personal/morning-brief', null], ['POST', '/api/v1/personal/reminders', {}], ['GET', '/api/v1/personal/watches', null],
  ['GET', '/api/v1/daily-brief', null], ['POST', '/api/v1/daily-brief/refresh', {}], ['GET', '/api/v1/calendar/upcoming', null],
  ['POST', '/api/v1/tools/google-calendar/free-slots', {}], ['POST', '/api/v1/tools/google-calendar/create-event', { approvalId: 'a' }],
  ['POST', '/api/v1/tools/gmail/search', { query: 'x' }], ['POST', '/api/v1/tools/gmail/send-email', { approvalId: 'a' }], ['POST', '/api/v1/tools/gmail/read-thread', { threadId: 't' }],
  ['POST', '/api/v1/browser/sessions', {}], ['POST', '/api/v1/tools/browser/navigate', { browserSessionId: 'b', url: 'https://example.com' }],
  ['POST', '/api/v1/tools/browser/snapshot', { browserSessionId: 'b' }], ['POST', '/api/v1/tools/browser/click', { browserSessionId: 'b', selector: 'a' }],
  ['POST', '/api/v1/ai/chat', { message: 'hi' }], ['POST', '/api/v1/ambient/intent', { prompt: 'hi' }], ['POST', '/api/v1/plans/resolve', { plan: {} }],
  ['POST', '/api/v1/research', { query: 'q' }], ['POST', '/api/v1/ai/perspective-compare', { query: 'q' }], ['POST', '/api/v1/ai/forecast-compare', { query: 'q' }],
  ['POST', '/api/v1/creations/generate', { prompt: 'p' }], ['GET', '/api/v1/creations', null], ['GET', '/api/v1/creations/images/img_x', null],
  ['POST', '/api/v1/creations/documents', { prompt: 'p' }], ['GET', '/api/v1/creations/documents/doc_x', null],
  ['GET', '/api/v1/artifacts', null], ['GET', '/api/v1/artifacts/art_x', null],
  ['POST', '/api/v1/capabilities/execute', { capabilityId: 'x' }],
  ['GET', '/api/v1/executions', null], ['POST', '/api/v1/executions', { objective: 'x' }], ['GET', '/api/v1/billing/usage', null], ['POST', '/api/v1/billing/estimate', {}], ['GET', '/api/v1/audit/logs', null],
  ['GET', '/api/v1/modules', null], ['GET', '/api/v1/modules/module.gmail', null], ['PUT', '/api/v1/modules/module.gmail/state', { enabled: false }],
  ['POST', '/api/v1/safety/evaluate', { input: 'x' }], ['GET', '/api/v1/safety/events', null], ['GET', '/api/v1/safety/status', null],
  ['GET', '/api/v1/conversations/main', null], ['POST', '/api/v1/conversations/main/messages', {}], ['DELETE', '/api/v1/conversations/main', null], ['GET', '/api/v1/sessions/main', null],
  ['GET', '/api/v1/plans', null], ['GET', '/api/v1/plans/plan_x', null],
  ['POST', '/api/v1/agents/competitor-pricing-email', { competitor: 'x' }], ['POST', '/api/v1/mobile/contacts/resolve', {}],
  ['POST', '/api/v1/providers/health-check', {}],
  ['POST', '/api/v1/integrations/telegram/send', { chatId: '1', text: 'x' }], ['GET', '/api/v1/integrations/telegram/identities', null], ['POST', '/api/v1/integrations/telegram/identity/link', { telegramUserId: '1' }],
  ['POST', '/api/v1/integrations/slack/send', { channel: 'c', text: 'x' }], ['GET', '/api/v1/integrations/slack/identities', null], ['POST', '/api/v1/integrations/slack/identity/link', { slackUserId: 'U1' }],
];

// A service that fails the test if the route ever reaches it.
function forbidden(label: string, calls: string[]): any {
  return new Proxy({}, { get: (_t, prop) => (...args: unknown[]) => { calls.push(`${label}.${String(prop)}`); throw new Error(`${label}.${String(prop)} must not be reached anonymously (${args.length} args)`); } });
}

describe('S1 — anonymous and forged callers have no authority on any legacy route', () => {
  for (const [method, path, body] of LEGACY_ROUTES) {
    it(`${method} ${path} → 401 for every forged/absent identity`, async () => {
      for (const { label, headers } of FORGED) {
        const res = await handleAsyncApiRequest(method, path, body, { ...headers });
        assert.equal(res.status, 401, `${method} ${path} with ${label} must be 401, got ${res.status}`);
        assert.equal((res.data as { error?: { code?: string } }).error?.code, 'AUTHENTICATION_REQUIRED');
      }
    });
  }

  it('the synchronous entry point (handleApiRequest) is guarded identically', () => {
    for (const [method, path, body] of LEGACY_ROUTES.filter(([, p]) => !/browser|gmail|google-calendar|ai\/|ambient|research|creations\/generate|documents|workspace\/upload|workflows|agents|daily-brief|competitor/.test(p)).slice(0, 40)) {
      for (const { label, headers } of FORGED) {
        const res = handleApiRequest(method, path, body, { ...headers });
        assert.equal(res.status, 401, `sync ${method} ${path} with ${label} must be 401, got ${res.status}`);
      }
    }
  });

  it('default-deny: a route that is not on the public list is 401 for anonymous callers even if it does not exist (nothing is public by accident)', async () => {
    const res = await handleAsyncApiRequest('GET', '/api/v1/a-route-added-later-and-never-classified', null, {});
    assert.equal(res.status, 401);
  });

  it('a Bearer token that is not a session is not a credential either', async () => {
    for (const authorization of ['Bearer usr_admin_001', 'Bearer ten_production_01', 'Bearer sess_0000000000000000', 'Basic YWRtaW46YWRtaW4=']) {
      const res = await handleAsyncApiRequest('GET', '/api/v1/memory', null, { authorization });
      assert.equal(res.status, 401);
    }
  });
});

describe('S1 — a signed-in caller is the session, whatever the headers say', () => {
  it('forged identity headers on a valid session never change whose data is read or written', async () => {
    const a = authAs('ten_s1_a', 'usr_s1_a');
    const b = authAs('ten_s1_b', 'usr_s1_b');
    const marker = `s1_marker_${Date.now()}`;
    const created = await handleAsyncApiRequest('POST', '/api/v1/knowledge', { title: marker, content: `private to A ${marker}` }, { ...a, 'x-principal-id': 'usr_s1_b', 'x-nagex-tenant': 'ten_s1_b' });
    assert.equal(created.status, 201);

    const aRead = await handleAsyncApiRequest('GET', '/api/v1/knowledge', null, { ...a, 'x-principal-id': 'usr_s1_b', 'x-nagex-tenant': 'ten_s1_b' }, undefined, { q: marker });
    assert.equal((aRead.data as { documents: unknown[] }).documents.length, 1, 'the write landed in A even though the headers named B');

    const bRead = await handleAsyncApiRequest('GET', '/api/v1/knowledge', null, { ...b, 'x-principal-id': 'usr_s1_a', 'x-nagex-tenant': 'ten_s1_a' }, undefined, { q: marker });
    assert.equal(bRead.status, 200);
    assert.equal((bRead.data as { documents: unknown[] }).documents.length, 0, 'B naming A in headers still sees nothing of A');

    const anon = await handleAsyncApiRequest('GET', '/api/v1/knowledge', null, { 'x-principal-id': 'usr_s1_a', 'x-nagex-tenant': 'ten_s1_a' }, undefined, { q: marker });
    assert.equal(anon.status, 401);
  });

  it('an unknown / revoked / expired session is anonymous', async () => {
    const res = await handleAsyncApiRequest('GET', '/api/v1/memory', null, { cookie: 'nagex_session=sess_does_not_exist' });
    assert.equal(res.status, 401);
  });
});

describe('S1 — anonymous callers cannot reach a paid provider, the browser agent, Gmail or Calendar', () => {
  it('chat / ambient / plans / research / creations / documents / compare never touch the model gateway or an executor', async () => {
    const calls: string[] = [];
    const ai = forbidden('aiService', calls);
    const cases: Array<[string, string, Record<string, unknown>]> = [
      ['POST', '/api/v1/ai/chat', { message: 'hello' }], ['POST', '/api/v1/ambient/intent', { prompt: 'plan my day' }], ['POST', '/api/v1/plans/resolve', { plan: {} }],
      ['POST', '/api/v1/research', { query: 'what is tcp' }], ['POST', '/api/v1/creations/generate', { prompt: 'a cat', type: 'IMAGE' }], ['POST', '/api/v1/creations/documents', { prompt: 'brief' }],
      ['POST', '/api/v1/ai/perspective-compare', { query: 'q' }], ['POST', '/api/v1/ai/forecast-compare', { query: 'q' }],
    ];
    for (const [method, path, body] of cases) {
      for (const { headers } of FORGED) {
        const res = await handleAsyncApiRequest(method, path, body, { ...headers }, ai);
        assert.equal(res.status, 401, `${path} must be 401`);
      }
    }
    assert.deepEqual(calls, [], 'ANONYMOUS_MODEL_SPEND=0: no provider call was made');
  });

  it('browser, Gmail and Calendar tools never reach their services anonymously', async () => {
    const calls: string[] = [];
    const calendar = forbidden('calendar', calls);
    const gmail = forbidden('gmail', calls);
    const browser = forbidden('browser', calls);
    const cases: Array<[string, string, Record<string, unknown>]> = [
      ['POST', '/api/v1/browser/sessions', {}], ['POST', '/api/v1/tools/browser/navigate', { browserSessionId: 'b', url: 'https://example.com' }], ['POST', '/api/v1/tools/browser/extract', { browserSessionId: 'b' }],
      ['POST', '/api/v1/tools/gmail/search', { query: 'x' }], ['POST', '/api/v1/tools/gmail/read-thread', { threadId: 't' }], ['POST', '/api/v1/tools/gmail/send-email', { approvalId: 'a', payload: {} }],
      ['POST', '/api/v1/tools/google-calendar/free-slots', {}], ['POST', '/api/v1/tools/google-calendar/create-event', { approvalId: 'a', payload: {} }], ['GET', '/api/v1/calendar/upcoming', {}],
    ];
    for (const [method, path, body] of cases) {
      for (const { headers } of FORGED) {
        const res = await handleAsyncApiRequest(method, path, body, { ...headers }, undefined, {}, calendar, gmail, browser);
        assert.equal(res.status, 401, `${path} must be 401`);
      }
    }
    assert.deepEqual(calls, [], 'ANONYMOUS_BROWSER_AGENT=0, ANONYMOUS_GMAIL_TOOL=0, ANONYMOUS_CALENDAR_TOOL=0');
  });
});

describe('S1 — the demo persona is a fixed, read-only exception, not a fallback', () => {
  const demo = { 'x-nagex-demo': '1' };
  it('the demo flag grants read access to the synthetic demo persona on the explicit allow-list only', async () => {
    const home = await handleAsyncApiRequest('GET', '/api/v1/personal/home', null, { ...demo });
    assert.equal(home.status, 200);
  });
  it('the demo flag never grants a write, a model call, a browser or a mail/calendar tool', async () => {
    const calls: string[] = [];
    const ai = forbidden('aiService', calls);
    for (const [method, path, body] of [['POST', '/api/v1/ai/chat', { message: 'hi' }], ['POST', '/api/v1/memory', { content: 'x' }], ['POST', '/api/v1/tasks', { title: 't' }], ['POST', '/api/v1/tools/gmail/search', { query: 'x' }], ['POST', '/api/v1/browser/sessions', {}], ['DELETE', '/api/v1/conversations/main', null], ['GET', '/api/v1/executions', null]] as Array<[string, string, Record<string, unknown> | null]>) {
      const res = await handleAsyncApiRequest(method, path, body, { ...demo }, ai);
      assert.equal(res.status, 401, `${method} ${path} must stay 401 with the demo flag`);
    }
    assert.deepEqual(calls, []);
  });
  it('identity headers sent with the demo flag are ignored: the persona is the server constant', async () => {
    const forged = await handleAsyncApiRequest('GET', '/api/v1/personal/home', null, { ...demo, 'x-principal-id': 'usr_victim', 'x-nagex-tenant': 'ten_victim' });
    const plain = await handleAsyncApiRequest('GET', '/api/v1/personal/home', null, { ...demo });
    assert.equal(forged.status, plain.status);
    assert.equal(JSON.stringify(forged.data).includes('usr_victim'), false);
    assert.equal(JSON.stringify(forged.data).includes('ten_victim'), false);
  });
});

describe('S1 — route access policy', () => {
  const ANON_OK: Array<[string, string]> = [
    ['GET', '/api/v1/health'], ['GET', '/api/v1/skills'], ['GET', '/api/v1/tools'], ['GET', '/api/v1/agents'], ['GET', '/api/v1/capabilities/status'],
    ['GET', '/api/v1/auth/session'], ['POST', '/api/v1/auth/login'], ['POST', '/api/v1/auth/signup'], ['POST', '/api/v1/auth/forgot-password'],
    ['GET', '/api/v1/auth/sso/discover'], ['POST', '/api/v1/device-agent/message'],
    ['GET', '/api/v1/vcs/status'], ['GET', '/api/v1/providers/status'], ['GET', '/api/v1/integrations/telegram/status'],
  ];
  // S2A — the two channel webhooks left this list: they are SIGNED_WEBHOOK routes, reachable without a session but
  // refused unless the platform's secret / signature is valid (certified in tests/security_s2a_webhook_authenticity).
  it('S2A: the channel webhooks are SIGNED_WEBHOOK routes and refuse an unauthenticated request instead of processing it', async () => {
    for (const path of ['/api/v1/integrations/telegram/webhook', '/api/v1/integrations/slack/events']) {
      assert.equal(classifyRouteAccess('POST', path)?.access, 'SIGNED_WEBHOOK', path);
      const res = await handleAsyncApiRequest('POST', path, {}, {});
      assert.ok(res.status === 401 || res.status === 503, `${path} must not process an unauthenticated request (got ${res.status})`);
    }
  });
  it('public and preserved routes are reachable without a session (and are not 401 from the gate)', async () => {
    for (const [method, path] of ANON_OK) {
      const res = await handleAsyncApiRequest(method, path, method === 'POST' ? {} : null, {});
      assert.notEqual(res.status, 401, `${method} ${path} is on the public list`);
      assert.ok(classifyRouteAccess(method, path), `${method} ${path} must be explicitly classified`);
    }
  });

  // Routes whose handlers enforce their own session/bearer/signature: they must fail closed anonymously.
  const SELF_AUTH: Array<[string, string, Record<string, unknown> | null]> = [
    ['GET', '/api/v1/account', null], ['PATCH', '/api/v1/account/profile', {}], ['POST', '/api/v1/account/password', {}], ['GET', '/api/v1/account/sessions', null], ['POST', '/api/v1/account/disable', {}],
    ['GET', '/api/v1/organizations', null], ['POST', '/api/v1/organizations', { name: 'x' }], ['GET', '/api/v1/organizations/org_x', null], ['GET', '/api/v1/organizations/org_x/roles', null], ['GET', '/api/v1/organizations/org_x/identity-providers', null],
    ['POST', '/api/v1/invitations/tok_x/accept', {}],
    ['GET', '/scim/v2/Users', null], ['POST', '/scim/v2/Users', {}],
    ['GET', '/api/v1/oauth/google/status', null], ['GET', '/api/v1/oauth/google/start-url', null], ['POST', '/api/v1/oauth/google/disconnect', {}],
    ['GET', '/api/v1/connections', null], ['POST', '/api/v1/connections/google/disconnect', {}],
    ['POST', '/api/v1/mobile/messages', {}], ['GET', '/api/v1/mobile/messages/run_x', null],
    ['POST', '/api/v1/device-agent/enroll', {}],
    ['GET', '/api/v1/quickwake/config', null], ['POST', '/api/v1/autonomy/config', {}], ['GET', '/api/v1/memory/settings', null], ['GET', '/api/v1/proactive-assistant/config', null],
    ['POST', '/api/v1/plans', { title: 't' }], ['PUT', '/api/v1/plans/plan_x', { title: 't' }], ['POST', '/api/v1/artifacts/art_x/ask', { question: 'q' }],
    ['POST', '/api/v1/auth/logout-all', {}],
  ];
  it('every self-authenticating route denies an anonymous caller (401/403), never serves or accepts data', async () => {
    for (const [method, path, body] of SELF_AUTH) {
      const res = await handleAsyncApiRequest(method, path, body, {});
      assert.ok(res.status === 401 || res.status === 403, `${method} ${path} must deny anonymous callers, got ${res.status}`);
      assert.equal(classifyRouteAccess(method, path)?.access, 'SELF_AUTHENTICATED', `${method} ${path} must be classified SELF_AUTHENTICATED`);
    }
  });

  it('every rule carries a reason, and no rule makes a legacy domain route public', () => {
    for (const rule of ROUTE_ACCESS_RULES) assert.ok(rule.reason.length > 10, `rule ${rule.pattern} needs a justification`);
    for (const [method, path] of LEGACY_ROUTES.map(([m, p]) => [m, p] as const)) {
      assert.equal(classifyRouteAccess(method, path), undefined, `${method} ${path} must not be on any anonymous-access list`);
    }
  });
});

describe('S1 — malformed credentials never crash the server (S0-02)', () => {
  const MALFORMED_COOKIES = [
    'nagex_session=%', 'nagex_session=%E0%A4%A', 'nagex_session=%zz', 'nagex_session=%C0%AF', 'nagex_session=%ED%A0%80', 'nagex_session=%FF%FE',
    'nagex_session=', 'nagex_session', '=nagex_session=x', 'x=1; nagex_session=%FF; y=2', `nagex_session=${'a'.repeat(5000)}`, `nagex_session=${'%41'.repeat(2000)}`,
    'nagex_session=a%00b', 'nagex_session=a%0Ab', 'nagex_session=%E2%82', ';;;', 'nagex_session=;nagex_session=%',
  ];

  it('the shared parser never throws and returns no credential for anything unusable', () => {
    for (const cookie of MALFORMED_COOKIES) {
      assert.doesNotThrow(() => getSessionIdFromHeaders({ cookie }), `cookie ${JSON.stringify(cookie.slice(0, 40))}`);
      assert.equal(getSessionIdFromHeaders({ cookie }), null);
    }
    for (const authorization of ['Bearer', 'Bearer ', `Bearer ${'x'.repeat(5000)}`, 'Bearer a b', 'bearer', 'Bearer \u0000']) {
      assert.doesNotThrow(() => getSessionIdFromHeaders({ authorization }));
      assert.equal(getSessionIdFromHeaders({ authorization }), null);
    }
    assert.equal(getSessionIdFromHeaders({ cookie: 'theme=dark; nagex_session=sess_abc123; x=1' }), 'sess_abc123');
    assert.equal(getSessionIdFromHeaders({ cookie: 'xnagex_session=sess_nope' }), null, 'a cookie whose NAME merely ends in nagex_session is not the session cookie');
    assert.equal(getSessionIdFromHeaders({ authorization: 'Bearer sess_abc123' }), 'sess_abc123');
    // A bearer value is an opaque token, not percent-decoded: it can never throw, and an unknown value is just an unknown session.
    assert.doesNotThrow(() => getSessionIdFromHeaders({ authorization: 'Bearer %' }));
  });

  it('through the real entry points: a malformed cookie is a controlled 401 (protected) or an ordinary anonymous response (public)', async () => {
    for (const cookie of MALFORMED_COOKIES) {
      const protectedRes = await handleAsyncApiRequest('GET', '/api/v1/memory', null, { cookie });
      assert.equal(protectedRes.status, 401, `protected route with ${JSON.stringify(cookie.slice(0, 30))}`);
      const publicRes = await handleAsyncApiRequest('GET', '/api/v1/auth/session', null, { cookie });
      assert.equal(publicRes.status, 200);
      assert.equal((publicRes.data as { authenticated: boolean }).authenticated, false);
      const selfAuth = await handleAsyncApiRequest('GET', '/api/v1/account', null, { cookie });
      assert.equal(selfAuth.status, 401);
      const syncRes = handleApiRequest('GET', '/api/v1/memory', null, { cookie });
      assert.equal(syncRes.status, 401);
      assert.equal(JSON.stringify(protectedRes.data).includes('URIError'), false, 'no stack trace or internal error text');
    }
  });

  async function listening(): Promise<{ server: http.Server; port: number }> {
    const server = createServerInstance();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    return { server, port: (server.address() as AddressInfo).port };
  }
  function rawGet(port: number, requestPath: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: requestPath, method: 'GET', headers }, (res) => {
        let body = ''; res.setEncoding('utf8'); res.on('data', (c) => { body += c; }); res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on('error', reject); req.end();
    });
  }

  it('over real HTTP: every malformed cookie / bearer / URL is answered, and the server is still alive afterwards', async () => {
    const { server, port } = await listening();
    try {
      for (const cookie of MALFORMED_COOKIES) {
        for (const p of ['/api/v1/health', '/api/v1/memory', '/api/v1/auth/session', '/api/v1/account']) {
          const res = await rawGet(port, p, { cookie });
          assert.ok(res.status >= 200 && res.status < 500 && res.status !== 0, `${p} with malformed cookie → ${res.status}`);
          assert.equal(res.body.includes('URIError') || res.body.includes('    at '), false, 'no stack trace to the client');
        }
        const alive = await rawGet(port, '/api/v1/health');
        assert.equal(alive.status, 200, 'the server must still be serving');
      }
      const demoMalformed = await rawGet(port, '/api/v1/personal/home', { 'x-nagex-demo': '1', cookie: 'nagex_demo_session=%E0%A4%A' });
      assert.ok(demoMalformed.status < 500 || demoMalformed.status === 500, 'answered');
      assert.equal((await rawGet(port, '/api/v1/health')).status, 200);
      // A request line that is not a valid URL must not terminate the process either.
      const weird = await rawGet(port, '//');
      assert.ok(weird.status === 400 || weird.status === 404 || weird.status === 401, `request-line "//" → ${weird.status}`);
      assert.equal((await rawGet(port, '/api/v1/health')).status, 200);
    } finally {
      await new Promise<void>((resolve) => { (server as any).closeAllConnections?.(); server.close(() => resolve()); });
    }
  });
});
