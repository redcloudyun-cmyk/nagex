// R24.8B — Plan ownership and update authority, through the real production entry points
// (handleApiRequest / handleAsyncApiRequest) with real sessions. A client can neither choose a plan id,
// nor name an owner or tenant, nor author execution state, and anonymous callers cannot mutate plans.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword } from '../src/identity/identity.crypto.js';
import { getPlan, savePlan, listPlans, type PersistedPlan } from '../src/planning/plan.store.js';
import * as server from '../src/server_web.js';

const RUN = `${Date.now()}`;
let n = 0;
function user(label: string) {
  const { identity } = server.identityStore.createAccount(`r248b_${label}_${RUN}_${++n}@example.com`, hashPassword('password123'));
  server.identityStore.transitionState(identity.userId, 'ACTIVE');
  const tenantId = `ten_${identity.userId}`;
  const session = server.sessionStore.createAuthSession(tenantId, identity.userId, 'MAIN');
  return { userId: identity.userId, tenantId, headers: { cookie: `nagex_session=${session.sessionId}` } as Record<string, string> };
}
const call = (method: string, p: string, body: unknown, headers: Record<string, string>) => server.handleApiRequest(method, p, body as any, headers);
const ALLOWED_STEP_KEYS = ['dependsOn', 'necessity', 'reasoning', 'skill', 'step', 'title', 'tool'];

describe('R24.8B — POST /api/v1/plans: the server owns id, owner, tenant, status and execution state', () => {
  it('a session user creates a plan; id/owner/tenant/status/timestamps are server-generated', () => {
    const a = user('a');
    const res = call('POST', '/api/v1/plans', { title: 'My plan', originalPrompt: 'do things', steps: [{ step: 1, title: 'Step one', skill: 'research', tool: 'web.search' }] }, a.headers);
    assert.equal(res.status, 200);
    const plan = res.data as PersistedPlan;
    assert.match(plan.id, /^plan_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.equal(plan.userId, a.userId);
    assert.equal(plan.tenantId, a.tenantId);
    assert.equal(plan.status, 'READY');
    assert.equal(plan.title, 'My plan');
    assert.deepEqual(getPlan(plan.id)?.steps.map((s) => s.title), ['Step one']);
  });

  it('CLIENT_OWNERSHIP_OVERRIDE / CLIENT_TENANT_OVERRIDE: client id, userId, tenantId, status and createdAt are ignored', () => {
    const a = user('a');
    const b = user('b');
    const res = call('POST', '/api/v1/plans', { id: 'plan_attacker_chosen', userId: b.userId, tenantId: b.tenantId, status: 'COMPLETED', createdAt: '1999-01-01T00:00:00.000Z', updatedAt: '1999-01-01T00:00:00.000Z', title: 'Mine' }, a.headers);
    const plan = res.data as PersistedPlan;
    assert.equal(res.status, 200);
    assert.notEqual(plan.id, 'plan_attacker_chosen');
    assert.equal(getPlan('plan_attacker_chosen'), undefined);
    assert.equal(plan.userId, a.userId);
    assert.equal(plan.tenantId, a.tenantId);
    assert.equal(plan.status, 'READY');
    assert.notEqual(plan.createdAt, '1999-01-01T00:00:00.000Z');
  });

  it('CLIENT_EXECUTION_STATE_FORGERY: execution/resolver state on steps is never stored', () => {
    const a = user('a');
    const res = call('POST', '/api/v1/plans', {
      title: 'Forged',
      steps: [{ step: 1, title: 'Send the email', skill: 'gmail', tool: 'gmail.send', status: 'COMPLETED', result: { ok: true }, executionReadiness: 'EXECUTION_READY', resolvedToolId: 'gmail.send_message', resolvedSkillId: 'x', toolAvailability: 'AVAILABLE', approvalRequired: false, requiresApproval: false, approvalId: 'appr_forged', executionId: 'exec_forged', parameters: { to: 'attacker@example.com' }, sideEffectLevel: 'NONE' }],
    }, a.headers);
    const stored = getPlan((res.data as PersistedPlan).id)!;
    assert.deepEqual(Object.keys(stored.steps[0]).sort().filter((k) => !ALLOWED_STEP_KEYS.includes(k)), []);
    assert.equal(JSON.stringify(stored).includes('attacker@example.com'), false);
    assert.equal(JSON.stringify(stored).includes('EXECUTION_READY'), false);
    assert.equal(JSON.stringify(stored).includes('appr_forged'), false);
  });

  it('CLIENT_EXECUTION_STATE_FORGERY: plan-level execution/approval metadata and results are never stored (create or update)', () => {
    const a = user('a');
    const injected = { status: 'COMPLETED', result: { ok: true }, executionResult: 'SUCCEEDED', executionId: 'exec_forged', approvalId: 'appr_forged', approvalStatus: 'APPROVED', executionReadiness: 'EXECUTION_READY', approvalRequired: false, resolvedToolId: 'gmail.send_message', progress: 100, completedAt: '2026-01-01T00:00:00.000Z' };
    const created = call('POST', '/api/v1/plans', { title: 'Forged create', ...injected, steps: [{ title: 'x', ...injected }] }, a.headers).data as PersistedPlan;
    const PLAN_KEYS = ['createdAt', 'id', 'originalPrompt', 'status', 'steps', 'tenantId', 'title', 'updatedAt', 'userId'];
    assert.deepEqual(Object.keys(getPlan(created.id)!).sort(), PLAN_KEYS);
    assert.equal(getPlan(created.id)!.status, 'READY');
    const { status: _ignored, ...injectedNoStatus } = injected;
    const updated = call('PUT', `/api/v1/plans/${created.id}`, { title: 'Forged update', ...injectedNoStatus, steps: [{ title: 'y', ...injected }] }, a.headers);
    assert.equal(updated.status, 200);
    assert.deepEqual(Object.keys(getPlan(created.id)!).sort(), PLAN_KEYS);
    const wire = JSON.stringify(getPlan(created.id));
    for (const forged of ['exec_forged', 'appr_forged', 'SUCCEEDED', 'EXECUTION_READY', 'gmail.send_message', 'APPROVED']) assert.equal(wire.includes(forged), false, forged);
    assert.equal(getPlan(created.id)!.status, 'READY');
  });

  it('bounds: at most 50 steps, titles are capped', () => {
    const a = user('a');
    const res = call('POST', '/api/v1/plans', { title: 'x'.repeat(500), steps: Array.from({ length: 80 }, (_, i) => ({ title: `s${i}` })) }, a.headers);
    const plan = res.data as PersistedPlan;
    assert.equal(plan.steps.length, 50);
    assert.equal(plan.title.length, 200);
  });
});

describe('R24.8B — cross-user and cross-tenant plan takeover is impossible', () => {
  it('CROSS_USER_PLAN_TAKEOVER: B POSTing A\'s plan id creates a NEW plan for B and leaves A\'s plan untouched', () => {
    const a = user('a');
    const b = user('b');
    const created = call('POST', '/api/v1/plans', { title: 'A private plan', steps: [{ title: 'secret step' }] }, a.headers).data as PersistedPlan;
    const attack = call('POST', '/api/v1/plans', { id: created.id, title: 'HIJACKED', userId: a.userId, tenantId: a.tenantId }, b.headers);
    assert.equal(attack.status, 200);
    assert.notEqual((attack.data as PersistedPlan).id, created.id);
    assert.equal((attack.data as PersistedPlan).userId, b.userId);
    const aStill = getPlan(created.id)!;
    assert.equal(aStill.title, 'A private plan');
    assert.equal(aStill.userId, a.userId);
    assert.equal(aStill.tenantId, a.tenantId);
    assert.deepEqual(aStill.steps.map((s) => s.title), ['secret step']);
    // A still reads their own plan through the API.
    const aRead = call('GET', `/api/v1/plans/${created.id}`, null, { 'x-nagex-tenant': a.tenantId, 'x-principal-id': a.userId, ...a.headers });
    assert.equal(aRead.status, 200);
  });

  it('B cannot PUT, GET or learn about A\'s plan — foreign and unknown ids are the same 404', () => {
    const a = user('a');
    const b = user('b');
    const created = call('POST', '/api/v1/plans', { title: 'A plan' }, a.headers).data as PersistedPlan;
    const strip = (r: { status: number; data: unknown }) => JSON.stringify({ s: r.status, d: r.data });
    const put = call('PUT', `/api/v1/plans/${created.id}`, { title: 'pwned', status: 'CANCELLED', steps: [{ title: 'x' }] }, b.headers);
    const putUnknown = call('PUT', '/api/v1/plans/plan_does_not_exist', { title: 'pwned' }, b.headers);
    assert.equal(strip(put), strip(putUnknown));
    assert.equal(put.status, 404);
    const get = call('GET', `/api/v1/plans/${created.id}`, null, b.headers);
    assert.equal(get.status, 404);
    assert.equal(getPlan(created.id)!.title, 'A plan');
    assert.equal(getPlan(created.id)!.status, 'READY');
  });

  it('CROSS_TENANT_PLAN_TAKEOVER: forged tenant/principal headers cannot re-target a session user\'s mutation', () => {
    const a = user('a');
    const b = user('b');
    const created = call('POST', '/api/v1/plans', { title: 'A plan' }, a.headers).data as PersistedPlan;
    const forged = { ...b.headers, 'x-nagex-tenant': a.tenantId, 'x-principal-id': a.userId };
    assert.equal(call('PUT', `/api/v1/plans/${created.id}`, { title: 'pwned' }, forged).status, 404);
    const own = call('POST', '/api/v1/plans', { title: 'B plan via forged headers' }, forged).data as PersistedPlan;
    assert.equal(own.userId, b.userId);
    assert.equal(own.tenantId, b.tenantId);
    assert.equal(getPlan(created.id)!.title, 'A plan');
    assert.equal(listPlans(a.tenantId, a.userId).some((p) => p.id === own.id), false);
  });
});

describe('R24.8B — anonymous callers cannot create or change plans', () => {
  it('ANONYMOUS_PLAN_CREATE / ANONYMOUS_PLAN_UPDATE are denied (401), including forged identity headers; nothing lands in the default namespace', () => {
    const a = user('a');
    const created = call('POST', '/api/v1/plans', { title: 'A plan' }, a.headers).data as PersistedPlan;
    const before = listPlans('default-tenant', 'default-user').length;
    const anonymousHeaderSets: Array<Record<string, string>> = [{}, { 'x-principal-id': 'usr_admin_001', 'x-nagex-tenant': 'ten_production_01' }, { 'x-principal-id': a.userId, 'x-nagex-tenant': a.tenantId }, { cookie: 'nagex_session=sess_not_real' }];
    for (const headers of anonymousHeaderSets) {
      const post = call('POST', '/api/v1/plans', { title: 'ANON' }, headers);
      assert.equal(post.status, 401);
      assert.equal((post.data as any).error, 'AUTHENTICATION_REQUIRED');
      assert.equal(call('PUT', `/api/v1/plans/${created.id}`, { title: 'ANON' }, headers).status, 401);
    }
    assert.equal(listPlans('default-tenant', 'default-user').length, before);
    assert.equal(getPlan(created.id)!.title, 'A plan');
  });

  it('the same holds through the async production entry point', async () => {
    const a = user('a');
    const anon = await server.handleAsyncApiRequest('POST', '/api/v1/plans', { title: 'ANON' }, {});
    assert.equal(anon.status, 401);
    const ok = await server.handleAsyncApiRequest('POST', '/api/v1/plans', { title: 'via async' }, a.headers);
    assert.equal(ok.status, 200);
    assert.equal((ok.data as PersistedPlan).userId, a.userId);
  });
});

describe('R24.8B — PUT /api/v1/plans/:id update authority', () => {
  it('USER_EDITABLE: title, descriptive steps and DRAFT/READY/CANCELLED; the owner can still read it afterwards', () => {
    const a = user('a');
    const created = call('POST', '/api/v1/plans', { title: 'Before', steps: [{ title: 'one' }] }, a.headers).data as PersistedPlan;
    const res = call('PUT', `/api/v1/plans/${created.id}`, { title: 'After', status: 'CANCELLED', steps: [{ title: 'rewritten', status: 'COMPLETED', executionReadiness: 'EXECUTION_READY' }] }, a.headers);
    assert.equal(res.status, 200);
    const plan = res.data as PersistedPlan;
    assert.equal(plan.title, 'After');
    assert.equal(plan.status, 'CANCELLED');
    assert.deepEqual(plan.steps.map((s) => s.title), ['rewritten']);
    assert.deepEqual(Object.keys(plan.steps[0]).filter((k) => !ALLOWED_STEP_KEYS.includes(k)), []);
  });

  it('EXECUTION_MANAGED: IN_PROGRESS/COMPLETED/FAILED (or any unknown status) cannot be set by a client', () => {
    const a = user('a');
    const created = call('POST', '/api/v1/plans', { title: 'P' }, a.headers).data as PersistedPlan;
    for (const status of ['IN_PROGRESS', 'COMPLETED', 'FAILED', 'APPROVAL_REQUIRED', 'whatever', 7]) {
      const res = call('PUT', `/api/v1/plans/${created.id}`, { status }, a.headers);
      assert.equal(res.status, 400, String(status));
      assert.equal((res.data as any).error, 'PLAN_STATUS_NOT_EDITABLE');
    }
    assert.equal(getPlan(created.id)!.status, 'READY');
  });

  it('SYSTEM_MANAGED: id, owner, tenant and timestamps in a PUT body are ignored', () => {
    const a = user('a');
    const b = user('b');
    const created = call('POST', '/api/v1/plans', { title: 'P' }, a.headers).data as PersistedPlan;
    const res = call('PUT', `/api/v1/plans/${created.id}`, { title: 'P2', id: 'plan_other', userId: b.userId, tenantId: b.tenantId, createdAt: '1999-01-01T00:00:00.000Z' }, a.headers);
    const plan = res.data as PersistedPlan;
    assert.equal(plan.id, created.id);
    assert.equal(plan.userId, a.userId);
    assert.equal(plan.tenantId, a.tenantId);
    assert.equal(plan.createdAt, created.createdAt);
    assert.equal(getPlan('plan_other'), undefined);
  });

  it('a plan whose state is managed by execution is locked against client edits (409)', () => {
    const a = user('a');
    const created = call('POST', '/api/v1/plans', { title: 'Running' }, a.headers).data as PersistedPlan;
    savePlan({ ...getPlan(created.id)!, status: 'COMPLETED' });
    const res = call('PUT', `/api/v1/plans/${created.id}`, { title: 'rewrite history', steps: [{ title: 'x' }] }, a.headers);
    assert.equal(res.status, 409);
    assert.equal((res.data as any).error, 'PLAN_STATE_LOCKED');
    assert.equal(getPlan(created.id)!.title, 'Running');
  });
});
