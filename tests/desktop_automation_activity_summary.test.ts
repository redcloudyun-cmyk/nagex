// DC3-B2 Real Windows UIA Harness Acceptance — Section 9 (transparency /
// Activity proof). Proves at the code level that a verified mutation's
// user-facing Activity text never leaks raw COM/UIA terminology and
// always carries redacted-only before/after text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toMutationActivitySummary, formatMutationActivityText } from '../src/device-agent/desktop-automation-activity-summary.js';
import { toSafeTextEvidence } from '../src/device-agent/sensitive-text-redaction.js';

const RAW_UIA_TERMS = ['ValuePattern', 'InvokePattern', 'TogglePattern', 'SelectionItemPattern', 'ScrollPattern', 'AutomationElement', 'RuntimeId', 'ProcessId', 'ControlType', 'COM'];

test('BACKGROUND_ACTIVITY_HUMAN_READABLE / RAW_UIA_EVENT_SPAM_HIDDEN: a SET_VALUE summary is human-readable and carries zero raw UIA/COM terminology', () => {
  const summary = toMutationActivitySummary({
    action: 'SET_VALUE',
    targetLabel: '테스트 입력값',
    before: toSafeTextEvidence(''),
    after: toSafeTextEvidence('NagexUIAHostAcceptance'),
    verified: true,
  });
  const text = formatMutationActivityText(summary);
  assert.equal(summary.headline, '테스트 입력값을 변경했습니다.');
  assert.ok(text.includes('Before'));
  assert.ok(text.includes('After'));
  assert.ok(text.includes('✓ 변경 확인 완료'));
  for (const term of RAW_UIA_TERMS) {
    assert.ok(!text.includes(term), `raw UIA/COM term "${term}" must never appear in Activity text`);
  }
});

test('VERIFIED_RESULT_VISIBLE: an unverified mutation is honestly reported, never silently shown as success', () => {
  const summary = toMutationActivitySummary({
    action: 'TOGGLE',
    targetLabel: '테스트 체크박스',
    before: toSafeTextEvidence('Off'),
    after: toSafeTextEvidence('Off'), // re-observation did not actually confirm the change
    verified: false,
  });
  assert.equal(summary.verifiedLine, '⚠ 변경 확인 실패');
});

test('RAW_SECRET_NOT_ACTIVITY_LOGGED: a secret-shaped before/after value never survives into the Activity summary', () => {
  const secretShaped = 'ghp_' + 'SYNTHETIC0000000000000000TESTONLY';
  const summary = toMutationActivitySummary({
    action: 'SET_VALUE',
    targetLabel: '테스트 입력값',
    before: toSafeTextEvidence(''),
    after: toSafeTextEvidence(secretShaped),
    verified: true,
  });
  const text = formatMutationActivityText(summary);
  assert.ok(!text.includes(secretShaped), 'raw secret-shaped text must never appear in Activity output');
  assert.ok(text.includes('[REDACTED]'));
});

test('every ActionKind produces a plain-language headline with no raw pattern name embedded', () => {
  const kinds: Array<Parameters<typeof toMutationActivitySummary>[0]['action']> = ['SET_VALUE', 'INVOKE', 'TOGGLE', 'SELECT', 'SCROLL'];
  for (const action of kinds) {
    const summary = toMutationActivitySummary({
      action,
      targetLabel: 'x',
      before: toSafeTextEvidence(null),
      after: toSafeTextEvidence(null),
      verified: true,
    });
    for (const term of RAW_UIA_TERMS) {
      assert.ok(!summary.headline.includes(term));
    }
  }
});
