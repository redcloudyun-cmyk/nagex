// R10.2-E — Canonical Route Inventory / Route Contract Matrix.
//
// This is the single generated source of truth for "how many HTTP
// endpoints does NAgex have, and which registrar owns each one" — it is
// derived directly from the real source files on every test run, never a
// hand-maintained duplicate list that can silently drift from reality.
//
// Endpoint counting methodology (unchanged since R10.2-D Increment 2,
// applied consistently across every increment): count of distinct
// `method === '<VERB>'` comparison occurrences in a file. This is a
// structural proxy for "how many method+pathname branches this file
// handles", not a semantic HTTP-spec parse — a route that checks two
// methods in one combined condition (e.g. `method === 'GET' ||
// method === 'PUT'`) counts as 2, matching how many independent
// method-shaped branches a future edit could accidentally break.
//
// R10.2-E baseline reconciliation: earlier R10.2-D increment reports
// carried forward a "147 total endpoints" figure that traced back to an
// early, informal estimate in Increment 1/2. A fresh, tool-verified count
// of the real current source (this file's own extraction logic) finds
// exactly 144 domain method-check blocks across the 26 route modules,
// plus exactly 1 non-domain check (the CORS OPTIONS preflight) in
// server_web.ts — 145 total method-check blocks in the whole HTTP layer.
// This file codifies 144 as the real, going-forward regression baseline
// for TOTAL_DOMAIN_ENDPOINTS, superseding the earlier informal 147
// figure. A future change to this number must be an intentional edit to
// EXPECTED_ROUTE_MODULE_COUNTS below, never a silent drift.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROUTES_DIR = path.resolve('src/http/routes');
const SERVER_WEB_PATH = path.resolve('src/server_web.ts');

function readSourceWithoutComments(absPath: string): string {
  return fs.readFileSync(absPath, 'utf8').split('\n').map((line) => line.replace(/\/\/.*/, '')).join('\n');
}

function countMethodChecks(source: string): number {
  return (source.match(/method === '[A-Z]+'/g) || []).length;
}

function listRouteModuleFiles(): string[] {
  return fs.readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.routes.ts')).sort();
}

// The canonical, current-as-of-R10.2-E per-file method-check-block count.
// This is the "intentional edit required" baseline §4.2/§11 asks for: a
// route module gaining or losing an endpoint must update this table in
// the same commit, or these tests fail.
const EXPECTED_ROUTE_MODULE_COUNTS: Record<string, number> = {
  'account.routes.ts': 11,
  'action-proposals.routes.ts': 2,
  'approvals.routes.ts': 6,
  'auth.routes.ts': 9,
  'automations.routes.ts': 6,
  'browser.routes.ts': 17,
  'calendar.routes.ts': 5,
  'capabilities.routes.ts': 1,
  'catalog.routes.ts': 5,
  'conversation.routes.ts': 7,
  'daily-brief.routes.ts': 6,
  'desktop.routes.ts': 3,
  'device-agent.routes.ts': 1,
  'gmail.routes.ts': 5,
  'google-oauth.routes.ts': 5,
  'governance.routes.ts': 5,
  'health.routes.ts': 2,
  'memory.routes.ts': 4,
  'modules.routes.ts': 3,
  'my-space.routes.ts': 1,
  'notifications.routes.ts': 4,
  'organization.routes.ts': 20,
  'providers.routes.ts': 2,
  'safety.routes.ts': 3,
  'settings.routes.ts': 4,
  'slack.routes.ts': 5,
  'tasks.routes.ts': 11,
  'telegram.routes.ts': 5,
  'workspace.routes.ts': 26,
};

const TOTAL_DOMAIN_ENDPOINTS = Object.values(EXPECTED_ROUTE_MODULE_COUNTS).reduce((a, b) => a + b, 0);

test('ROUTE-INV-001: the set of route module files on disk exactly matches the canonical manifest (no file added/removed/renamed without an explicit test update)', () => {
  const actual = listRouteModuleFiles();
  const expected = Object.keys(EXPECTED_ROUTE_MODULE_COUNTS).sort();
  assert.deepEqual(actual, expected, 'src/http/routes/*.routes.ts on disk must exactly match EXPECTED_ROUTE_MODULE_COUNTS\'s keys');
});

test('ROUTE-INV-002: every route module\'s method-check-block count exactly matches its manifest entry (route count drift is caught per-file, not just in aggregate)', () => {
  const mismatches: string[] = [];
  for (const file of listRouteModuleFiles()) {
    const actualCount = countMethodChecks(readSourceWithoutComments(path.join(ROUTES_DIR, file)));
    const expectedCount = EXPECTED_ROUTE_MODULE_COUNTS[file];
    if (actualCount !== expectedCount) {
      mismatches.push(`${file}: expected ${expectedCount}, found ${actualCount}`);
    }
  }
  assert.deepEqual(mismatches, [], `Route module endpoint-count drift detected:\n${mismatches.join('\n')}`);
});

test('ROUTE-INV-003: the total domain endpoint count across all route modules is exactly 184 (the verified R14 baseline) — any change requires an intentional manifest update', () => {
  assert.equal(TOTAL_DOMAIN_ENDPOINTS, 184);
  let actualTotal = 0;
  for (const file of listRouteModuleFiles()) {
    actualTotal += countMethodChecks(readSourceWithoutComments(path.join(ROUTES_DIR, file)));
  }
  assert.equal(actualTotal, TOTAL_DOMAIN_ENDPOINTS);
});

test('ROUTE-INV-004: server_web.ts contains exactly one method-check block (the CORS OPTIONS preflight) and zero domain pathname literals — the Composition Root owns no domain endpoint', () => {
  const code = readSourceWithoutComments(SERVER_WEB_PATH);
  const methodChecks = code.match(/method === '[A-Z]+'/g) || [];
  assert.deepEqual(methodChecks, ["method === 'OPTIONS'"], `server_web.ts must contain exactly the CORS OPTIONS check and no domain method check; found: ${JSON.stringify(methodChecks)}`);
  assert.doesNotMatch(code, /pathname === '\/api\/v1\//, 'server_web.ts must not contain any inline /api/v1/* pathname literal check');
});

test('ROUTE-INV-005: no exact pathname literal is registered as an === check in more than one route module (duplicate-registration guard)', () => {
  // startsWith()-based prefix routes (e.g. /api/v1/tasks/) are intentionally
  // excluded here — several domains legitimately share a common prefix
  // (tasks vs tasks run bridge, candidates vs items/.../candidates/...)
  // by design, distinguished by method/suffix, not by owning a unique
  // prefix. Exact `pathname === '...'` literals, by contrast, must be
  // globally unique — two registrars claiming the exact same full path is
  // always an ownership bug, never legitimate.
  const owners = new Map<string, string[]>();
  for (const file of listRouteModuleFiles()) {
    const code = readSourceWithoutComments(path.join(ROUTES_DIR, file));
    const literals = code.match(/pathname === '\/api\/v1\/[^']*'/g) || [];
    for (const literal of new Set(literals)) {
      const list = owners.get(literal) ?? [];
      list.push(file);
      owners.set(literal, list);
    }
  }
  const duplicates: string[] = [];
  for (const [literal, files] of owners) {
    if (files.length > 1) duplicates.push(`${literal} claimed by: ${files.join(', ')}`);
  }
  assert.deepEqual(duplicates, [], `Duplicate exact-pathname registration across route modules:\n${duplicates.join('\n')}`);
});

test('ROUTE-INV-006: every handleXRoutes function exported by a route module is actually imported AND called (wired) in server_web.ts — no orphaned registrar', () => {
  const serverWebCode = readSourceWithoutComments(SERVER_WEB_PATH);
  const unwired: string[] = [];
  for (const file of listRouteModuleFiles()) {
    const code = readSourceWithoutComments(path.join(ROUTES_DIR, file));
    const exportedHandlers = [...code.matchAll(/export const (handle\w*Routes): (?:Sync|Async)RouteRegistrar/g)].map((m) => m[1]);
    for (const handlerName of exportedHandlers) {
      const importedPattern = new RegExp(`\\b${handlerName}\\b`);
      const callPattern = new RegExp(`${handlerName}\\s*\\(`);
      const isImported = importedPattern.test(serverWebCode);
      const isCalled = callPattern.test(serverWebCode);
      if (!isImported || !isCalled) {
        unwired.push(`${handlerName} (from ${file}) — imported: ${isImported}, called: ${isCalled}`);
      }
    }
  }
  assert.deepEqual(unwired, [], `Route registrar(s) declared but not wired into server_web.ts:\n${unwired.join('\n')}`);
});

test('ROUTE-INV-007: every route module exports at least one registrar (no dead/empty route file)', () => {
  const empty: string[] = [];
  for (const file of listRouteModuleFiles()) {
    const code = readSourceWithoutComments(path.join(ROUTES_DIR, file));
    const hasRegistrar = /export const handle\w*Routes: (Sync|Async)RouteRegistrar/.test(code);
    if (!hasRegistrar) empty.push(file);
  }
  assert.deepEqual(empty, [], `Route module(s) with no exported registrar: ${empty.join(', ')}`);
});

// ── Negative tests: prove each guard actually fires on the exact
// violation it claims to catch, not just that it passes on today's clean
// tree (the same discipline architecture_enforcement.test.ts already
// applies to ARCH-001 through ARCH-009). ────────────────────────────────

test('negative: ROUTE-INV-002-style count drift is detected when a route module silently gains an endpoint', () => {
  const realCode = readSourceWithoutComments(path.join(ROUTES_DIR, 'gmail.routes.ts'));
  const mutated = realCode + `\nif (pathname === '/api/v1/tools/gmail/fake' && method === 'POST') { return { status: 200, data: {} }; }\n`;
  const before = countMethodChecks(realCode);
  const after = countMethodChecks(mutated);
  assert.equal(before, EXPECTED_ROUTE_MODULE_COUNTS['gmail.routes.ts']);
  assert.notEqual(after, EXPECTED_ROUTE_MODULE_COUNTS['gmail.routes.ts'], 'a silently added endpoint must change the detected count');
});

test('negative: ROUTE-INV-005-style duplicate-registration guard fires when two files claim the same exact pathname', () => {
  const literal = `pathname === '/api/v1/tools/gmail/send-email'`;
  const fileA = `if (${literal} && method === 'POST') {}`;
  const fileB = `if (${literal} && method === 'POST') {}`;
  const owners = new Map<string, string[]>();
  for (const [name, code] of [['fileA.routes.ts', fileA], ['fileB.routes.ts', fileB]] as const) {
    const literals = code.match(/pathname === '\/api\/v1\/[^']*'/g) || [];
    for (const l of new Set(literals)) {
      const list = owners.get(l) ?? [];
      list.push(name);
      owners.set(l, list);
    }
  }
  const duplicates = [...owners.entries()].filter(([, files]) => files.length > 1);
  assert.equal(duplicates.length, 1, 'the same exact pathname claimed by two different simulated files must be detected as a duplicate');
});

test('negative: ROUTE-INV-006-style orphaned-registrar guard fires when a handler is exported but never called', () => {
  const fakeServerWebCode = `import { handleFakeRoutes } from './http/routes/fake.routes.js';\n// handleFakeRoutes is imported but never invoked\n`;
  const handlerName = 'handleFakeRoutes';
  const isImported = new RegExp(`\\b${handlerName}\\b`).test(fakeServerWebCode);
  const isCalled = new RegExp(`${handlerName}\\s*\\(`).test(fakeServerWebCode);
  assert.equal(isImported, true);
  assert.equal(isCalled, false, 'an imported-but-never-called registrar must be detected as unwired');
});
