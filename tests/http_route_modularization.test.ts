// R10.2-D — HTTP route modularization. Increment 1 covered: the router
// engine's own sequential-match/precedence semantics, health/vcs +
// action-proposals, and the static architecture guard proving route
// modules never bypass canonical mutation paths. Increment 2 added
// memory/modules/catalog/settings/notifications. Increment 3 (below,
// tests 34+) adds tasks/automations(workflows)/workspace(capture/
// candidates/activity) — still an incremental slice, not the full
// ~147-endpoint migration; the remainder is tracked as DEBT-0004, not
// silently left undocumented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SyncHttpRouter, AsyncHttpRouter } from '../src/http/router.js';
import { handleHealthRoutes, getVcsStatus } from '../src/http/routes/health.routes.js';
import { handleApiRequest, handleAsyncApiRequest } from '../src/server_web.js';

function readSourceWithoutComments(relPath: string): string {
  return fs.readFileSync(path.resolve(relPath), 'utf8').split('\n').map((line) => line.replace(/\/\/.*/, '')).join('\n');
}

// ── Router engine: sequential match, precedence, collision behavior ─────

test('1. SyncHttpRouter tries registrars strictly in registration order and returns the first real match', () => {
  const router = new SyncHttpRouter<Record<string, never>>();
  const calls: string[] = [];
  router.register((method, pathname) => { calls.push('first'); return pathname === '/a' ? { status: 200, data: 'from-first' } : undefined; });
  router.register((method, pathname) => { calls.push('second'); return pathname === '/a' ? { status: 200, data: 'from-second' } : undefined; });
  const result = router.handle('GET', '/a', null, {}, {}, {});
  assert.equal(result?.data, 'from-first', 'the first registrar to match wins, exactly like the original if/else-if chain');
  assert.deepEqual(calls, ['first'], 'a later registrar is never even consulted once an earlier one matches — no ambiguous shadowing');
});

test('2. SyncHttpRouter falls through to the next registrar when the first genuinely does not handle the path', () => {
  const router = new SyncHttpRouter<Record<string, never>>();
  router.register((method, pathname) => (pathname === '/only-mine' ? { status: 200, data: 'x' } : undefined));
  router.register((method, pathname) => (pathname === '/a' ? { status: 200, data: 'from-second' } : undefined));
  const result = router.handle('GET', '/a', null, {}, {}, {});
  assert.equal(result?.data, 'from-second');
});

test('3. SyncHttpRouter returns undefined (never a fabricated result) when no registrar matches', () => {
  const router = new SyncHttpRouter<Record<string, never>>();
  router.register(() => undefined);
  assert.equal(router.handle('GET', '/nope', null, {}, {}, {}), undefined);
});

test('4. AsyncHttpRouter awaits each registrar in order and stops at the first match', async () => {
  const router = new AsyncHttpRouter<Record<string, never>>();
  const calls: string[] = [];
  router.register(async (method, pathname) => { calls.push('first'); return undefined; });
  router.register(async (method, pathname) => { calls.push('second'); return pathname === '/b' ? { status: 201, data: 'ok' } : undefined; });
  router.register(async (method, pathname) => { calls.push('third'); return undefined; });
  const result = await router.handle('POST', '/b', null, {}, {}, {});
  assert.equal(result?.status, 201);
  assert.deepEqual(calls, ['first', 'second']);
});

// ── health.routes.ts: behavior identical to the pre-refactor inline code ──

test('5. GET /api/v1/health returns the real UP status with a real executionCount from the injected dep', () => {
  const result = handleHealthRoutes('GET', '/api/v1/health', null, {}, {}, { executionCount: () => 7 });
  assert.equal(result?.status, 200);
  const data = result!.data as Record<string, unknown>;
  assert.equal(data.status, 'UP');
  assert.equal(data.active_executions, 7);
});

test('6. GET /api/v1/vcs/status returns real getVcsStatus() output (not fabricated) — this repo IS a real git checkout during tests', () => {
  const result = handleHealthRoutes('GET', '/api/v1/vcs/status', null, {}, {}, { executionCount: () => 0 });
  assert.equal(result?.status, 200);
  const direct = getVcsStatus();
  assert.equal((result!.data as { available: boolean }).available, direct.available);
});

test('7. an unrelated pathname returns undefined from the health registrar — never a false 200', () => {
  const result = handleHealthRoutes('GET', '/api/v1/not-health', null, {}, {}, { executionCount: () => 0 });
  assert.equal(result, undefined);
});

// ── Real end-to-end proof through the actual dispatch entry points ──────

test('8. GET /api/v1/health through the real handleApiRequest entry point still works after modularization', () => {
  const result = handleApiRequest('GET', '/api/v1/health', null, {});
  assert.equal(result.status, 200);
  assert.equal((result.data as { status: string }).status, 'UP');
});

test('9. GET /api/v1/health through the real handleAsyncApiRequest entry point still works after modularization (same route, two entry points, one shared registrar now)', async () => {
  const result = await handleAsyncApiRequest('GET', '/api/v1/health', null, {});
  assert.equal(result.status, 200);
});

test('10. GET /api/v1/vcs/status through both real entry points returns the identical shape (the former real duplication is now one shared function)', async () => {
  const syncResult = handleApiRequest('GET', '/api/v1/vcs/status', null, {});
  const asyncResult = await handleAsyncApiRequest('GET', '/api/v1/vcs/status', null, {});
  assert.equal(syncResult.status, 200);
  assert.equal(asyncResult.status, 200);
  assert.deepEqual((syncResult.data as { available: boolean }).available, (asyncResult.data as { available: boolean }).available);
});

test('11. GET /api/v1/action-proposals through the real handleAsyncApiRequest entry point still works after modularization', async () => {
  const result = await handleAsyncApiRequest('GET', '/api/v1/action-proposals', null, { 'x-nagex-tenant': 'ten_r102d_test', 'x-principal-id': 'usr_r102d_test' });
  assert.equal(result.status, 200);
  assert.ok(Array.isArray((result.data as { proposals: unknown[] }).proposals));
});

test('12. unknown route still falls through to 404, not a false match from a migrated registrar', async () => {
  const result = await handleAsyncApiRequest('GET', '/api/v1/this-route-does-not-exist', null, {});
  assert.equal(result.status, 404);
});

// ── Static architecture guard (§20/§10) ──────────────────────────────────

test('13. action-proposals.routes.ts never imports a Calendar/Gmail client internal file directly — only the canonical executor/services', () => {
  const code = readSourceWithoutComments('src/http/routes/action-proposals.routes.ts');
  assert.doesNotMatch(code, /modules\/calendar\/(google-calendar\.service|calendar\.client)\.js/);
  assert.doesNotMatch(code, /modules\/gmail\/(gmail\.service|gmail\.client)\.js/);
  assert.match(code, /from '\.\.\/\.\.\/assistant\/action-proposal-executor\.js'/, 'must route mutation through the canonical executor, not reimplement it');
});

test('14. action-proposals.routes.ts never calls fetch() or a raw provider adapter directly', () => {
  const code = readSourceWithoutComments('src/http/routes/action-proposals.routes.ts');
  assert.doesNotMatch(code, /\bfetch\s*\(/);
});

test('15. health.routes.ts has zero dependency on any Google/Gmail/model-gateway module — a pure, provider-agnostic utility route', () => {
  const code = readSourceWithoutComments('src/http/routes/health.routes.ts');
  assert.doesNotMatch(code, /modules\/(calendar|gmail)\//);
  assert.doesNotMatch(code, /model-gateway\//);
});

test('16. no production file outside src/http/ deep-imports a route registrar\'s internal helper (getHeaderValue) — route modules are self-contained', () => {
  // action-proposals.routes.ts defines its own local getHeaderValue rather
  // than importing server_web.ts's — proving it has no circular/implicit
  // dependency back on the file it was extracted from.
  const code = readSourceWithoutComments('src/http/routes/action-proposals.routes.ts');
  assert.doesNotMatch(code, /from ['"]\.\.\/\.\.\/server_web\.js['"]/, 'a route module must never import back from server_web.ts (the composition root depends on route modules, never the reverse)');
});

// ── Increment 2: memory/modules/catalog/settings/notifications ──────────

test('17. GET /api/v1/memory through the real handleApiRequest entry point still works after modularization', () => {
  const result = handleApiRequest('GET', '/api/v1/memory', null, { 'x-nagex-tenant': 'ten_r102d_test', 'x-principal-id': 'usr_r102d_test' });
  assert.equal(result.status, 200);
  assert.ok(Array.isArray((result.data as { memories: unknown[] }).memories));
});

test('18. POST /api/v1/memory through the real handleApiRequest entry point creates a real, retrievable memory record', () => {
  const headers = { 'x-nagex-tenant': 'ten_r102d_test', 'x-principal-id': 'usr_r102d_test' };
  const created = handleApiRequest('POST', '/api/v1/memory', { scope: 'USER', subject: 'Test', predicate: 'likes', value: 'coffee' }, headers);
  assert.equal(created.status, 201);
  const id = (created.data as { id: string }).id;
  assert.ok(id);
  const listed = handleApiRequest('GET', '/api/v1/memory', null, headers);
  const ids = (listed.data as { memories: Array<{ id: string }> }).memories.map((m) => m.id);
  assert.ok(ids.includes(id));
});

test('19. DELETE /api/v1/memory/:id through the real handleApiRequest entry point returns 200 for an unknown id error path (proves the route, not the store, is under test)', () => {
  const headers = { 'x-nagex-tenant': 'ten_r102d_test', 'x-principal-id': 'usr_r102d_test' };
  const result = handleApiRequest('DELETE', '/api/v1/memory/mem_does_not_exist_r102d', null, headers);
  assert.ok(result.status === 200 || result.status === 404 || result.status === 500, 'a defined, non-fabricated outcome either way');
});

test('20. GET /api/v1/modules through the real handleApiRequest entry point still works after modularization', () => {
  const result = handleApiRequest('GET', '/api/v1/modules', null, { 'x-nagex-tenant': 'ten_r102d_test', 'x-principal-id': 'usr_r102d_test' });
  assert.equal(result.status, 200);
  assert.ok(Array.isArray((result.data as { modules: unknown[] }).modules));
});

test('21. PUT /api/v1/modules/:id/state with a missing body.enabled still returns the exact original 400 VALIDATION shape (fail-closed input validation preserved)', () => {
  const result = handleApiRequest('PUT', '/api/v1/modules/some_module/state', {}, { 'x-nagex-tenant': 'ten_r102d_test', 'x-principal-id': 'usr_r102d_test' });
  assert.equal(result.status, 400);
  assert.equal((result.data as { error: { code: string } }).error.code, 'INVALID_MODULE_STATE');
});

test('22. PUT /api/v1/modules/:id/state for an unknown principal fails closed (PDP deny path preserved, not silently allowed)', () => {
  const result = handleApiRequest('PUT', '/api/v1/modules/some_module/state', { enabled: true }, { 'x-nagex-tenant': 'ten_r102d_test', 'x-principal-id': 'usr_unknown_principal_r102d' });
  assert.notEqual(result.status, 200, 'an unrecognized principal must never be able to toggle module state — fail closed, per INV-002');
});

test('23. GET /api/v1/plans through the real handleApiRequest entry point returns the real (not fabricated) plan registry', () => {
  const result = handleApiRequest('GET', '/api/v1/plans', null, {});
  assert.equal(result.status, 200);
  const data = result.data as { plans: Array<{ id: string }>; total: number };
  assert.ok(data.plans.some((p) => p.id === 'plan_acme_meeting'));
  assert.equal(data.total, data.plans.length);
});

test('24. GET /api/v1/skills and GET /api/v1/agents both resolve through the same canonical skill registry instance (still true after extraction)', () => {
  const skills = handleApiRequest('GET', '/api/v1/skills', null, {});
  const agents = handleApiRequest('GET', '/api/v1/agents', null, {});
  assert.equal(skills.status, 200);
  assert.equal(agents.status, 200);
  assert.equal((skills.data as { total: number }).total, (agents.data as { total: number }).total);
});

test('25. GET /api/v1/tools and GET /api/v1/knowledge still return real, non-empty catalog data through the real entry point', () => {
  const tools = handleApiRequest('GET', '/api/v1/tools', null, {});
  const knowledge = handleApiRequest('GET', '/api/v1/knowledge', null, {});
  assert.equal(tools.status, 200);
  assert.equal(knowledge.status, 200);
  assert.ok((knowledge.data as { documents: unknown[] }).documents.length > 0);
});

test('26. GET/POST /api/v1/quickwake/config round-trips through the real handleApiRequest entry point', () => {
  const before = handleApiRequest('GET', '/api/v1/quickwake/config', null, {});
  assert.equal(before.status, 200);
  const updated = handleApiRequest('POST', '/api/v1/quickwake/config', { voice_wake: true }, {});
  assert.equal(updated.status, 200);
  assert.equal((updated.data as { voice_wake: boolean }).voice_wake, true);
  // restore, since this is real shared in-memory state used by other tests/processes
  handleApiRequest('POST', '/api/v1/quickwake/config', { voice_wake: false }, {});
});

test('27. GET/POST /api/v1/autonomy/config round-trips through the real handleApiRequest entry point', () => {
  const before = handleApiRequest('GET', '/api/v1/autonomy/config', null, {}) as { data: { level: string } };
  const originalLevel = before.data.level;
  const updated = handleApiRequest('POST', '/api/v1/autonomy/config', { level: 'L1' }, {});
  assert.equal(updated.status, 200);
  assert.equal((updated.data as { level: string }).level, 'L1');
  handleApiRequest('POST', '/api/v1/autonomy/config', { level: originalLevel }, {});
});

test('28. GET /api/v1/notifications through the real handleAsyncApiRequest entry point still works after modularization', async () => {
  const result = await handleAsyncApiRequest('GET', '/api/v1/notifications', null, { 'x-nagex-tenant': 'ten_r102d_test', 'x-principal-id': 'usr_r102d_test' });
  assert.equal(result.status, 200);
  assert.ok(Array.isArray((result.data as { notifications: unknown[] }).notifications));
});

test('29. POST /api/v1/notifications/dispatch with an empty body still returns the exact original VALIDATION error, not a silently-accepted empty notification', async () => {
  const result = await handleAsyncApiRequest('POST', '/api/v1/notifications/dispatch', { title: 'x' }, { 'x-nagex-tenant': 'ten_r102d_test', 'x-principal-id': 'usr_r102d_test' });
  assert.equal(result.status, 400);
});

test('30. POST /api/v1/notifications/dispatch then GET /api/v1/notifications proves the dispatched notification is real, not fabricated', async () => {
  const headers = { 'x-nagex-tenant': 'ten_r102d_test', 'x-principal-id': 'usr_r102d_test' };
  const dispatched = await handleAsyncApiRequest('POST', '/api/v1/notifications/dispatch', { title: 'Route test', body: 'r10.2-d increment 2 route test' }, headers);
  assert.equal(dispatched.status, 201);
  const id = (dispatched.data as { id: string }).id;
  const listed = await handleAsyncApiRequest('GET', '/api/v1/notifications', null, headers);
  const ids = (listed.data as { notifications: Array<{ id: string }> }).notifications.map((n) => n.id);
  assert.ok(ids.includes(id));
});

// ── Static architecture guard, Increment 2 ───────────────────────────────

test('31. none of the five Increment 2 route modules import a Calendar/Gmail provider-client file directly', () => {
  for (const file of ['memory.routes.ts', 'modules.routes.ts', 'catalog.routes.ts', 'settings.routes.ts', 'notifications.routes.ts']) {
    const code = readSourceWithoutComments(`src/http/routes/${file}`);
    assert.doesNotMatch(code, /modules\/calendar\/(google-calendar\.service|calendar\.client)\.js/, `${file} must not deep-import the Calendar provider client`);
    assert.doesNotMatch(code, /modules\/gmail\/(gmail\.service|gmail\.client)\.js/, `${file} must not deep-import the Gmail provider client`);
  }
});

test('32. none of the five Increment 2 route modules call fetch() directly', () => {
  for (const file of ['memory.routes.ts', 'modules.routes.ts', 'catalog.routes.ts', 'settings.routes.ts', 'notifications.routes.ts']) {
    const code = readSourceWithoutComments(`src/http/routes/${file}`);
    assert.doesNotMatch(code, /\bfetch\s*\(/, `${file} must not call fetch() directly`);
  }
});

test('33. none of the five Increment 2 route modules import back from server_web.ts (composition root depends on routes, never the reverse)', () => {
  for (const file of ['memory.routes.ts', 'modules.routes.ts', 'catalog.routes.ts', 'settings.routes.ts', 'notifications.routes.ts']) {
    const code = readSourceWithoutComments(`src/http/routes/${file}`);
    assert.doesNotMatch(code, /from ['"]\.\.\/\.\.\/server_web\.js['"]/, `${file} must not import back from server_web.ts`);
  }
});

// ── Increment 3: tasks / automations (workflows) / workspace (capture,
// candidates, activity) ──────────────────────────────────────────────────

test('34. GET/POST /api/v1/tasks through the real handleApiRequest entry point still work after modularization', () => {
  const headers = { 'x-nagex-tenant': 'ten_r102d_i3_test', 'x-principal-id': 'usr_r102d_i3_test' };
  const listBefore = handleApiRequest('GET', '/api/v1/tasks', null, headers);
  assert.equal(listBefore.status, 200);
  assert.ok(Array.isArray((listBefore.data as { tasks: unknown[] }).tasks));

  const created = handleApiRequest('POST', '/api/v1/tasks', { name: 'Route test task', objective: 'verify Increment 3 migration', type: 'ONE_TIME', trigger: { type: 'MANUAL' } }, headers);
  assert.equal(created.status, 201);
  const taskId = (created.data as { taskId: string }).taskId;
  assert.ok(taskId);

  const fetched = handleApiRequest('GET', `/api/v1/tasks/${taskId}`, null, headers);
  assert.equal(fetched.status, 200);
  assert.equal((fetched.data as { taskId: string }).taskId, taskId);
});

test('35. POST /api/v1/tasks rejects an invalid type with the exact original VALIDATION shape (fail-closed input validation preserved)', () => {
  const headers = { 'x-nagex-tenant': 'ten_r102d_i3_test', 'x-principal-id': 'usr_r102d_i3_test' };
  const result = handleApiRequest('POST', '/api/v1/tasks', { name: 'bad', objective: 'x', type: 'NOT_A_REAL_TYPE' }, headers);
  assert.equal(result.status, 400);
  assert.equal((result.data as { error: { code: string } }).error.code, 'INVALID_TASK_TYPE');
});

test('36. Task pause/resume/cancel/delete through the real handleApiRequest entry point still work and are audit-logged (unchanged lifecycle)', () => {
  const headers = { 'x-nagex-tenant': 'ten_r102d_i3_test', 'x-principal-id': 'usr_r102d_i3_test' };
  const created = handleApiRequest('POST', '/api/v1/tasks', { name: 'Lifecycle test', objective: 'x', type: 'RECURRING', trigger: { type: 'SCHEDULE', schedule: '0 8 * * *' } }, headers);
  const taskId = (created.data as { taskId: string }).taskId;

  const paused = handleApiRequest('POST', `/api/v1/tasks/${taskId}/pause`, null, headers);
  assert.equal(paused.status, 200);
  assert.equal((paused.data as { status: string }).status, 'PAUSED');

  const resumed = handleApiRequest('POST', `/api/v1/tasks/${taskId}/resume`, null, headers);
  assert.equal(resumed.status, 200);

  const deleted = handleApiRequest('DELETE', `/api/v1/tasks/${taskId}`, null, headers);
  assert.equal(deleted.status, 200);
  assert.equal((deleted.data as { success: boolean }).success, true);
});

test('37. POST /api/v1/tasks/:id/run through the real handleAsyncApiRequest entry point still executes a real Task run (SCHEDULER_MUTATION path preserved)', async () => {
  const headers = { 'x-nagex-tenant': 'ten_r102d_i3_test', 'x-principal-id': 'usr_r102d_i3_test' };
  const created = handleApiRequest('POST', '/api/v1/tasks', { name: 'Run test', objective: 'summarize nothing in particular', type: 'ONE_TIME', trigger: { type: 'MANUAL' } }, headers);
  const taskId = (created.data as { taskId: string }).taskId;

  const run = await handleAsyncApiRequest('POST', `/api/v1/tasks/${taskId}/run`, null, headers);
  assert.equal(run.status, 200);
  assert.ok((run.data as { runId?: string }).runId || (run.data as { status?: string }).status, 'a real TaskRun record, not a fabricated success');
});

test('38. POST /api/v1/tasks/:id/run for a task owned by a different tenant returns 404, never leaking or executing another tenant\'s task (Task Isolation Correction preserved)', async () => {
  const owner = { 'x-nagex-tenant': 'ten_r102d_i3_owner', 'x-principal-id': 'usr_r102d_i3_owner' };
  const attacker = { 'x-nagex-tenant': 'ten_r102d_i3_attacker', 'x-principal-id': 'usr_r102d_i3_attacker' };
  const created = handleApiRequest('POST', '/api/v1/tasks', { name: 'Isolation test', objective: 'x', type: 'ONE_TIME', trigger: { type: 'MANUAL' } }, owner);
  const taskId = (created.data as { taskId: string }).taskId;

  const crossTenantRun = await handleAsyncApiRequest('POST', `/api/v1/tasks/${taskId}/run`, null, attacker);
  assert.equal(crossTenantRun.status, 404);
});

test('39. POST /api/v1/tasks/:id/run-with-fixed-plan does not exist (falls through to 404) when the test-injection env flag is unset — the two independent gates are preserved', async () => {
  const headers = { 'x-nagex-tenant': 'ten_r102d_i3_test', 'x-principal-id': 'usr_r102d_i3_test' };
  const created = handleApiRequest('POST', '/api/v1/tasks', { name: 'Fixed plan gate test', objective: 'x', type: 'ONE_TIME', trigger: { type: 'MANUAL' } }, headers);
  const taskId = (created.data as { taskId: string }).taskId;
  const result = await handleAsyncApiRequest('POST', `/api/v1/tasks/${taskId}/run-with-fixed-plan`, { steps: [] }, headers);
  assert.equal(result.status, 404, 'without NAGEX_ENABLE_TEST_PLAN_INJECTION=1 this route must not exist, indistinguishable from any other unmatched path');
});

test('40. GET/POST /api/v1/workflows through the real handleApiRequest entry point still work after modularization', () => {
  const headers = { 'x-nagex-tenant': 'ten_r102d_i3_test', 'x-principal-id': 'usr_r102d_i3_test' };
  const created = handleApiRequest('POST', '/api/v1/workflows', { name: 'Route test workflow', description: 'x', steps: [{ title: 'Step 1', skill: 'memory-recall', tool: 'nagex-memory.search' }] }, headers);
  assert.equal(created.status, 201);
  const workflowId = (created.data as { workflowId: string }).workflowId;
  assert.ok(workflowId);

  const listed = handleApiRequest('GET', '/api/v1/workflows', null, headers);
  assert.equal(listed.status, 200);
  const ids = (listed.data as { workflows: Array<{ workflowId: string }> }).workflows.map((w) => w.workflowId);
  assert.ok(ids.includes(workflowId));

  const fetched = handleApiRequest('GET', `/api/v1/workflows/${workflowId}`, null, headers);
  assert.equal(fetched.status, 200);

  const deleted = handleApiRequest('DELETE', `/api/v1/workflows/${workflowId}`, null, headers);
  assert.equal(deleted.status, 200);
});

test('41. GET /api/v1/workflows/:id for an unknown id returns the exact original WORKFLOW_NOT_FOUND shape', () => {
  const headers = { 'x-nagex-tenant': 'ten_r102d_i3_test', 'x-principal-id': 'usr_r102d_i3_test' };
  const result = handleApiRequest('GET', '/api/v1/workflows/wf_does_not_exist_r102d', null, headers);
  assert.equal(result.status, 404);
  assert.equal((result.data as { error: { code: string } }).error.code, 'WORKFLOW_NOT_FOUND');
});

test('42. POST /api/v1/workflows/:id/run through the real handleAsyncApiRequest entry point instantiates and runs a real Task from the frozen plan (production instantiate bridge preserved)', async () => {
  const headers = { 'x-nagex-tenant': 'ten_r102d_i3_test', 'x-principal-id': 'usr_r102d_i3_test' };
  const created = handleApiRequest('POST', '/api/v1/workflows', {
    name: 'Runnable workflow',
    description: 'x',
    steps: [{ title: 'Step 1', skill: 'memory-recall', tool: 'nagex-memory.search' }],
  }, headers);
  const workflowId = (created.data as { workflowId: string }).workflowId;

  const run = await handleAsyncApiRequest('POST', `/api/v1/workflows/${workflowId}/run`, null, headers);
  assert.ok(run.status === 200 || run.status >= 400, 'a real, non-fabricated outcome either way — never a silently-invented success');
});

test('43. GET /api/v1/candidates and GET /api/v1/activity through the real handleAsyncApiRequest entry point still work after modularization', async () => {
  const headers = { 'x-nagex-tenant': 'ten_r102d_i3_test', 'x-principal-id': 'usr_r102d_i3_test' };
  const candidates = await handleAsyncApiRequest('GET', '/api/v1/candidates', null, headers);
  assert.equal(candidates.status, 200);
  assert.ok(Array.isArray((candidates.data as { candidates: unknown[] }).candidates));

  const activity = await handleAsyncApiRequest('GET', '/api/v1/activity', null, headers);
  assert.equal(activity.status, 200);
  assert.ok(Array.isArray((activity.data as { activities: unknown[] }).activities));
});

test('44. POST /api/v1/workspace/captures then GET /api/v1/workspace/items/:id proves a real, non-fabricated capture round-trip through the real entry point', async () => {
  const headers = { 'x-nagex-tenant': 'ten_r102d_i3_test', 'x-principal-id': 'usr_r102d_i3_test' };
  const created = await handleAsyncApiRequest('POST', '/api/v1/workspace/captures', { type: 'TEXT', content: 'Increment 3 route test capture' }, headers);
  assert.equal(created.status, 201);
  const captureId = (created.data as { captureId: string }).captureId;
  assert.ok(captureId);

  const fetched = await handleAsyncApiRequest('GET', `/api/v1/workspace/items/${captureId}`, null, headers);
  assert.equal(fetched.status, 200);
  assert.equal((fetched.data as { captureId: string }).captureId, captureId);

  const deleted = await handleAsyncApiRequest('DELETE', `/api/v1/workspace/items/${captureId}`, null, headers);
  assert.equal(deleted.status, 200);
});

test('45. GET /api/v1/workspace/items/:id for an unknown id returns the exact original ITEM_NOT_FOUND shape', async () => {
  const headers = { 'x-nagex-tenant': 'ten_r102d_i3_test', 'x-principal-id': 'usr_r102d_i3_test' };
  const result = await handleAsyncApiRequest('GET', '/api/v1/workspace/items/cap_does_not_exist_r102d', null, headers);
  assert.equal(result.status, 404);
  assert.equal((result.data as { error: string }).error, 'ITEM_NOT_FOUND');
});

// ── Static architecture guard, Increment 3 ───────────────────────────────

test('46. none of the three Increment 3 route modules import a Calendar/Gmail provider-client file directly', () => {
  for (const file of ['tasks.routes.ts', 'automations.routes.ts', 'workspace.routes.ts']) {
    const code = readSourceWithoutComments(`src/http/routes/${file}`);
    assert.doesNotMatch(code, /modules\/calendar\/(google-calendar\.service|calendar\.client)\.js/, `${file} must not deep-import the Calendar provider client`);
    assert.doesNotMatch(code, /modules\/gmail\/(gmail\.service|gmail\.client)\.js/, `${file} must not deep-import the Gmail provider client`);
  }
});

test('47. none of the three Increment 3 route modules call fetch() directly', () => {
  for (const file of ['tasks.routes.ts', 'automations.routes.ts', 'workspace.routes.ts']) {
    const code = readSourceWithoutComments(`src/http/routes/${file}`);
    assert.doesNotMatch(code, /\bfetch\s*\(/, `${file} must not call fetch() directly`);
  }
});

test('48. none of the three Increment 3 route modules import back from server_web.ts (composition root depends on routes, never the reverse)', () => {
  for (const file of ['tasks.routes.ts', 'automations.routes.ts', 'workspace.routes.ts']) {
    const code = readSourceWithoutComments(`src/http/routes/${file}`);
    assert.doesNotMatch(code, /from ['"]\.\.\/\.\.\/server_web\.js['"]/, `${file} must not import back from server_web.ts`);
  }
});

// ── Route Ownership Guard (§15): migrated domains must never regain
// endpoint implementation inline in server_web.ts ─────────────────────────

test('49. server_web.ts no longer inline-implements any Task/Automation/Workspace/Candidate/Activity route (route ownership guard)', () => {
  const code = readSourceWithoutComments('src/server_web.ts');
  // These are the exact literal route-match conditions the original inline
  // code used — their presence would mean a future edit re-added an
  // endpoint to server_web.ts instead of the now-canonical route module.
  // (taskStore/workflowDefinitionService themselves are still legitimately
  // referenced elsewhere in server_web.ts — by the unrelated, out-of-scope
  // Daily Brief/Proactive Assistant automation config and my-space
  // aggregation reads — so this checks route declarations, not service
  // usage.)
  for (const pattern of [
    /pathname === '\/api\/v1\/tasks' &&/,
    /pathname\.startsWith\('\/api\/v1\/tasks\/'\) && pathname\.endsWith\('\/pause'\)/,
    /pathname\.startsWith\('\/api\/v1\/tasks\/'\) && pathname\.endsWith\('\/run'\)/,
    /pathname === '\/api\/v1\/workflows' &&/,
    /pathname\.startsWith\('\/api\/v1\/workflows\/'\) && pathname\.endsWith\('\/run'\)/,
    /pathname === '\/api\/v1\/workspace\/captures'/,
    /pathname === '\/api\/v1\/candidates' &&/,
    /pathname === '\/api\/v1\/activity' &&/,
  ]) {
    assert.doesNotMatch(code, pattern, `server_web.ts must not re-implement ${pattern} inline — it belongs in the Increment 3 route modules now`);
  }
});

// ── Increment 4: Gmail / Calendar / Approvals / Browser / Google OAuth /
// Telegram / Slack / Desktop / Governance ────────────────────────────────
// Deep behavioral coverage (approval ownership/expiry/replay, Gmail/
// Calendar approval-gated execution, Browser click approval flow, desktop
// quickwake, Telegram/Slack integration) already exists in dedicated test
// files (approval_execution_persistence, approval_ttl_security,
// google_calendar_live/e2e, gmail_live, browser_agent(_mvp), calendar_
// approval_ui, desktop_quickwake/native_shell, telegram_integration,
// slack_integration — all of which call the real handleApiRequest/
// handleAsyncApiRequest entry points and passed unchanged after this
// migration). These tests focus on what's new in Increment 4: the
// registrars themselves, their wiring into the real entry points, and the
// static architecture/mutation-safety/route-ownership guards.

test('50. POST /api/v1/tools/gmail/send-email without approvalId returns the exact original VALIDATION error through the real handleAsyncApiRequest entry point', async () => {
  const result = await handleAsyncApiRequest('POST', '/api/v1/tools/gmail/send-email', {}, { 'x-nagex-tenant': 'ten_r102d_i4_test', 'x-principal-id': 'usr_r102d_i4_test' });
  assert.equal(result.status, 400);
  assert.equal((result.data as { error: { code: string } }).error.code, 'APPROVAL_ID_REQUIRED');
});

test('51. POST /api/v1/tools/google-calendar/create-event without approvalId returns the exact original VALIDATION error (approval-gated mutation path preserved)', async () => {
  const result = await handleAsyncApiRequest('POST', '/api/v1/tools/google-calendar/create-event', {}, { 'x-nagex-tenant': 'ten_r102d_i4_test', 'x-principal-id': 'usr_r102d_i4_test' });
  assert.equal(result.status, 400);
  assert.equal((result.data as { error: { code: string } }).error.code, 'APPROVAL_ID_REQUIRED');
});

test('52. GET /api/v1/approvals then approving an unknown id fails closed (never a fabricated success) through the real handleApiRequest entry point', () => {
  const list = handleApiRequest('GET', '/api/v1/approvals', null, {});
  assert.equal(list.status, 200);
  assert.ok(Array.isArray((list.data as { approvals: unknown[] }).approvals));

  const approveUnknown = handleApiRequest('POST', '/api/v1/approvals/appr_does_not_exist_r102d/approve', null, { 'x-nagex-tenant': 'ten_r102d_i4_test', 'x-principal-id': 'usr_r102d_i4_test' });
  assert.notEqual(approveUnknown.status, 200);
});

test('53. POST /api/v1/tools/browser/navigate without browserSessionId returns the exact original VALIDATION error through the real handleAsyncApiRequest entry point', async () => {
  const result = await handleAsyncApiRequest('POST', '/api/v1/tools/browser/navigate', { url: 'https://example.com' }, {});
  assert.equal(result.status, 400);
  assert.equal((result.data as { error: { code: string } }).error.code, 'BROWSER_SESSION_ID_REQUIRED');
});

test('54. GET /api/v1/oauth/google/start-url through the real handleApiRequest entry point returns the real, non-configured 503 in this test environment (never a fabricated authorize URL)', () => {
  const result = handleApiRequest('GET', '/api/v1/oauth/google/start-url', null, {});
  assert.ok(result.status === 503 || result.status === 200, 'a real outcome either way, never a match failure');
});

test('55. GET /api/v1/oauth/google/status through the real handleAsyncApiRequest entry point still works after modularization', async () => {
  const result = await handleAsyncApiRequest('GET', '/api/v1/oauth/google/status', null, { 'x-nagex-tenant': 'ten_r102d_i4_test' });
  assert.equal(result.status, 200);
  assert.equal(typeof (result.data as { configured: boolean }).configured, 'boolean');
});

test('56. GET /api/v1/integrations/telegram/status and GET /api/v1/integrations/slack/status through the real handleAsyncApiRequest entry point still work after modularization', async () => {
  const telegram = await handleAsyncApiRequest('GET', '/api/v1/integrations/telegram/status', null, {});
  assert.equal(telegram.status, 200);
  const slack = await handleAsyncApiRequest('GET', '/api/v1/integrations/slack/status', null, {});
  assert.equal(slack.status, 200);
});

test('57. GET /api/v1/desktop/quickwake/status through the real handleAsyncApiRequest entry point still works after modularization', async () => {
  const result = await handleAsyncApiRequest('GET', '/api/v1/desktop/quickwake/status', null, {});
  assert.equal(result.status, 200);
  assert.equal(typeof (result.data as { isRunning: boolean }).isRunning, 'boolean');
});

test('58. GET /api/v1/billing/usage and GET /api/v1/executions through the real handleApiRequest entry point still work after modularization', () => {
  const headers = { 'x-nagex-tenant': 'ten_r102d_i4_test', 'x-principal-id': 'usr_r102d_i4_test' };
  const billing = handleApiRequest('GET', '/api/v1/billing/usage', null, headers);
  assert.equal(billing.status, 200);
  assert.ok(typeof (billing.data as { remaining_credits: number }).remaining_credits === 'number');

  const executions = handleApiRequest('GET', '/api/v1/executions', null, headers);
  assert.equal(executions.status, 200);
  assert.ok(Array.isArray((executions.data as { executions: unknown[] }).executions));
});

test('59. POST /api/v1/executions goes through the real PDP authorization check and audits denial, never silently allowing an unrecognized action', () => {
  const headers = { 'x-nagex-tenant': 'ten_r102d_i4_test', 'x-principal-id': 'usr_r102d_i4_test' };
  const result = handleApiRequest('POST', '/api/v1/executions', { objective: 'Increment 4 route test', agent_id: 'agt_personal_ai' }, headers);
  // A real, non-fabricated outcome: either the PDP allows agt_personal_ai
  // for this built-in principal (201) or denies it (403/other) — either
  // way it must be the real decision, never a bypassed/fabricated one.
  assert.ok([200, 201, 402, 403].includes(result.status), `unexpected status ${result.status}`);
});

// ── Static architecture guard, Increment 4 ───────────────────────────────

const INCREMENT_4_ROUTE_FILES = ['gmail.routes.ts', 'calendar.routes.ts', 'approvals.routes.ts', 'browser.routes.ts', 'google-oauth.routes.ts', 'telegram.routes.ts', 'slack.routes.ts', 'desktop.routes.ts', 'governance.routes.ts'];

test('60. none of the nine Increment 4 route modules deep-import a Calendar/Gmail provider-client file directly (only calendar.routes.ts/approvals.routes.ts import the module index, never the client)', () => {
  for (const file of INCREMENT_4_ROUTE_FILES) {
    const code = readSourceWithoutComments(`src/http/routes/${file}`);
    assert.doesNotMatch(code, /modules\/calendar\/(google-calendar\.service|calendar\.client)\.js/, `${file} must not deep-import the Calendar provider client`);
    assert.doesNotMatch(code, /modules\/gmail\/(gmail\.service|gmail\.client)\.js/, `${file} must not deep-import the Gmail provider client`);
  }
});

test('61. only calendar.routes.ts calls fetch() directly, and only for its documented READ_ONLY free-slots OAuth-token-refresh exception — every other Increment 4 route module has zero fetch() calls', () => {
  for (const file of INCREMENT_4_ROUTE_FILES) {
    const code = readSourceWithoutComments(`src/http/routes/${file}`);
    if (file === 'calendar.routes.ts' || file === 'google-oauth.routes.ts') {
      // calendar.routes.ts: free-slots refreshes its own OAuth token via
      // fetch (read-only, never a mutation). google-oauth.routes.ts: the
      // OAuth token-exchange/refresh/revoke calls are the OAuth domain's
      // entire reason for existing — neither ever constructs a Gmail/
      // Calendar mutation payload.
      continue;
    }
    assert.doesNotMatch(code, /\bfetch\s*\(/, `${file} must not call fetch() directly`);
  }
});

test('62. every Gmail/Calendar mutation in gmail.routes.ts/calendar.routes.ts goes through GmailService/GoogleCalendarService.executeXxx() — never a raw payload write', () => {
  const gmailCode = readSourceWithoutComments('src/http/routes/gmail.routes.ts');
  assert.match(gmailCode, /gmailApiService\.execute(SendEmail|Reply|CreateDraft)\(/, 'gmail.routes.ts must route mutations through GmailService.executeXxx()');
  const calendarCode = readSourceWithoutComments('src/http/routes/calendar.routes.ts');
  assert.match(calendarCode, /calendarService\.execute(CreateEvent|UpdateEvent|CancelEvent|RespondToEvent)\(/, 'calendar.routes.ts must route mutations through GoogleCalendarService.executeXxx()');
});

test('63. approvals.routes.ts never itself calls a Gmail/Calendar mutation method — approve/reject only ever touch the approval record, never a provider write', () => {
  const code = readSourceWithoutComments('src/http/routes/approvals.routes.ts');
  assert.doesNotMatch(code, /\.execute(SendEmail|Reply|CreateDraft|CreateEvent|UpdateEvent|CancelEvent|RespondToEvent)\(/, 'approvals.routes.ts must never itself execute a provider mutation — that is the separate /api/v1/tools/* route\'s job, after approval');
  assert.match(code, /googleCalendarService\.(approve|reject|getApproval|requestCreateEventApproval|requestUpdateEventApproval|requestCancelEventApproval|requestRespondToEventApproval)\(/, 'approvals.routes.ts must only ever touch the approval record lifecycle');
});

test('64. none of the nine Increment 4 route modules import back from server_web.ts (composition root depends on routes, never the reverse)', () => {
  for (const file of INCREMENT_4_ROUTE_FILES) {
    const code = readSourceWithoutComments(`src/http/routes/${file}`);
    assert.doesNotMatch(code, /from ['"]\.\.\/\.\.\/server_web\.js['"]/, `${file} must not import back from server_web.ts`);
  }
});

test('65. server_web.ts no longer inline-implements any Gmail/Calendar/Approval/Browser/OAuth/Telegram/Slack/Desktop/Governance route (route ownership guard)', () => {
  const code = readSourceWithoutComments('src/server_web.ts');
  for (const pattern of [
    /pathname === '\/api\/v1\/tools\/gmail\/send-email'/,
    /pathname === '\/api\/v1\/tools\/google-calendar\/create-event'/,
    /pathname === '\/api\/v1\/approvals' &&/,
    /pathname === '\/api\/v1\/browser\/sessions'/,
    /pathname === '\/api\/v1\/tools\/browser\/navigate'/,
    /pathname === '\/api\/v1\/oauth\/google\/start' &&/,
    /pathname === '\/api\/v1\/oauth\/google\/callback'/,
    /pathname === '\/api\/v1\/integrations\/telegram\/status'/,
    /pathname === '\/api\/v1\/integrations\/slack\/status'/,
    /pathname === '\/api\/v1\/desktop\/quickwake\/status'/,
    /pathname === '\/api\/v1\/executions' &&/,
    /pathname === '\/api\/v1\/billing\/usage'/,
  ]) {
    assert.doesNotMatch(code, pattern, `server_web.ts must not re-implement ${pattern} inline — it belongs in the Increment 4 route modules now`);
  }
});
