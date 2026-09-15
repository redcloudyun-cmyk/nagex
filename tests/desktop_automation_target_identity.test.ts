// DC3-B2 Preflight — Mandatory Safety Correction After Notepad Multi-Tab
// Failure. Proves the target-identity/mutation-safety-gate policy that
// incident requires: PID alone can never resolve a unique mutation
// target, ambiguous/changed/unowned targets are always blocked before
// execution, and no code path in this module ever performs a force-kill.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  resolveUniqueTarget,
  runMutationSafetyGate,
  evaluateCloseSafety,
  toTargetIdentity,
  type TargetCandidate,
} from '../src/device-agent/desktop-automation-target-identity.js';

const userTab: TargetCandidate = {
  automationElementRuntimeId: 'rt-user-tab-1',
  controlAncestry: ['Window', 'Document'],
  windowTitle: 'Untitled - Notepad',
  ownership: 'USER_EXISTING_TARGET',
};

const SECRET_SHAPED_TITLE_SAMPLE = 'sk-proj-SYNTHETIC000000000000TESTONLY';

const userSecretTab: TargetCandidate = {
  automationElementRuntimeId: 'rt-user-tab-2',
  controlAncestry: ['Window', 'Document'],
  windowTitle: `${SECRET_SHAPED_TITLE_SAMPLE} - Notepad`,
  ownership: 'USER_EXISTING_TARGET',
};

const nagexOwnedTarget: TargetCandidate = {
  automationElementRuntimeId: 'rt-nagex-owned-1',
  controlAncestry: ['Window', 'Edit'],
  windowTitle: 'NAgex UIA Test Harness [t1]',
  ownership: 'NAGEX_OWNED_TEST_TARGET',
};

test('UIA_PID_ONLY_MUTATION_BLOCKED / UIA_MULTI_TAB_PROCESS_NOT_ASSUMED_SINGLE_TARGET: two real tabs sharing one PID never resolve to a single target', () => {
  const outcome = resolveUniqueTarget('dev-1', 'sess-1', 14228, [userTab, userSecretTab]);
  assert.equal(outcome.status, 'TARGET_AMBIGUOUS');
  if (outcome.status === 'TARGET_AMBIGUOUS') {
    assert.equal(outcome.matchCount, 2);
  }
});

test('a genuinely unique candidate does resolve, proving the gate is not simply always-ambiguous', () => {
  const outcome = resolveUniqueTarget('dev-1', 'sess-1', 9999, [nagexOwnedTarget]);
  assert.equal(outcome.status, 'RESOLVED');
});

test('UIA_AMBIGUOUS_TARGET_BLOCKED: the mutation gate never executes when re-observation yields more than one candidate', () => {
  const boundIdentity = toTargetIdentity('dev-1', 'sess-1', 14228, nagexOwnedTarget);
  let executed = false;
  const outcome = runMutationSafetyGate({
    boundIdentity,
    reobserve: () => [userTab, userSecretTab],
    execute: () => {
      executed = true;
      return 'should-not-happen';
    },
  });
  assert.equal(outcome.status, 'TARGET_AMBIGUOUS');
  assert.equal(executed, false);
});

test('UIA_EXISTING_USER_WINDOW_MUTATION_BLOCKED: a USER_EXISTING_TARGET is never mutated without explicit user selection', () => {
  const boundIdentity = toTargetIdentity('dev-1', 'sess-1', 14228, userTab);
  let executed = false;
  const outcome = runMutationSafetyGate({
    boundIdentity,
    reobserve: () => [userTab],
    execute: () => {
      executed = true;
    },
  });
  assert.equal(outcome.status, 'TARGET_NOT_OWNED');
  assert.equal(executed, false);
});

test('UIA_NAGEX_OWNED_TEST_TARGET_MUTATION_ALLOWED: a NAGEX_OWNED_TEST_TARGET with an unchanged identity is allowed to execute', () => {
  const boundIdentity = toTargetIdentity('dev-1', 'sess-1', 9999, nagexOwnedTarget);
  let executed = false;
  const outcome = runMutationSafetyGate({
    boundIdentity,
    reobserve: () => [nagexOwnedTarget],
    execute: () => {
      executed = true;
      return 'ok';
    },
  });
  assert.equal(outcome.status, 'EXECUTED');
  assert.equal(executed, true);
});

test('UIA_TARGET_IDENTITY_RECHECKED_BEFORE_MUTATION: reobserve() is always called, and always before execute()', () => {
  const boundIdentity = toTargetIdentity('dev-1', 'sess-1', 9999, nagexOwnedTarget);
  const callOrder: string[] = [];
  runMutationSafetyGate({
    boundIdentity,
    reobserve: () => {
      callOrder.push('reobserve');
      return [nagexOwnedTarget];
    },
    execute: () => {
      callOrder.push('execute');
    },
  });
  assert.deepEqual(callOrder, ['reobserve', 'execute']);
});

test('UIA_TARGET_CHANGED_AFTER_OBSERVATION_BLOCKED: a target whose identity changed between observation and mutation is blocked, never executed', () => {
  const boundIdentity = toTargetIdentity('dev-1', 'sess-1', 9999, nagexOwnedTarget);
  const changedTarget: TargetCandidate = { ...nagexOwnedTarget, automationElementRuntimeId: 'rt-nagex-owned-1-CHANGED' };
  let executed = false;
  const outcome = runMutationSafetyGate({
    boundIdentity,
    reobserve: () => [changedTarget],
    execute: () => {
      executed = true;
    },
  });
  assert.equal(outcome.status, 'TARGET_CHANGED_SINCE_OBSERVATION');
  assert.equal(executed, false);
});

test('UIA_FORCE_KILL_NOT_USED_FOR_NORMAL_CLOSE: the module exposes no force-kill affordance, and the normal allowed close path is graceful', async () => {
  const moduleExports = (await import('../src/device-agent/desktop-automation-target-identity.js')) as Record<string, unknown>;
  const exportNames = Object.keys(moduleExports).join(',').toLowerCase();
  assert.ok(!exportNames.includes('force'), 'no exported function name may reference force-kill');
  assert.ok(!exportNames.includes('kill'), 'no exported function name may reference kill');

  const ownedIdentity = toTargetIdentity('dev-1', 'sess-1', 9999, nagexOwnedTarget);
  const outcome = evaluateCloseSafety({
    target: ownedIdentity,
    processHostsOtherTargets: false,
    unsavedStateKnown: true,
  });
  assert.equal(outcome, 'GRACEFUL_CLOSE_ALLOWED');
});

test('UIA_SHARED_PROCESS_FORCE_KILL_BLOCKED: a process known (or unknown-status) to host other targets is never closeable, exactly the real Notepad shape', () => {
  const ownedIdentity = toTargetIdentity('dev-1', 'sess-1', 14228, nagexOwnedTarget);
  const sharedKnown = evaluateCloseSafety({ target: ownedIdentity, processHostsOtherTargets: true, unsavedStateKnown: true });
  assert.equal(sharedKnown, 'CLOSE_UNSAFE');

  const sharedUnknown = evaluateCloseSafety({ target: ownedIdentity, processHostsOtherTargets: 'UNKNOWN', unsavedStateKnown: true });
  assert.equal(sharedUnknown, 'CLOSE_UNSAFE');

  const userOwned = evaluateCloseSafety({
    target: toTargetIdentity('dev-1', 'sess-1', 14228, userTab),
    processHostsOtherTargets: false,
    unsavedStateKnown: true,
  });
  assert.equal(userOwned, 'TARGET_NOT_OWNED');
});

test('UIA_UNSAVED_STATE_UNKNOWN_CLOSE_BLOCKED: an owned, unshared target with unknown unsaved state is never closed silently', () => {
  const ownedIdentity = toTargetIdentity('dev-1', 'sess-1', 9999, nagexOwnedTarget);
  const outcome = evaluateCloseSafety({ target: ownedIdentity, processHostsOtherTargets: false, unsavedStateKnown: false });
  assert.equal(outcome, 'UNSAVED_STATE_UNKNOWN');
});

test('UIA_DEDICATED_TEST_HARNESS: a dedicated, isolated, no-user-data UIA test harness exists with deterministic AutomationIds and no force-kill affordance', () => {
  const harnessPath = path.join(process.cwd(), 'tools', 'uia-test-harness', 'nagex-uia-test-harness.ps1');
  assert.ok(fs.existsSync(harnessPath), 'the dedicated UIA test harness script must exist');
  const contents = fs.readFileSync(harnessPath, 'utf8');

  const requiredAutomationIds = ['NagexTestTextInput', 'NagexTestButton', 'NagexTestCheckbox', 'NagexTestListBox', 'NagexTestScrollPanel', 'NagexTestCloseButton'];
  for (const id of requiredAutomationIds) {
    assert.ok(contents.includes(id), `harness must expose deterministic control: ${id}`);
  }

  const executableLines = contents
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
  assert.ok(!/Stop-Process/i.test(executableLines), 'the harness must never actually invoke Stop-Process (mentioning it in a comment is fine)');
  assert.ok(!/-Force/i.test(executableLines), 'the harness must never expose a -Force close path');
  assert.ok(contents.includes('$form.Close()'), 'the only close path must be the graceful WinForms Form.Close()');
});

test('window-title-shaped evidence carried inside a TargetIdentity is redacted metadata, never the raw title (secret-adjacent titles never leak through target identity)', () => {
  const identity = toTargetIdentity('dev-1', 'sess-1', 14228, userSecretTab);
  const serialized = JSON.stringify(identity);
  assert.ok(!serialized.includes(SECRET_SHAPED_TITLE_SAMPLE), 'raw window title text must never appear in a persistable TargetIdentity');
  assert.equal(identity.windowTitleEvidence.containedSecretLike, true);
  assert.equal(identity.windowTitleEvidence.present, true);
});
