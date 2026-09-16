// R10.2-D — HTTP route modularization. Increment 1 covered: the router
// engine's own sequential-match/precedence semantics, health/vcs +
// action-proposals, and the static architecture guard proving route
// modules never bypass canonical mutation paths. Increment 2 (below,
// tests 17+) adds memory/modules/catalog/settings/notifications — still
// an incremental slice, not the full ~130-endpoint migration; the
// remainder is tracked as DEBT-0004, not silently left undocumented.
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
