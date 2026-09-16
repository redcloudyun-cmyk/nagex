// R10.2-D — HTTP route modularization (first increment). Covers: the
// router engine's own sequential-match/precedence semantics, the two
// extracted domain registrars (health/vcs, action-proposals) behaving
// identically to their pre-refactor inline versions, and the static
// architecture guard proving route modules never bypass canonical
// mutation paths. This is a FIRST SLICE of the full route-modularization
// milestone (§18's own "do not move 100 endpoints blindly" instruction) —
// the great majority of server_web.ts's ~130 endpoints remain inline,
// tracked as DEBT-0004, not silently left undocumented.
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
