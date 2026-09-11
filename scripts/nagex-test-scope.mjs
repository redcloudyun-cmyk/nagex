#!/usr/bin/env node
// Phase 08 — Scoped Test System.
//
// A fast, correct subset of `npm test` for iterating on one subsystem at a
// time, without ever risking the "targeted test missed the _setup preload"
// false-signal that Phase 05 actually hit. Every scope resolves through the
// exact same steps `npm test` uses: build, then
// `node --require dist/tests/_setup.js --test <files>` — the only thing
// that changes is which files are passed.
//
// Usage:
//   node scripts/nagex-test-scope.mjs --list
//   node scripts/nagex-test-scope.mjs <scope> [--dry-run] [--no-build]
//
// `--no-build` is a developer-convenience shortcut for rapid iteration when
// dist/ is already known to be current — never use it as part of a freeze
// gate; the standard path always rebuilds first so dist/ can never silently
// drift from committed TypeScript.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
// Test-support override only (see tests/scoped_test_system.test.ts) — lets
// the self-test suite exercise the real empty-scope/missing-compiled-file
// guards against a disposable temp registry instead of mutating the real
// one. Never set outside a test run; production and every documented
// command always use the real registry.
const REGISTRY_PATH = process.env.NAGEX_TEST_SCOPE_REGISTRY
  ? path.resolve(process.env.NAGEX_TEST_SCOPE_REGISTRY)
  : path.join(ROOT, 'tests', 'test-scope.registry.json');
const SETUP_PATH = path.join(ROOT, 'dist', 'tests', '_setup.js');
const TSC_PATH = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

function loadRegistry() {
  const raw = fs.readFileSync(REGISTRY_PATH, 'utf8');
  return JSON.parse(raw);
}

function resolveScopeNames(registry) {
  return Object.keys(registry.scopes).sort();
}

// Resolves a scope name to its distinct, sorted list of test base names
// (e.g. "conditional_watch"), or null if the scope is unknown.
function resolveScope(registry, scope) {
  const names = registry.scopes[scope];
  if (!names) return null;
  return [...new Set(names)].sort();
}

function compiledTestPath(baseName) {
  return path.join(ROOT, 'dist', 'tests', `${baseName}.test.js`);
}

function sourceTestPath(baseName) {
  return path.join(ROOT, 'tests', `${baseName}.test.ts`);
}

function printUsageAndScopes(registry) {
  process.stderr.write('Usage: node scripts/nagex-test-scope.mjs <scope|--list> [--dry-run] [--no-build]\n');
  process.stderr.write(`Valid scopes: ${resolveScopeNames(registry).join(', ')}\n`);
}

function runBuild() {
  const result = spawnSync(process.execPath, [TSC_PATH], { cwd: ROOT, stdio: 'inherit' });
  if (result.status !== 0) {
    process.stderr.write('NAgex Scoped Test: build failed — see tsc output above.\n');
    process.exit(result.status ?? 1);
  }
}

function main() {
  const args = process.argv.slice(2);
  const registry = loadRegistry();

  if (args.includes('--list') || args.length === 0) {
    process.stdout.write('NAgex Scoped Test — available scopes:\n');
    for (const name of resolveScopeNames(registry)) {
      process.stdout.write(`  ${name} (${resolveScope(registry, name).length} tests)\n`);
    }
    process.stdout.write(`  full-only (${registry.fullOnly.length} tests — included in "npm test" only, no dedicated scope)\n`);
    process.exit(args.length === 0 ? 1 : 0);
  }

  const scope = args[0];
  const dryRun = args.includes('--dry-run');
  const noBuild = args.includes('--no-build');

  const baseNames = resolveScope(registry, scope);
  if (!baseNames) {
    process.stderr.write(`NAgex Scoped Test: unknown scope "${scope}".\n`);
    printUsageAndScopes(registry);
    process.exit(1);
  }

  if (baseNames.length === 0) {
    process.stderr.write(`NAgex Scoped Test: scope "${scope}" resolved to zero tests — this is a registry bug, failing closed rather than silently passing.\n`);
    process.exit(1);
  }

  // Fail closed if a registry entry's source file doesn't even exist — a
  // typo'd base name must never silently shrink a scope.
  const missingSource = baseNames.filter((name) => !fs.existsSync(sourceTestPath(name)));
  if (missingSource.length > 0) {
    process.stderr.write(`NAgex Scoped Test: registry references source test file(s) that do not exist:\n`);
    for (const name of missingSource) process.stderr.write(`  tests/${name}.test.ts\n`);
    process.exit(1);
  }

  if (!noBuild) {
    runBuild();
  }

  const missingCompiled = baseNames.filter((name) => !fs.existsSync(compiledTestPath(name)));
  if (missingCompiled.length > 0) {
    process.stderr.write(`NAgex Scoped Test: compiled test file(s) missing after build — a rename/typo left this scope incomplete:\n`);
    for (const name of missingCompiled) process.stderr.write(`  dist/tests/${name}.test.js (from tests/${name}.test.ts)\n`);
    process.exit(1);
  }

  const testFiles = baseNames.map(compiledTestPath);

  process.stdout.write('NAgex Scoped Test\n');
  process.stdout.write(`Scope: ${scope}\n`);
  process.stdout.write(`Tests: ${testFiles.length}\n`);
  process.stdout.write(`Build: ${noBuild ? 'skipped (--no-build)' : 'yes'}\n`);
  process.stdout.write(`Setup: ${path.relative(ROOT, SETUP_PATH).replace(/\\/g, '/')}\n`);

  if (dryRun) {
    process.stdout.write('Dry run — resolved test files:\n');
    for (const f of testFiles) process.stdout.write(`  ${path.relative(ROOT, f).replace(/\\/g, '/')}\n`);
    process.exit(0);
  }

  const result = spawnSync(
    process.execPath,
    ['--require', SETUP_PATH, '--test', ...testFiles],
    { cwd: ROOT, stdio: 'inherit' },
  );

  if (result.signal) {
    process.stderr.write(`NAgex Scoped Test: child process terminated by signal ${result.signal}\n`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

main();
