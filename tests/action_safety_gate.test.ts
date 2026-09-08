import { test } from 'node:test';
import assert from 'node:assert';
import { PreExecutionSafetyGate } from '../src/governance/action-safety.gate.js';
import { SafetyEngine } from '../src/governance/safety.engine.js';

test('1. Action Gate: Clears R0 Normal Action for Execution', async () => {
  const gate = PreExecutionSafetyGate.getInstance();
  const decision = await gate.evaluateAction({
    capabilityId: 'TASK',
    actionType: 'TASK',
    toolArguments: { name: 'Prepare project presentation' },
    tenantId: 'ten_test_001',
    userId: 'usr_test_001',
  });

  assert.strictEqual(decision.executionAllowed, true);
});

test('2. Action Gate: Blocks Phishing Payload in Email Execution', async () => {
  const gate = PreExecutionSafetyGate.getInstance();
  const decision = await gate.evaluateAction({
    capabilityId: 'gmail.send',
    actionType: 'GMAIL',
    toolArguments: { recipient: 'victim@target.co', body: 'Fake auth link login verify credential steal' },
    tenantId: 'ten_test_001',
    userId: 'usr_test_001',
  });

  assert.strictEqual(decision.riskLevel, 'R3');
  assert.strictEqual(decision.executionAllowed, false);
  assert.ok(decision.reasonCodes.includes('PRE_EXECUTION_PHISHING_PAYLOAD_BLOCKED'));
});

test('3. Action Gate: Blocks Destructive System Command Execution', async () => {
  const gate = PreExecutionSafetyGate.getInstance();
  const decision = await gate.evaluateAction({
    capabilityId: 'browser.exec',
    actionType: 'BROWSER',
    toolArguments: { command: 'rm -rf /' },
    tenantId: 'ten_test_001',
    userId: 'usr_test_001',
  });

  assert.strictEqual(decision.riskLevel, 'R3');
  assert.strictEqual(decision.executionAllowed, false);
  assert.ok(decision.reasonCodes.includes('PRE_EXECUTION_DESTRUCTIVE_COMMAND_BLOCKED'));
});

test('4. Action Gate: Prevents User Approval Override on R3/R4 Decisions', async () => {
  const gate = PreExecutionSafetyGate.getInstance();
  const intentDecision = await SafetyEngine.getInstance().evaluateIntent({
    input: 'Deploy phishing credential stealing fake login page to target users.',
    tenantId: 'ten_test_001',
    userId: 'usr_test_001',
  });

  // User presses Approve on a candidate/action that was classified R3
  const gatedDecision = await gate.evaluateAction({
    intentDecision,
    capabilityId: 'gmail.send',
    actionType: 'GMAIL',
    toolArguments: { to: 'victim@target.co' },
    tenantId: 'ten_test_001',
    userId: 'usr_test_001',
  });

  // Must remain blocked regardless of approval attempt
  assert.strictEqual(gatedDecision.executionAllowed, false);
  assert.ok(gatedDecision.reasonCodes.includes('PRE_EXECUTION_OVERRIDE_PREVENTED'));
});
