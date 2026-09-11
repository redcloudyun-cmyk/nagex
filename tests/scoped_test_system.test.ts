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

// ─── 11: npm test command remains full wildcard suite ──────────────────

test('11. package.json\'s "test" script remains the untouched full-wildcard suite with the canonical preload', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.test, 'tsc && node --require ./dist/tests/_setup.js --test dist/tests/*.test.js');
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
// disposable source file that intentionally has no compiled counterpart ──

test('the runner exits non-zero when a mapped source test file exists but was never compiled to dist/tests', () => {
  const fixtureName = `_scoped_fixture_missing_compiled_${Date.now()}`;
  const fixtureSourcePath = path.join(ROOT, 'tests', `${fixtureName}.test.ts`);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-scoped-fixture-'));
  const tmpRegistryPath = path.join(tmpDir, 'missing-compiled.registry.json');
  try {
    // A real, valid, throwaway test file — deliberately never compiled
    // (the guard is checked with --no-build so dist/tests/<fixtureName>.test.js
    // can never come to exist during this test).
    fs.writeFileSync(fixtureSourcePath, "import { test } from 'node:test';\ntest('fixture', () => {});\n");
    fs.writeFileSync(tmpRegistryPath, JSON.stringify({ scopes: { missingCompiled: [fixtureName] }, fullOnly: [] }));
    const result = spawnSync(process.execPath, [RUNNER_PATH, 'missingCompiled', '--no-build'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, NAGEX_TEST_SCOPE_REGISTRY: tmpRegistryPath },
    });
    assert.notEqual(result.status, 0, 'a mapped test with no compiled output must fail, never silently skip');
    assert.match(result.stderr, /missing after build/i);
    assert.match(result.stderr, new RegExp(fixtureName));
  } finally {
    fs.rmSync(fixtureSourcePath, { force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
