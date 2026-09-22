#!/usr/bin/env node
// NAgex R22.S — Contract-Aware Test Gate Architecture.
//
// The historical `npm test` wildcard (`dist/tests/*.test.js`) mixed
// deterministic canonical regression, canonical architecture/security
// tests, implementation-coupled legacy tests, superseded contracts, local
// browser certification, deployed-server certification, and live
// external-provider tests into one undifferentiated pass/fail signal. This
// runner replaces that with five separate, honest gates, each selected
// purely from tests/test-contract.registry.json's classification metadata
// — never a hand-maintained file list — so a new test can never silently
// join the wrong gate just because nobody updated a list here.
//
// Usage:
//   node scripts/nagex-test-gate.mjs --list
//   node scripts/nagex-test-gate.mjs <gate> [--dry-run] [--no-build]
//
// Gates: regression, browser, deployed, live, legacy (see GATES below for
// the exact selection rule and intent of each).
//
// `--no-build` is a developer-convenience shortcut for rapid iteration when
// dist/ is already known to be current — never use it as part of a release
// gate; the standard path always rebuilds first so dist/ can never silently
// drift from committed TypeScript.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TESTS_DIR = path.join(ROOT, 'tests');
const REGISTRY_PATH = path.join(TESTS_DIR, 'test-contract.registry.json');
const SETUP_PATH = path.join(ROOT, 'dist', 'tests', '_setup.js');
const TSC_PATH = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

const CANONICAL_NON_BROWSER = new Set(['CANONICAL_BEHAVIOR', 'CANONICAL_ARCHITECTURE', 'TEST_HARNESS']);
const LEGACY_CLASSIFICATIONS = new Set(['IMPLEMENTATION_COUPLED', 'SUPERSEDED_CONTRACT']);

// Each gate's `select` runs against a registry entry (plus its own `name`)
// and returns true/false. Selection is the ONLY thing that differs between
// gates — build, spawn, and reporting are identical for all of them.
const GATES = {
  regression: {
    description: 'Deterministic canonical regression: CANONICAL_BEHAVIOR / CANONICAL_ARCHITECTURE / TEST_HARNESS, canonical=true, non-browser. This is the R22 release/closure gate.',
    requiresEnv: [],
    nonBlocking: false,
    select: (entry) => CANONICAL_NON_BROWSER.has(entry.classification)
      && entry.canonical === true
      && entry.deterministic === true
      && entry.realBrowser !== true,
  },
  browser: {
    description: 'Deterministic local REAL_BROWSER_CERT only: canonical=true, deterministic=true, no external dependencies, and no repository artifact writes (writesRepositoryArtifacts=false). Never requires a deployed URL, a real external API, or user credentials.',
    requiresEnv: [],
    nonBlocking: false,
    select: (entry) => entry.classification === 'REAL_BROWSER_CERT'
      && entry.canonical === true
      && entry.deterministic === true
      && entry.realBrowser === true
      && entry.writesRepositoryArtifacts === false
      && Array.isArray(entry.externalDependencies) && entry.externalDependencies.length === 0,
  },
  deployed: {
    description: 'Explicit deployed certification only (DEPLOYED_CERT). Requires a real deployed NAgex URL. Never runs implicitly as part of regression.',
    requiresEnv: ['NAGEX_DEPLOYED_URL'],
    nonBlocking: false,
    select: (entry) => entry.classification === 'DEPLOYED_CERT',
  },
  live: {
    description: 'LIVE_EXTERNAL only: real provider/API, OAuth/live Google, live search, or cloud integration requiring a real environment and real credentials.',
    requiresEnv: [],
    nonBlocking: false,
    select: (entry) => entry.classification === 'LIVE_EXTERNAL',
  },
  legacy: {
    description: 'IMPLEMENTATION_COUPLED + SUPERSEDED_CONTRACT. Informational and non-blocking for the R22 stable baseline — never the release gate.',
    requiresEnv: [],
    nonBlocking: true,
    select: (entry) => LEGACY_CLASSIFICATIONS.has(entry.classification),
  },
};

function loadRegistry() {
  const raw = fs.readFileSync(REGISTRY_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed.tests !== 'object') {
    process.stderr.write('NAgex Test Gate: tests/test-contract.registry.json is malformed (missing "tests" object).\n');
    process.exit(1);
  }
  return parsed;
}

function realTestBaseNames() {
  return fs.readdirSync(TESTS_DIR)
    .filter((f) => f.endsWith('.test.ts'))
    .map((f) => f.replace(/\.test\.ts$/, ''))
    .sort();
}

// Fail closed: every real tests/*.test.ts file MUST have a registry entry.
// A new test file added without a registry entry must never silently fall
// out of every gate (and, just as dangerous, never silently fall INTO the
// wrong one by accident) — it blocks all gates until classified.
function assertRegistryComplete(registry) {
  const real = realTestBaseNames();
  const missing = real.filter((name) => !registry.tests[name]);
  if (missing.length > 0) {
    process.stderr.write('NAgex Test Gate: the following test file(s) have no tests/test-contract.registry.json entry:\n');
    for (const name of missing) process.stderr.write(`  tests/${name}.test.ts\n`);
    process.stderr.write('Classify each test (see tests/test_contract_registry.test.ts for the required schema) before any gate can run.\n');
    process.exit(1);
  }
  const stale = Object.keys(registry.tests).filter((name) => !real.includes(name));
  if (stale.length > 0) {
    process.stderr.write('NAgex Test Gate: the following registry entries have no corresponding test file (stale):\n');
    for (const name of stale) process.stderr.write(`  ${name}\n`);
    process.exit(1);
  }
}

function compiledTestPath(baseName) {
  return path.join(ROOT, 'dist', 'tests', `${baseName}.test.js`);
}

function sourceTestPath(baseName) {
  return path.join(TESTS_DIR, `${baseName}.test.ts`);
}

function printUsageAndGates() {
  process.stderr.write('Usage: node scripts/nagex-test-gate.mjs <gate|--list> [--dry-run] [--no-build]\n');
  process.stderr.write(`Valid gates: ${Object.keys(GATES).sort().join(', ')}\n`);
}

function runBuild() {
  const result = spawnSync(process.execPath, [TSC_PATH], { cwd: ROOT, stdio: 'inherit' });
  if (result.status !== 0) {
    process.stderr.write('NAgex Test Gate: build failed — see tsc output above.\n');
    process.exit(result.status ?? 1);
  }
}

function main() {
  const args = process.argv.slice(2);
  const registry = loadRegistry();

  if (args.includes('--list') || args.length === 0) {
    assertRegistryComplete(registry);
    const entries = registry.tests;
    process.stdout.write('NAgex Test Gate — available gates:\n');
    for (const gateName of Object.keys(GATES).sort()) {
      const gate = GATES[gateName];
      const count = Object.entries(entries).filter(([, entry]) => gate.select(entry)).length;
      process.stdout.write(`  ${gateName} (${count} tests)${gate.nonBlocking ? ' — informational, non-blocking' : ''}\n`);
      process.stdout.write(`    ${gate.description}\n`);
    }
    process.exit(args.length === 0 ? 1 : 0);
  }

  const gateName = args[0];
  const dryRun = args.includes('--dry-run');
  const noBuild = args.includes('--no-build');

  const gate = GATES[gateName];
  if (!gate) {
    process.stderr.write(`NAgex Test Gate: unknown gate "${gateName}".\n`);
    printUsageAndGates();
    process.exit(1);
  }

  assertRegistryComplete(registry);

  const missingEnv = gate.requiresEnv.filter((name) => !process.env[name]);
  if (missingEnv.length > 0) {
    process.stderr.write(`NAgex Test Gate: gate "${gateName}" requires the following environment variable(s), which are not set:\n`);
    for (const name of missingEnv) process.stderr.write(`  ${name}\n`);
    process.stderr.write('This gate never runs implicitly — set the required environment explicitly to run it.\n');
    process.exit(1);
  }

  const selected = Object.entries(registry.tests)
    .filter(([, entry]) => gate.select(entry))
    .map(([name, entry]) => ({ name, classification: entry.classification }))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (selected.length === 0) {
    process.stderr.write(`NAgex Test Gate: gate "${gateName}" resolved to zero tests — this is a registry bug, failing closed rather than silently passing.\n`);
    process.exit(1);
  }

  // Fail closed if a registry entry's source file doesn't even exist — a
  // typo'd/renamed base name must never silently shrink a gate.
  const missingSource = selected.filter(({ name }) => !fs.existsSync(sourceTestPath(name)));
  if (missingSource.length > 0) {
    process.stderr.write('NAgex Test Gate: registry references source test file(s) that do not exist:\n');
    for (const { name } of missingSource) process.stderr.write(`  tests/${name}.test.ts\n`);
    process.exit(1);
  }

  if (!noBuild) {
    runBuild();
  }

  const missingCompiled = selected.filter(({ name }) => !fs.existsSync(compiledTestPath(name)));
  if (missingCompiled.length > 0) {
    process.stderr.write('NAgex Test Gate: compiled test file(s) missing after build — a rename/typo left this gate incomplete:\n');
    for (const { name } of missingCompiled) process.stderr.write(`  dist/tests/${name}.test.js (from tests/${name}.test.ts)\n`);
    process.exit(1);
  }

  const testFiles = selected.map(({ name }) => compiledTestPath(name));
  const classificationCounts = {};
  for (const { classification } of selected) classificationCounts[classification] = (classificationCounts[classification] ?? 0) + 1;

  process.stdout.write('NAgex Test Gate\n');
  process.stdout.write(`Gate: ${gateName}${gate.nonBlocking ? ' (informational, non-blocking)' : ''}\n`);
  process.stdout.write(`${gate.description}\n`);
  process.stdout.write(`Classification: ${Object.entries(classificationCounts).map(([c, n]) => `${c}=${n}`).join(', ')}\n`);
  process.stdout.write(`Build: ${noBuild ? 'skipped (--no-build)' : 'yes'}\n`);
  process.stdout.write(`Setup: ${path.relative(ROOT, SETUP_PATH).replace(/\\/g, '/')}\n`);
  process.stdout.write(`Selected tests (${selected.length}):\n`);
  for (const { name, classification } of selected) process.stdout.write(`  ${name} [${classification}]\n`);

  if (dryRun) {
    process.stdout.write('Dry run — no tests executed.\n');
    process.stdout.write('Exit code: 0\n');
    process.exit(0);
  }

  const result = spawnSync(
    process.execPath,
    ['--require', SETUP_PATH, '--test', ...testFiles],
    { cwd: ROOT, stdio: 'inherit' },
  );

  if (result.signal) {
    process.stderr.write(`NAgex Test Gate: child process terminated by signal ${result.signal}\n`);
    process.stdout.write('Exit code: 1\n');
    process.exit(1);
  }

  const exitCode = result.status ?? 1;
  process.stdout.write(`Exit code: ${exitCode}\n`);
  if (gate.nonBlocking && exitCode !== 0) {
    process.stdout.write(`NAgex Test Gate: gate "${gateName}" is informational/non-blocking for the R22 stable baseline — failures here do not represent a regression, but they are not hidden either (see exit code above).\n`);
  }
  process.exit(exitCode);
}

main();
