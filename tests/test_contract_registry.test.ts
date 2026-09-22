import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const testsDir = path.resolve('tests');
const registryPath = path.join(testsDir, 'test-contract.registry.json');
const allowedClassifications = new Set([
  'CANONICAL_BEHAVIOR',
  'CANONICAL_ARCHITECTURE',
  'IMPLEMENTATION_COUPLED',
  'REAL_BROWSER_CERT',
  'TEST_HARNESS',
  'LIVE_EXTERNAL',
  'DEPLOYED_CERT',
  'SUPERSEDED_CONTRACT',
]);

type RegistryEntry = {
  milestone?: unknown;
  classification?: unknown;
  canonical?: unknown;
  scopes?: unknown;
  supersededBy?: unknown;
  externalDependencies?: unknown;
  realBrowser?: unknown;
  writesRepositoryArtifacts?: unknown;
  requiresEnv?: unknown;
};

function testBasenames(): string[] {
  return fs.readdirSync(testsDir)
    .filter((name) => name.endsWith('.test.ts'))
    .map((name) => name.slice(0, -'.test.ts'.length))
    .sort();
}

test('test-contract registry classifies every real test exactly once with valid required metadata', () => {
  const parsed = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as { tests?: Record<string, RegistryEntry> };
  assert.ok(parsed.tests && typeof parsed.tests === 'object');

  const files = testBasenames();
  const entries = Object.keys(parsed.tests!).sort();
  assert.deepEqual(entries, files, 'every tests/*.test.ts file must have exactly one registry entry and no stale entry');

  for (const [name, entry] of Object.entries(parsed.tests!)) {
    assert.equal(typeof entry.milestone, 'string', `${name}: milestone is required`);
    assert.ok(allowedClassifications.has(String(entry.classification)), `${name}: invalid classification`);
    assert.equal(typeof entry.canonical, 'boolean', `${name}: canonical boolean is required`);
    assert.ok(Array.isArray(entry.scopes) && entry.scopes.length > 0, `${name}: non-empty scopes are required`);

    if (entry.classification === 'SUPERSEDED_CONTRACT') {
      assert.equal(typeof entry.supersededBy, 'string', `${name}: supersededBy is required`);
      assert.ok(String(entry.supersededBy).length > 0, `${name}: supersededBy cannot be blank`);
    }
    if (entry.classification === 'LIVE_EXTERNAL') {
      assert.ok(Array.isArray(entry.externalDependencies) && entry.externalDependencies.length > 0, `${name}: live external dependencies must be explicit`);
    }
    if (entry.classification === 'DEPLOYED_CERT') {
      // Deployed certification is a distinct classification from LIVE_EXTERNAL
      // specifically so the "deployed" gate can select it by classification
      // alone (see scripts/nagex-test-gate.mjs) without also being pulled
      // into the "live" gate — it still declares its external dependencies
      // and required env the same way LIVE_EXTERNAL does.
      assert.ok(Array.isArray(entry.externalDependencies) && entry.externalDependencies.length > 0, `${name}: deployed certification dependencies must be explicit`);
      assert.ok(Array.isArray(entry.requiresEnv) && entry.requiresEnv.length > 0, `${name}: deployed certification must declare its required env var(s)`);
    }
    if (entry.classification === 'REAL_BROWSER_CERT') {
      assert.equal(entry.realBrowser, true, `${name}: real browser certification must declare realBrowser=true`);
      // R22.S — the browser gate must be able to tell, from the registry
      // alone, which REAL_BROWSER_CERT tests still write to the repository
      // (artifacts/) so it can exclude them pending remediation instead of
      // silently modifying artifacts when the gate runs.
      assert.equal(typeof entry.writesRepositoryArtifacts, 'boolean', `${name}: real browser certification must declare writesRepositoryArtifacts`);
    }
  }
});
