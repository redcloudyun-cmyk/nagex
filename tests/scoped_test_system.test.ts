// Phase 08 — Scoped Test System.
//
// Proves the scope registry and the runner behave correctly: every scope
// resolves to at least one real test, every mapped test file actually
// exists on disk, no scope has an internal duplicate, unknown scopes fail,
// npm test remains the untouched full-wildcard suite, and — most
// importantly — every single test file under tests/ is accounted for in
// either a scope or the explicit fullOnly list, computed against the real,
// live directory listing rather than trusted by hand-count. A future test
// added without updating the registry fails this file loudly instead of
// silently missing scoped coverage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(process.cwd());
const REGISTRY_PATH = path.join(ROOT, 'tests', 'test-scope.registry.json');
const RUNNER_PATH = path.join(ROOT, 'scripts', 'nagex-test-scope.mjs');

interface Registry {
  scopes: Record<string, string[]>;
  fullOnly: string[];
}

function loadRegistry(): Registry {
  return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
}

function listRealTestBaseNames(): string[] {
  return fs
    .readdirSync(path.join(ROOT, 'tests'))
    .filter((f) => f.endsWith('.test.ts'))
    .map((f) => f.replace(/\.test\.ts$/, ''));
}

// ─── 1: every scope has at least one test ──────────────────────────────

test('1. every scope in the registry resolves to at least one test', () => {
  const registry = loadRegistry();
  for (const [scope, names] of Object.entries(registry.scopes)) {
    assert.ok(names.length > 0, `scope "${scope}" must map to at least one test`);
  }
});

// ─── 2: every mapped source test file exists ───────────────────────────

test('2. every test base name referenced anywhere in the registry has a real tests/<name>.test.ts file', () => {
  const registry = loadRegistry();
  const allNames = new Set<string>([...Object.values(registry.scopes).flat(), ...registry.fullOnly]);
  const missing: string[] = [];
  for (const name of allNames) {
    if (!fs.existsSync(path.join(ROOT, 'tests', `${name}.test.ts`))) missing.push(name);
  }
  assert.deepEqual(missing, [], `registry references test(s) with no source file: ${missing.join(', ')}`);
});

// ─── 3: no duplicate entry within a scope ──────────────────────────────

test('3. no scope lists the same test twice', () => {
  const registry = loadRegistry();
  for (const [scope, names] of Object.entries(registry.scopes)) {
    const dupes = names.filter((name, i) => names.indexOf(name) !== i);
    assert.deepEqual(dupes, [], `scope "${scope}" lists duplicate entries: ${dupes.join(', ')}`);
  }
  const fullOnlyDupes = registry.fullOnly.filter((name, i) => registry.fullOnly.indexOf(name) !== i);
  assert.deepEqual(fullOnlyDupes, [], `fullOnly lists duplicate entries: ${fullOnlyDupes.join(', ')}`);
});

// ─── 4: unknown scope fails ─────────────────────────────────────────────

test('4. the runner exits non-zero and lists valid scopes for an unknown scope name', () => {
  const result = spawnSync(process.execPath, [RUNNER_PATH, 'definitely-not-a-real-scope', '--no-build'], { cwd: ROOT, encoding: 'utf8' });
  assert.notEqual(result.status, 0, 'an unknown scope must exit non-zero');
  assert.match(result.stderr, /unknown scope/i);
  assert.match(result.stderr, /architecture/, 'the error output must list the valid scopes');
});

// ─── 5: runner always includes _setup preload ──────────────────────────

test('5. the runner script always requires dist/tests/_setup.js before running any scope', () => {
  const code = fs.readFileSync(RUNNER_PATH, 'utf8');
  assert.match(code, /_setup\.js/, 'the runner must reference the canonical _setup.js preload');
  assert.match(code, /--require/, 'the runner must pass --require to node, never a bare --test invocation');
});

// ─── 6-10: specific required coverage per scope ────────────────────────

test('6. architecture scope includes architecture_enforcement', () => {
  const registry = loadRegistry();
  assert.ok(registry.scopes.architecture?.includes('architecture_enforcement'));
});

test('7. browser scope includes the browser module boundary test', () => {
  const registry = loadRegistry();
  assert.ok(registry.scopes.browser?.includes('browser_module_boundary'));
});

test('8. google scope includes the google module boundary test', () => {
  const registry = loadRegistry();
  assert.ok(registry.scopes.google?.includes('google_modules_boundary'));
});

test('9. tasks scope includes the task orchestration boundary test', () => {
  const registry = loadRegistry();
  assert.ok(registry.scopes.tasks?.includes('task_orchestration_boundary'));
});

test('10. runtime scope includes lifecycle/composition coverage', () => {
  const registry = loadRegistry();
  assert.ok(registry.scopes.runtime?.includes('lifecycle_manager'));
  assert.ok(registry.scopes.runtime?.includes('composition_root'));
});

// ─── 11: npm test is the R22.S deterministic regression gate ───────────
//
// R22.S superseded the old contract this test enforced ("npm test remains
// the untouched full-wildcard suite"): the wildcard mixed deterministic
// canonical regression with implementation-coupled legacy tests, superseded
// contracts, local browser certification, deployed-server certification,
// and live external-provider tests into one undifferentiated pass/fail
// signal. `npm test` is now the deterministic `test:regression` gate (see
// scripts/nagex-test-gate.mjs and tests/test-contract.registry.json); the
// historical full wildcard still exists, unhidden, as `npm run
// test:all-legacy`.

test('11. package.json\'s "test" script is the deterministic regression gate, not the historical full wildcard', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.test, 'npm run test:regression');
  assert.equal(pkg.scripts['test:regression'], 'node scripts/nagex-test-gate.mjs regression');
});

test('11b. the historical full-wildcard suite remains available, undisguised, as "test:all-legacy"', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['test:all-legacy'], 'tsc && node --require ./dist/tests/_setup.js --test dist/tests/*.test.js');
});

// ─── 12: scoped runner does not mutate production files ────────────────

test('12. running the runner in --dry-run mode makes no filesystem writes under src/', () => {
  const srcFile = path.join(ROOT, 'src', 'server_web.ts');
  const before = fs.statSync(srcFile).mtimeMs;
  const result = spawnSync(process.execPath, [RUNNER_PATH, 'architecture', '--dry-run', '--no-build'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0);
  const after = fs.statSync(srcFile).mtimeMs;
  assert.equal(before, after, 'a dry-run must never modify any file under src/');
});

// ─── Auto-discovery completeness: every real test file is classified ──

test('every test file under tests/ (except this registry\'s own supporting files) is in a scope or explicitly fullOnly — no silent unclassified test', () => {
  const registry = loadRegistry();
  const classified = new Set<string>([...Object.values(registry.scopes).flat(), ...registry.fullOnly]);
  const real = listRealTestBaseNames();
  const unclassified = real.filter((name) => !classified.has(name));
  assert.deepEqual(unclassified, [], `these real test files are not classified in any scope or fullOnly: ${unclassified.join(', ')} — add them to tests/test-scope.registry.json`);
});

test('every registry entry corresponds to a real, currently-existing test file (no stale/removed entries)', () => {
  const registry = loadRegistry();
  const classified = [...new Set<string>([...Object.values(registry.scopes).flat(), ...registry.fullOnly])];
  const real = new Set(listRealTestBaseNames());
  const stale = classified.filter((name) => !real.has(name));
  assert.deepEqual(stale, [], `these registry entries no longer correspond to a real test file: ${stale.join(', ')}`);
});

// ─── Empty scope guard — genuinely exercised via a disposable temp
// registry (NAGEX_TEST_SCOPE_REGISTRY), never the real shared registry ────

test('the runner exits non-zero and never spawns a test process when a scope resolves to zero tests', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-scoped-fixture-'));
  const tmpRegistryPath = path.join(tmpDir, 'empty.registry.json');
  try {
    fs.writeFileSync(tmpRegistryPath, JSON.stringify({ scopes: { empty: [] }, fullOnly: [] }));
    const result = spawnSync(process.execPath, [RUNNER_PATH, 'empty', '--no-build'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, NAGEX_TEST_SCOPE_REGISTRY: tmpRegistryPath },
    });
    assert.notEqual(result.status, 0, 'a scope that resolves to zero tests must fail, never silently pass');
    assert.match(result.stderr, /zero tests/i);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── Missing compiled test guard — genuinely exercised with a real,
// disposable source file that intentionally has no compiled counterpart.
//
// R23.2H: this fixture previously lived directly under the real tests/
// directory (deleted in a `finally` block). Under parallel `node --test`
// execution across files, test_contract_registry.test.ts's own live
// `tests/*.test.ts` filesystem scan could observe the fixture mid-existence
// — a real, reproducible TEST_HARNESS_DEFECT race, not a product issue
// (confirmed by three consecutive `npm run test:regression` runs before
// this fix: pass/fail/fail, all on the exact same commit). The runner's
// NAGEX_TEST_SCOPE_SOURCE_DIR/NAGEX_TEST_SCOPE_DIST_DIR overrides let this
// test point source/compiled resolution entirely at an isolated temp
// directory instead — the fixture never touches tests/ or dist/tests/ at
// all, removing the root cause rather than serializing the whole gate. ──

test('the runner exits non-zero when a mapped source test file exists but was never compiled to dist/tests', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-scoped-fixture-'));
  const isolatedTestsDir = path.join(tmpDir, 'tests');
  const isolatedDistTestsDir = path.join(tmpDir, 'dist-tests');
  fs.mkdirSync(isolatedTestsDir);
  fs.mkdirSync(isolatedDistTestsDir);
  const fixtureName = '_scoped_fixture_missing_compiled';
  const fixtureSourcePath = path.join(isolatedTestsDir, `${fixtureName}.test.ts`);
  const tmpRegistryPath = path.join(tmpDir, 'missing-compiled.registry.json');
  try {
    // A real, valid, throwaway test file — deliberately never compiled
    // (isolatedDistTestsDir is left empty, and --no-build guarantees it
    // stays empty for the duration of this test).
    fs.writeFileSync(fixtureSourcePath, "import { test } from 'node:test';\ntest('fixture', () => {});\n");
    fs.writeFileSync(tmpRegistryPath, JSON.stringify({ scopes: { missingCompiled: [fixtureName] }, fullOnly: [] }));
    const result = spawnSync(process.execPath, [RUNNER_PATH, 'missingCompiled', '--no-build'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        NAGEX_TEST_SCOPE_REGISTRY: tmpRegistryPath,
        NAGEX_TEST_SCOPE_SOURCE_DIR: isolatedTestsDir,
        NAGEX_TEST_SCOPE_DIST_DIR: isolatedDistTestsDir,
      },
    });
    assert.notEqual(result.status, 0, 'a mapped test with no compiled output must fail, never silently skip');
    assert.match(result.stderr, /missing after build/i);
    assert.match(result.stderr, new RegExp(fixtureName));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── R23.3H regression protection — dist/tests/_setup.js must give every
// spawned test-file child its OWN NAGEX_TEST_DATA_ROOT, never the parent
// CLI process's inherited one (TEST_DATA_ROOT_SHARED_ACROSS_FILES=0).
//
// This exercises the REAL compiled setup script via the REAL
// `node --require dist/tests/_setup.js --test a.js b.js` invocation shape —
// the exact shape scripts/nagex-test-scope.mjs and nagex-test-gate.mjs use,
// and the exact shape that reproduced the original bug (the parent process
// runs _setup.js first and sets NAGEX_TEST_DATA_ROOT_OWNER_PID/
// NAGEX_TEST_DATA_ROOT in its OWN env; every spawned test-file child then
// inherits that env by normal OS process-spawn semantics). Each fixture
// file behaviorally proves its own isolation by actually creating its
// approvals directory and writing a marker file into it (never a
// regex/static assertion), so this test also proves that deleting one
// fixture's entire data root afterward cannot remove the other's already-
// written state. ──

test('R23.3H — two sibling test files spawned from one node --test invocation get distinct, non-inherited data roots (TEST_DATA_ROOT_SHARED_ACROSS_FILES=0)', () => {
  const SETUP_PATH = path.join(ROOT, 'dist', 'tests', '_setup.js');
  assert.ok(fs.existsSync(SETUP_PATH), 'dist/tests/_setup.js must be built before this test runs (npm run build)');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-dataroot-isolation-'));
  const markerAPath = path.join(tmpDir, 'marker-a.json');
  const markerBPath = path.join(tmpDir, 'marker-b.json');
  const fixtureAPath = path.join(tmpDir, 'fixture-a.test.js');
  const fixtureBPath = path.join(tmpDir, 'fixture-b.test.js');

  const fixtureSource = (markerPath: string) => `
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
test('record own data root', () => {
  const dataRoot = process.env.NAGEX_TEST_DATA_ROOT;
  const approvalsDir = process.env.NAGEX_APPROVALS_DIR;
  if (!dataRoot || !approvalsDir) throw new Error('NAGEX_TEST_DATA_ROOT/NAGEX_APPROVALS_DIR must be set by _setup.js');
  fs.mkdirSync(approvalsDir, { recursive: true });
  fs.writeFileSync(path.join(approvalsDir, 'marker.txt'), 'present');
  fs.writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({
    pid: process.pid,
    dataRoot,
    approvalsDir,
    ownerPid: process.env.NAGEX_TEST_DATA_ROOT_OWNER_PID,
  }));
});
`;

  try {
    fs.writeFileSync(fixtureAPath, fixtureSource(markerAPath));
    fs.writeFileSync(fixtureBPath, fixtureSource(markerBPath));

    // This test file is itself normally run inside `node --test`, which sets
    // NODE_TEST_CONTEXT/NODE_TEST_WORKER_ID in its own process.env. Those
    // leak into this spawnSync call by ordinary env inheritance and make
    // Node's own recursive-test-run guard silently skip the nested
    // invocation ("run() is being called recursively... skipping running
    // files") — a harness-nesting artifact unrelated to the dataRoot bug
    // this test exists to guard, so it is stripped here rather than worked
    // around by disabling the guard globally.
    const spawnEnv = { ...process.env };
    delete spawnEnv.NODE_TEST_CONTEXT;
    delete spawnEnv.NODE_TEST_WORKER_ID;

    const result = spawnSync(process.execPath, ['--require', SETUP_PATH, '--test', fixtureAPath, fixtureBPath], {
      cwd: ROOT,
      encoding: 'utf8',
      env: spawnEnv,
    });
    assert.equal(result.status, 0, `both fixture files must pass:\n${result.stdout}\n${result.stderr}`);

    const markerA = JSON.parse(fs.readFileSync(markerAPath, 'utf8'));
    const markerB = JSON.parse(fs.readFileSync(markerBPath, 'utf8'));

    // The structural bug reproduced: two genuinely separate child processes
    // (proven by distinct pids) previously shared ONE inherited dataRoot.
    assert.notEqual(markerA.pid, markerB.pid, 'the two spawned test files must run in distinct OS processes');
    assert.notEqual(markerA.dataRoot, markerB.dataRoot, 'sibling test-file processes must never share one inherited NAGEX_TEST_DATA_ROOT');
    assert.notEqual(markerA.approvalsDir, markerB.approvalsDir);

    // Module-level singleton does not escape the isolation boundary: each
    // child must own its own marker, never the parent's.
    assert.equal(markerA.ownerPid, String(markerA.pid), "fixture A's NAGEX_TEST_DATA_ROOT_OWNER_PID must be its own pid, never an inherited ancestor's");
    assert.equal(markerB.ownerPid, String(markerB.pid), "fixture B's NAGEX_TEST_DATA_ROOT_OWNER_PID must be its own pid, never an inherited ancestor's");

    // Behavioral proof both approvals dirs were genuinely, independently
    // created and populated.
    assert.ok(fs.existsSync(path.join(markerA.approvalsDir, 'marker.txt')));
    assert.ok(fs.existsSync(path.join(markerB.approvalsDir, 'marker.txt')));

    // Cleanup of one data root must never remove the other's state.
    fs.rmSync(markerA.dataRoot, { recursive: true, force: true });
    assert.ok(!fs.existsSync(markerA.approvalsDir), "fixture A's own data root must actually be removable");
    assert.ok(fs.existsSync(path.join(markerB.approvalsDir, 'marker.txt')), "cleaning up fixture A's data root must never remove fixture B's state");
    fs.rmSync(markerB.dataRoot, { recursive: true, force: true });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
