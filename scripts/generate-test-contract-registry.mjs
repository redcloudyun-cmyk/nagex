import fs from 'node:fs';
import path from 'node:path';

const testsDir = path.resolve('tests');
const output = path.join(testsDir, 'test-contract.registry.json');

const architectureTests = new Set([
  'architecture_enforcement', 'browser_module_boundary', 'composition_root',
  'google_modules_boundary', 'http_route_modularization', 'module_contracts',
  'route_inventory', 'task_orchestration_boundary', 'tool_capability_id_alignment',
]);
const harnessTests = new Set(['_setup_canary', 'scoped_test_system', 'test_contract_registry']);
const liveExternal = new Map([
  ['astra_real_provider_acceptance', ['OpenAI API', 'internet', 'Chromium']],
  ['cloud_vault_nebius.integration', ['Nebius S3', 'internet', 'S3 credentials']],
  ['model_provider_live', ['OpenAI, Gemini, or Nebius API', 'internet', 'provider credentials']],
]);
// R22.S — deployed certification is its own classification, not LIVE_EXTERNAL,
// so the "deployed" gate (scripts/nagex-test-gate.mjs) can select it by
// classification alone without also pulling it into the "live" gate.
const deployedCert = new Map([
  ['r21_p1_deployed_certification', { deps: ['deployed NAgex URL', 'internet', 'Chromium'], requiresEnv: ['NAGEX_DEPLOYED_URL'] }],
]);
const superseded = new Map([
  ['r21_p0_1c_clone_mockup', { by: 'R22.1/R22.8', note: 'R21 approved-mockup source snapshot was replaced by R22 mobile-first and Personal Home contracts; retain for historical conversion review.' }],
  ['r21_p0_1c_real_browser', { by: 'R22.1/R22.8', note: 'R21 clone-layout browser certification was replaced by R22 mobile and canonical Personal Home browser certification.' }],
]);
const exactScopes = new Map([
  ['r22_1_mobile_home', ['mobile', 'personal-home', 'browser']],
  ['r22_2_activity_vault', ['mobile', 'capture', 'runtime', 'browser']],
  ['r22_3_personal_context_memory', ['memory-context', 'security', 'model-routing']],
  ['r22_4_evidence_pack_web_search', ['model-routing', 'integrations', 'runtime']],
  ['r22_5_task_aware_model_routing', ['model-routing', 'tasks']],
  ['r22_6_perspective_compare', ['model-routing', 'browser']],
  ['r22_7_forecast_compare', ['model-routing', 'browser']],
  ['r22_8_personal_home', ['personal-home', 'browser']],
  ['r22_9_personal_context_link_capture', ['capture', 'browser', 'memory-context', 'security']],
]);

function milestone(name) {
  const version = name.match(/^r(\d+)(?:_(\d+))?(?:_p(\d+))?/i);
  if (version) return `R${version[1]}${version[2] ? `.${version[2]}` : ''}${version[3] ? `.P${version[3]}` : ''}`;
  const phase = name.match(/^phase(\d+(?:_\d+)*)/i);
  if (phase) return `Phase ${phase[1].replaceAll('_', '/')}`;
  return 'Cross-cutting';
}

function scopesFor(name, content) {
  if (exactScopes.has(name)) return exactScopes.get(name);
  const scopes = new Set();
  const add = (scope, pattern) => { if (pattern.test(name) || pattern.test(content)) scopes.add(scope); };
  add('architecture', /architecture|boundary|composition_root|route_inventory|module_contract|modularization|capability_id_alignment/i);
  add('model-routing', /model_|ai-service|AiService|provider|forecast|perspective/i);
  add('memory-context', /memory|personal_context|context/i);
  add('personal-home', /personal_home|home_|desktop-home|daily_brief|proactive|quickwake/i);
  add('capture', /capture|workspace|inbox|vault|pdf_understanding|text_understanding|url_understanding/i);
  add('browser', /browser|playwright|chromium/i);
  add('approvals', /approval|safety_gate|candidate_action/i);
  add('tasks', /task|automation|workflow|plan_/i);
  add('runtime', /runtime|lifecycle|shutdown|execution|notification|session|conversation/i);
  add('mobile', /mobile|360x|390x|430x/i);
  add('integrations', /google|gmail|calendar|slack|telegram|oauth|s3|nebius|social_auth/i);
  add('identity-access', /identity|organization|rbac|saml|oidc|scim|account/i);
  add('device', /device|desktop|astra|computer/i);
  add('security', /security|isolation|redaction|trust|safety|ownership|secret/i);
  add('ux', /ui|ux|i18n|modal|navigation|frontend|composer|timeline|mockup/i);
  add('test-harness', /_setup|scoped_test|test_contract_registry/i);
  if (scopes.size === 0) scopes.add('runtime');
  return [...scopes].sort();
}

function sourceAssertions(content) {
  return /(readFileSync|readSource|\bread\()[\s\S]{0,500}(src\/|public\/|docs\/|package\.json)|assert\.(?:match|doesNotMatch)\([\s\S]{0,120}(?:Src|source|code|html|appJs|home)/i.test(content);
}

function assertionIntentFor(name, content, classification, launchesBrowser, implementationAssertions) {
  if (architectureTests.has(name)) return 'genuine architecture invariant';
  if (classification === 'SUPERSEDED_CONTRACT' && implementationAssertions) return 'obsolete implementation snapshot';
  if (implementationAssertions && /safety|security|approval_truth|capability_execution|task_approval|ownership|isolation/i.test(name)) return 'genuine security invariant expressed through source checks';
  if (implementationAssertions && /i18n|settings|legal|navigation|copy/i.test(name)) return 'UI copy contract expressed through source checks';
  if (implementationAssertions) return 'implementation snapshot';
  if (launchesBrowser) return 'user-visible browser behavior';
  if (classification === 'LIVE_EXTERNAL') return 'live integration acceptance';
  return 'observable behavior';
}

const files = fs.readdirSync(testsDir).filter((name) => name.endsWith('.test.ts')).sort();
const registry = { schemaVersion: 1, generatedFrom: 'Evidence audit of tests/*.test.ts', tests: {} };

for (const filename of files) {
  const name = filename.slice(0, -'.test.ts'.length);
  const content = fs.readFileSync(path.join(testsDir, filename), 'utf8');
  const launchesBrowser = /chromium\.launch|firefox\.launch|webkit\.launch/.test(content);
  const implementationAssertions = sourceAssertions(content);
  let classification;
  let canonical = true;
  let note = 'Observable deterministic product/service contract.';

  if (harnessTests.has(name)) {
    classification = 'TEST_HARNESS';
    note = 'Validates test execution, registry coverage, or harness behavior.';
  } else if (deployedCert.has(name)) {
    classification = 'DEPLOYED_CERT';
    canonical = false;
    note = 'Deployment-gated live acceptance against a real deployed NAgex URL; never runs as part of regression or browser-cert.';
  } else if (liveExternal.has(name)) {
    classification = 'LIVE_EXTERNAL';
    canonical = false;
    note = 'Credential- or deployment-gated live acceptance; not a deterministic local regression.';
  } else if (superseded.has(name)) {
    classification = 'SUPERSEDED_CONTRACT';
    canonical = false;
    note = superseded.get(name).note;
  } else if (launchesBrowser) {
    classification = 'REAL_BROWSER_CERT';
    note = 'Runs observable UI behavior in a real Playwright Chromium browser.';
  } else if (architectureTests.has(name)) {
    classification = 'CANONICAL_ARCHITECTURE';
    note = 'Enforces an intentional module, route, or composition boundary.';
  } else if (implementationAssertions) {
    classification = 'IMPLEMENTATION_COUPLED';
    canonical = false;
    note = 'Reads production source/markup and asserts implementation shape; underlying intent requires conversion review.';
  } else {
    classification = 'CANONICAL_BEHAVIOR';
  }

  // Repository artifact writes: fs.writeFileSync(...) or Playwright
  // page.screenshot({ path: ... }) — only meaningful for REAL_BROWSER_CERT
  // entries (see tests/test_contract_registry.test.ts), which the "browser"
  // gate must be able to exclude pending remediation without re-scanning
  // source itself.
  const writesRepositoryArtifacts = /writeFileSync|screenshot\(\{[^}]*path/.test(content);

  const entry = {
    milestone: milestone(name),
    classification,
    canonical,
    scopes: scopesFor(name, content),
    externalDependencies: liveExternal.get(name) ?? deployedCert.get(name)?.deps ?? [],
    realBrowser: launchesBrowser,
    sourceImplementationAssertions: implementationAssertions,
    deterministic: !liveExternal.has(name) && !deployedCert.has(name),
    assertionIntent: assertionIntentFor(name, content, classification, launchesBrowser, implementationAssertions),
    notes: note,
  };
  if (launchesBrowser) entry.writesRepositoryArtifacts = writesRepositoryArtifacts;
  if (deployedCert.has(name)) entry.requiresEnv = deployedCert.get(name).requiresEnv;
  if (superseded.has(name)) entry.supersededBy = superseded.get(name).by;
  if (name === 'r21_p1_ux_integration') {
    entry.supersededBy = 'R22.8';
    entry.notes = 'Mixed source-level UX contracts; legacy frontend Home aggregation was replaced by PersonalHomeService and the assertion has been reconciled.';
  }
  if (name === 'r21_p1_demo_scenario') {
    entry.supersededBy = 'R22.8/R22.9';
    entry.notes = 'Demo scenario remains useful, while canonical Home aggregation and Memory ownership now live in R22 services.';
  }
  registry.tests[name] = entry;
}

fs.writeFileSync(output, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
