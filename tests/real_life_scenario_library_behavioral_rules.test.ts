import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertBehavioralRule,
  assertScenarioDefinition,
  BehavioralPolicyEngine,
  buildBehaviorRuleMatrix,
  buildScenarioMatrix,
  buildScenarioRuleCoverage,
  loadBehavioralRuleRegistry,
  loadScenarioCatalog,
  normalizeScenarioCommandContext,
  type BehaviorPolicyInput,
} from '../src/scenarios/index.js';

const TOP20 = [
  'MSG-001', 'MSG-003', 'MSG-005',
  'EMAIL-001', 'EMAIL-005', 'EMAIL-008',
  'CAL-001', 'CAL-006',
  'RES-001', 'RES-003',
  'RPT-001', 'RPT-003',
  'RSV-001', 'RSV-003',
  'TRV-001',
  'BG-001', 'BG-003',
  'MM-001',
  'CROSS-001', 'CROSS-002',
];

function basePolicyInput(overrides: Partial<BehaviorPolicyInput> = {}): BehaviorPolicyInput {
  return {
    context: {
      userIntent: 'Send approved synthetic message',
      inputModalities: ['TEXT'],
      originDevice: 'DESKTOP',
      originSurface: 'NAgex Home',
    },
    riskLevel: 'L3_EXTERNAL_COMMUNICATION',
    executionState: 'WORKING',
    candidateAction: {
      actionType: 'message.send',
      consequential: true,
      externalEffect: true,
    },
    evidence: {
      targetVerified: true,
      payloadVerified: true,
      approvalGranted: true,
      outcomeObserved: false,
      outcomeVerified: false,
      currentStateObserved: true,
    },
    ...overrides,
  };
}

test('real-life scenario library v1 is data-driven, broad, synthetic, and schema-valid', () => {
  const catalog = loadScenarioCatalog();
  assert.ok(catalog.scenarios.length >= 100 && catalog.scenarios.length <= 120);
  const categories = new Set(catalog.scenarios.map((scenario) => scenario.category));
  assert.ok(categories.size >= 20);
  for (const def of catalog.scenarios) {
    assert.equal(assertScenarioDefinition(def).scenarioId, def.scenarioId);
    assert.ok(def.inputModalities?.length, `${def.scenarioId} has modalities`);
    assert.ok(def.originDevice, `${def.scenarioId} has origin device`);
    assert.ok(def.originSurface, `${def.scenarioId} has origin surface`);
    assert.ok(def.targetResolution, `${def.scenarioId} has target resolution`);
    assert.ok(def.routeResolution, `${def.scenarioId} has route resolution`);
    assert.ok(def.executionGoal, `${def.scenarioId} has execution goal`);
    assert.ok(def.verificationGoal, `${def.scenarioId} has verification goal`);
    assert.ok(def.ruleCoverage?.length, `${def.scenarioId} has rule coverage`);
    const serialized = JSON.stringify(def).toLowerCase();
    assert.equal(serialized.includes('blue dia'), false);
    assert.equal(serialized.includes('010-'), false);
    assert.equal(serialized.includes('redcl'), false);
  }
});

test('top-20 certification set is registered across simulation/sandbox/real without fake REAL claims', () => {
  const catalog = loadScenarioCatalog();
  const ids = new Set(catalog.scenarios.map((scenario) => scenario.scenarioId));
  for (const id of TOP20) assert.ok(ids.has(id), `${id} must be registered`);
  for (const scenario of catalog.scenarios) {
    assert.ok((scenario.modes || [scenario.testMode]).includes('SIMULATION'));
    if ((scenario.modes || []).includes('REAL')) assert.equal(scenario.realWorldExecutionAllowed, true);
    if (scenario.realWorldExecutionAllowed) assert.ok(['RESEARCH', 'REPORT', 'DOCUMENT', 'PERSONAL_ROUTINE', 'BACKGROUND', 'CONDITION_WATCH'].includes(scenario.category));
  }
});

test('behavioral rule registry v1 contains active versioned reusable rules', () => {
  const registry = loadBehavioralRuleRegistry();
  assert.equal(registry.rules.length, 25);
  for (const rule of registry.rules) {
    assert.equal(assertBehavioralRule(rule).ruleId, rule.ruleId);
    assert.equal(rule.status, 'ACTIVE');
    assert.ok(rule.sourceScenarios.length > 0);
  }
});

test('behavior engine priority resolves conflicts in favor of authority and safety rules', () => {
  const engine = new BehavioralPolicyEngine();
  const result = engine.evaluate(basePolicyInput({
    candidateAction: {
      actionType: 'message.send',
      consequential: true,
      externalEffect: true,
      targetDrift: true,
      recoverableFailure: true,
    },
    evidence: { targetVerified: false, approvalGranted: true },
  }));
  assert.equal(result.decision, 'REQUIRE_RECONFIRMATION');
  assert.equal(result.priority, 'P0');
  assert.ok(result.appliedRuleIds.includes('BR-005'));
});

test('behavior engine blocks target drift, payload drift, and material condition changes', () => {
  const engine = new BehavioralPolicyEngine();
  assert.equal(engine.evaluate(basePolicyInput({ candidateAction: { actionType: 'send', consequential: true, externalEffect: true, targetDrift: true } })).decision, 'REQUIRE_RECONFIRMATION');
  assert.equal(engine.evaluate(basePolicyInput({ candidateAction: { actionType: 'send', consequential: true, externalEffect: true, payloadDrift: true } })).decision, 'REQUIRE_RECONFIRMATION');
  assert.equal(engine.evaluate(basePolicyInput({ candidateAction: { actionType: 'book', consequential: true, externalEffect: true, materialConditionChange: true } })).decision, 'REQUIRE_RECONFIRMATION');
});

test('duplicate prevention and uncertain outcome require reconciliation before retry', () => {
  const engine = new BehavioralPolicyEngine();
  const duplicate = engine.evaluate(basePolicyInput({ candidateAction: { actionType: 'payment.submit', consequential: true, externalEffect: true, duplicateRisk: true } }));
  assert.equal(duplicate.decision, 'RECONCILE_OUTCOME');
  assert.ok(duplicate.appliedRuleIds.includes('BR-004'));
  const uncertain = engine.evaluate(basePolicyInput({ candidateAction: { actionType: 'message.send', consequential: true, externalEffect: true, outcomeUncertain: true } }));
  assert.equal(uncertain.decision, 'RECONCILE_OUTCOME');
});

test('approval, outcome verification, precondition wait, recovery, and cleanup are distinct decisions', () => {
  const engine = new BehavioralPolicyEngine();
  assert.equal(engine.evaluate(basePolicyInput({ evidence: { approvalGranted: false }, candidateAction: { actionType: 'send', consequential: true, externalEffect: true } })).decision, 'REQUIRE_APPROVAL');
  assert.equal(engine.evaluate(basePolicyInput({ executionState: 'VERIFYING', evidence: { approvalGranted: true, outcomeVerified: false }, candidateAction: { actionType: 'send', consequential: true, externalEffect: true } })).decision, 'REOBSERVE');
  assert.equal(engine.evaluate(basePolicyInput({ candidateAction: { actionType: 'send', consequential: true, externalEffect: true, needsPrecondition: 'DEVICE_LOCKED' } })).decision, 'WAIT_FOR_PRECONDITION');
  assert.equal(engine.evaluate(basePolicyInput({ candidateAction: { actionType: 'send', consequential: true, externalEffect: true, recoverableFailure: true } })).decision, 'RECOVER');
  assert.equal(engine.evaluate(basePolicyInput({ candidateAction: { actionType: 'send', consequential: true, externalEffect: true, cleanupRequired: true }, evidence: { approvalGranted: true, outcomeVerified: true, cleanupVerified: false } })).decision, 'RECOVER');
});

test('multimodal normalization keeps device and modality independent', () => {
  const scenario = loadScenarioCatalog().scenarios.find((def) => def.scenarioId === 'MM-001');
  assert.ok(scenario);
  const context = normalizeScenarioCommandContext(scenario!);
  assert.deepEqual(context.inputModalities, ['SCREEN', 'VOICE']);
  assert.equal(context.originDevice, 'DESKTOP');
  assert.equal(context.executionDevice, 'ANDROID_TEST_DEVICE');
});

test('background and proactive policies are supported without autonomous consequential action', () => {
  const engine = new BehavioralPolicyEngine();
  const background = normalizeScenarioCommandContext(loadScenarioCatalog().scenarios.find((def) => def.scenarioId === 'BG-001')!);
  assert.equal(background.backgroundEligible, true);
  const proactive = engine.evaluate(basePolicyInput({
    context: { ...background, proactive: true },
    candidateAction: { actionType: 'reservation.submit', consequential: true, externalEffect: true },
    evidence: { approvalGranted: false },
  }));
  assert.equal(proactive.decision, 'REQUIRE_APPROVAL');
  assert.ok(proactive.appliedRuleIds.includes('BR-019') || proactive.appliedRuleIds.includes('BR-009'));
});

test('AI/JEV candidate is blocked by deterministic behavioral rule evidence requirements', () => {
  const engine = new BehavioralPolicyEngine();
  const result = engine.evaluate(basePolicyInput({
    candidateAction: { actionType: 'ui.click.send', consequential: true, externalEffect: true, aiSuggested: true },
    evidence: { approvalGranted: true, targetVerified: false },
  }));
  assert.equal(result.decision, 'REOBSERVE');
  assert.ok(result.appliedRuleIds.includes('BR-016'));
});

test('scenario-rule traceability and matrices are generated', () => {
  const catalog = loadScenarioCatalog();
  const rules = loadBehavioralRuleRegistry().rules;
  const coverage = buildScenarioRuleCoverage(rules, catalog.scenarios);
  assert.equal(coverage.length, 25);
  assert.ok(coverage.every((row) => row.Simulation === 'COVERED'));
  const scenarioMatrix = buildScenarioMatrix(catalog.scenarios);
  assert.equal(scenarioMatrix.length, catalog.scenarios.length);
  assert.ok(scenarioMatrix[0].Modalities);
  assert.ok(scenarioMatrix[0].RuleCoverage);
  const behaviorMatrix = buildBehaviorRuleMatrix(rules);
  assert.equal(behaviorMatrix.length, 25);
  assert.ok(behaviorMatrix.find((row) => row.RuleID === 'BR-004')?.ScenarioCoverage.includes('PAY-003'));
});
