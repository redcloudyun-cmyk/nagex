import assert from 'node:assert/strict';
import test from 'node:test';
import { NagexError } from '../src/common/errors.js';
import {
  assertScenarioDefinition,
  buildScenarioMatrix,
  evaluateScenarioRiskPolicy,
  findScenario,
  loadScenarioCatalog,
  renderScenarioMatrixMarkdown,
  ScenarioRunner,
  type ScenarioDefinition,
} from '../src/scenarios/index.js';

const FIRST_BATCH = ['MSG-001', 'MSG-003', 'MSG-004', 'CAL-001', 'RES-001', 'RES-003', 'RPT-001', 'RSV-001', 'BG-001', 'DEV-001'];

function catalog() {
  return loadScenarioCatalog();
}

function scenario(id: string) {
  return findScenario(catalog(), id);
}

function completePreconditions(def: ScenarioDefinition) {
  return [...def.preconditions];
}

test('scenario schema validation accepts canonical catalog and rejects malformed definitions', () => {
  const cat = catalog();
  assert.ok(cat.scenarios.length >= 40);
  for (const def of cat.scenarios) assert.equal(assertScenarioDefinition(def).scenarioId, def.scenarioId);
  assert.throws(
    () => assertScenarioDefinition({ scenarioId: 'BAD' }),
    (err: unknown) => err instanceof NagexError && err.code === 'SCENARIO_INVALID_SCHEMA',
  );
});

test('scenario registry contains unique initial v1 catalog across required categories', () => {
  const cat = catalog();
  const ids = new Set(cat.scenarios.map((s) => s.scenarioId));
  assert.equal(ids.size, cat.scenarios.length);
  for (const id of FIRST_BATCH) assert.ok(ids.has(id), `${id} must be registered`);
  const categories = new Set(cat.scenarios.map((s) => s.category));
  for (const required of ['MESSAGING', 'CALENDAR', 'RESEARCH', 'REPORT', 'RESERVATION', 'BACKGROUND', 'MULTI_DEVICE', 'SECURITY', 'CROSS_CAPABILITY']) {
    assert.ok(categories.has(required as any), `${required} category missing`);
  }
});

test('risk policy drives approval, verification, retry, and cleanup strength', () => {
  const msg = scenario('MSG-001');
  const res = scenario('RES-001');
  const buy = scenario('BUY-004');
  assert.equal(evaluateScenarioRiskPolicy(msg).approvalRequired, true);
  assert.equal(evaluateScenarioRiskPolicy(msg).targetVerificationStrength, 'STRONG');
  assert.equal(evaluateScenarioRiskPolicy(msg).retryBehavior, 'NO_DUPLICATE_RISK_RETRY');
  assert.equal(evaluateScenarioRiskPolicy(res).approvalRequired, false);
  assert.equal(evaluateScenarioRiskPolicy(buy).retryBehavior, 'MANUAL_REAPPROVAL_REQUIRED');
  assert.equal(evaluateScenarioRiskPolicy(buy).payloadBindingRequired, true);
});

test('approval gating blocks consequential scenario until approval without treating approval as success', async () => {
  const runner = new ScenarioRunner();
  const def = scenario('MSG-001');
  const result = await runner.run(def, { mode: 'SIMULATION', availablePreconditions: completePreconditions(def) });
  assert.equal(result.status, 'BLOCKED_USER_INTERACTION');
  assert.equal(result.approvalRequired, true);
  assert.equal(result.executionDispatched, false);
  assert.equal(result.outcomeVerified, false);
});

test('WAITING_FOR_PRECONDITION resumes the same run after device unlock style precondition', async () => {
  const runner = new ScenarioRunner();
  const def = scenario('MSG-004');
  const waiting = await runner.run(def, { mode: 'SIMULATION', approvalGranted: true, availablePreconditions: ['DEVICE_CONNECTED'] });
  assert.equal(waiting.status, 'WAITING_FOR_PRECONDITION');
  const resumed = await runner.run(def, { mode: 'SIMULATION', runId: waiting.runId, approvalGranted: true, availablePreconditions: completePreconditions(def) });
  assert.equal(resumed.runId, waiting.runId);
  assert.equal(resumed.status, 'PASS');
});

test('verified outcome is required; dispatch alone produces OUTCOME_UNVERIFIED', async () => {
  const runner = new ScenarioRunner();
  const def = scenario('MSG-005');
  const result = await runner.run(def, {
    mode: 'SIMULATION',
    approvalGranted: true,
    availablePreconditions: completePreconditions(def),
    simulate: { outcomeVerified: false },
  });
  assert.equal(result.executionDispatched, true);
  assert.equal(result.status, 'OUTCOME_UNVERIFIED');
});

test('cleanup and context restore are required where declared', async () => {
  const runner = new ScenarioRunner();
  const def = scenario('RSV-001');
  const result = await runner.run(def, {
    mode: 'SIMULATION',
    approvalGranted: true,
    availablePreconditions: completePreconditions(def),
    simulate: { cleanupVerified: false, contextRestored: false },
  });
  assert.equal(result.status, 'FAIL');
  assert.match(result.failureCode || '', /cleanupVerified/);
});

test('hard-stop conditions block duplicate execution and unsafe target drift', async () => {
  const runner = new ScenarioRunner();
  const def = scenario('MSG-001');
  const duplicate = await runner.run(def, {
    mode: 'SIMULATION',
    approvalGranted: true,
    availablePreconditions: completePreconditions(def),
    simulate: { duplicateConsequentialRisk: true },
  });
  assert.equal(duplicate.status, 'FAIL');
  assert.equal(duplicate.failureCode, 'DUPLICATE_CONSEQUENTIAL_RISK');
  const wrong = await runner.run(def, {
    mode: 'SIMULATION',
    approvalGranted: true,
    availablePreconditions: completePreconditions(def),
    simulate: { wrongConversation: true },
  });
  assert.equal(wrong.failureCode, 'WRONG_CONVERSATION');
});

test('simulation versus real isolation: REAL never silently executes when not eligible', async () => {
  const runner = new ScenarioRunner();
  const def = scenario('RSV-001');
  const result = await runner.run(def, { mode: 'REAL', approvalGranted: true, availablePreconditions: completePreconditions(def) });
  assert.equal(result.status, 'SKIPPED');
  assert.equal(result.failureCode, 'REAL_EXECUTION_NOT_ALLOWED');
});

test('evidence is correlated and redacted for scenario, run, approval, command, execution, and device', async () => {
  const runner = new ScenarioRunner();
  const def = scenario('DEV-001');
  const result = await runner.run(def, {
    mode: 'SIMULATION',
    approvalGranted: true,
    availablePreconditions: completePreconditions(def),
    deviceId: 'dev_test',
  });
  assert.equal(result.status, 'PASS');
  assert.ok(result.commandId?.startsWith('cmd_'));
  assert.ok(result.executionId?.startsWith('exe_'));
  assert.ok(result.approvalId?.startsWith('apr_'));
  assert.ok(result.evidence.length >= 4);
  for (const evidence of result.evidence) {
    assert.equal(evidence.scenarioId, 'DEV-001');
    assert.equal(evidence.runId, result.runId);
    assert.equal(evidence.redacted, true);
    assert.equal(evidence.deviceId, 'dev_test');
  }
});

test('performance telemetry records all canonical latency fields', async () => {
  let now = 100;
  const runner = new ScenarioRunner({ now: () => ++now, nowIso: () => '2026-10-09T00:00:00.000Z' });
  const def = scenario('RES-001');
  const result = await runner.run(def, { mode: 'SIMULATION', availablePreconditions: completePreconditions(def) });
  assert.equal(result.status, 'PASS');
  for (const key of ['intent_resolution_ms', 'target_resolution_ms', 'route_resolution_ms', 'approval_surface_ms', 'execution_start_ms', 'navigation_ms', 'action_ms', 'verification_ms', 'cleanup_ms', 'total_ms'] as const) {
    assert.equal(typeof result.telemetry[key], 'number', key);
  }
});

test('background and multi-device scenarios are represented and pass in simulation', async () => {
  const runner = new ScenarioRunner();
  for (const id of ['BG-001', 'DEV-001']) {
    const def = scenario(id);
    const result = await runner.run(def, { mode: 'SIMULATION', approvalGranted: true, availablePreconditions: completePreconditions(def), executionMode: def.supportedExecutionModes[0] });
    assert.equal(result.status, 'PASS', id);
  }
});

test('first certification batch passes in simulation without real-world side effects', async () => {
  const runner = new ScenarioRunner();
  const results = [];
  for (const id of FIRST_BATCH) {
    const def = scenario(id);
    const result = await runner.run(def, { mode: 'SIMULATION', approvalGranted: true, availablePreconditions: completePreconditions(def), executionMode: def.supportedExecutionModes[0] });
    results.push(result);
    assert.equal(result.status, 'PASS', id);
    assert.equal(result.mode, 'SIMULATION');
  }
  assert.equal(results.length, 10);
});

test('certification matrix is machine-readable and human-readable', async () => {
  const cat = catalog();
  const runner = new ScenarioRunner();
  const def = scenario('MSG-001');
  const result = await runner.run(def, { mode: 'SIMULATION', approvalGranted: true, availablePreconditions: completePreconditions(def) });
  const rows = buildScenarioMatrix(cat.scenarios, [result]);
  const row = rows.find((r) => r.Scenario === 'MSG-001');
  assert.equal(row?.LastResult, 'PASS');
  assert.equal(row?.Real, 'NOT_ALLOWED');
  const md = renderScenarioMatrixMarkdown(rows);
  assert.match(md, /\| Scenario \| Category \| Risk \|/);
  assert.match(md, /MSG-001/);
});
