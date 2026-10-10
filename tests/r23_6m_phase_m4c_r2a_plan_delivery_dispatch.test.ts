import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { hashCanonicalPayload } from '../src/governance/action-approval.store.js';
import { MobileAppAccessibilityExecutionService } from '../src/execution/mobile-app-accessibility-execution.js';
import { harness, plan } from './_m4a_device_ui_fixture.js';

const dispatcherSource = () => fs.readFileSync('mobile-android/app/src/main/java/com/nagex/mobile/AccessibilityExecutionPlanDispatcher.kt', 'utf8');
const statusSource = () => fs.readFileSync('mobile-android/app/src/main/java/com/nagex/mobile/StatusActivity.kt', 'utf8');
const payloadSource = () => fs.readFileSync('mobile-android/app/src/main/java/com/nagex/mobile/DeviceAgentPayload.kt', 'utf8');
const serviceSource = () => fs.readFileSync('mobile-android/app/src/main/java/com/nagex/mobile/NagexAccessibilityExecutionService.kt', 'utf8');
const endpointSource = () => fs.readFileSync('src/device-agent/device-agent-transport-endpoint.service.ts', 'utf8');

function prepared() {
  const h = harness();
  return new MobileAppAccessibilityExecutionService(h.authority).prepare(plan(h, {
    actions: ['OPEN_APP', 'SEARCH_CONTACT', 'SELECT_CONTACT', 'FOCUS_MESSAGE_BOX', 'TYPE_MESSAGE', 'OBSERVE_RESULT'],
  }));
}

test('M4C-R2A valid plan envelope carries trusted device, tenant, user, approval, route, and typed text binding', () => {
  const result = prepared();
  assert.equal(result.command?.commandType, 'ACCESSIBILITY_EXECUTE_PLAN');
  const data = result.command?.data;
  assert.equal(data?.capability, 'KAKAOTALK_ACCESSIBILITY_SEND');
  assert.equal(data?.executionRoute, 'ANDROID_ACCESSIBILITY');
  assert.equal(data?.targetPackage, 'com.kakao.talk');
  assert.equal(data?.targetAppVersion, '26.8.2');
  assert.equal(data?.approvedText, 'See you at 6.');
  assert.equal(data?.approvedPayloadHash, crypto.createHash('sha256').update('See you at 6.', 'utf8').digest('hex'));
  assert.equal(data?.messageHash, hashCanonicalPayload({ message: 'See you at 6.' }));
  assert.ok(data?.approvalRef);
});

test('M4C-R2A plan uses supported semantic step vocabulary and no send action', () => {
  const steps = prepared().command?.data.steps ?? [];
  assert.deepEqual(steps.map((s) => s.action), ['OPEN_APP', 'CLICK_ALLOWED_NODE', 'FIND_ELEMENT', 'TYPE_APPROVED_RECIPIENT_QUERY', 'SELECT_RECIPIENT', 'VERIFY_RECIPIENT', 'FOCUS_INPUT', 'TYPE_APPROVED_TEXT', 'OBSERVE_RESULT']);
  assert.equal(steps[1].semanticTarget, 'bottom-chat-tab');
  assert.equal(steps[1].selectorHints.ancestorResourceId, 'com.kakao.talk:id/sliding_tabs');
  assert.equal(steps[1].selectorHints.requireSelectedAfterClick, true);
  assert.equal(steps[3].semanticTarget, 'search-input');
  assert.equal(steps.some((s) => ['PRESS_SEND', 'SEND_MESSAGE', 'CLICK_SEND'].includes(s.action)), false);
});

test('M4C-R2A selector hints are semantic and do not carry coordinates or executable selectors', () => {
  const steps = prepared().command?.data.steps ?? [];
  const serialized = JSON.stringify(steps);
  assert.match(serialized, /semanticTarget/);
  for (const step of steps) {
    assert.equal(Object.hasOwn(step.selectorHints, 'x'), false);
    assert.equal(Object.hasOwn(step.selectorHints, 'y'), false);
    assert.equal(Object.hasOwn(step.selectorHints, 'xpath'), false);
    assert.equal(Object.hasOwn(step.selectorHints, 'script'), false);
    assert.equal(Object.hasOwn(step.selectorHints, 'coordinate'), false);
  }
  assert.doesNotMatch(serialized, /"xpath"|"script"|"coordinate"/i);
});

test('M4C-R2A Android status screen receives pending ACCESSIBILITY_EXECUTE_PLAN from existing heartbeat transport', () => {
  const source = statusSource();
  assert.match(source, /DeviceAgentPayload\.heartbeat/);
  assert.match(source, /pendingCommand/);
  assert.match(source, /ACCESSIBILITY_EXECUTE_PLAN/);
  assert.match(source, /AccessibilityExecutionPlanDispatcher/);
});

test('M4C-R2A Android reports typed result through the existing signed device-agent message path', () => {
  const source = payloadSource();
  assert.match(source, /fun accessibilityPlanResult/);
  assert.match(source, /\\"commandType\\":\\"ACCESSIBILITY_EXECUTE_PLAN\\"/);
  assert.match(statusSource(), /DeviceAgentPayload\.accessibilityPlanResult/);
});

test('M4C-R2A server accepts only safe accessibility result metadata and not approved text', () => {
  const source = endpointSource();
  assert.match(source, /ACCESSIBILITY_PLAN_RESULT_RECORDED/);
  assert.match(source, /confirmationStrength/);
  assert.doesNotMatch(source, /record\.approvedText/);
});

const sourceChecks: Array<[string, () => string, RegExp, RegExp?]> = [
  ['valid signed plan received', dispatcherSource, /commandType"\) != "ACCESSIBILITY_EXECUTE_PLAN"/],
  ['wrong device rejected', dispatcherSource, /WRONG_DEVICE/],
  ['wrong tenant rejected', dispatcherSource, /WRONG_TENANT/],
  ['wrong user rejected', dispatcherSource, /WRONG_USER/],
  ['expired plan rejected', dispatcherSource, /COMMAND_EXPIRED/],
  ['replay rejected', dispatcherSource, /REPLAY_REJECTED/],
  ['malformed plan rejected', dispatcherSource, /MALFORMED_PLAN/],
  ['unknown action rejected', dispatcherSource, /UNKNOWN_ACTION/],
  ['send action rejected', dispatcherSource, /BLOCKED_ACTION_NOT_ALLOWED/],
  ['accessibility disabled blocked', dispatcherSource, /DeviceEnrollmentManager\.accessibilityState/],
  ['service disconnected blocked', dispatcherSource, /NagexAccessibilityExecutionService\.active\(\) \?: return DispatchResult\.blocked\(commandId, planId, "ACCESSIBILITY_UNAVAILABLE"\)/],
  ['wrong foreground package blocked', dispatcherSource, /PACKAGE_MISMATCH/],
  ['valid recipient step present', dispatcherSource, /SELECT_RECIPIENT/],
  ['approved recipient search query present', dispatcherSource, /TYPE_APPROVED_RECIPIENT_QUERY/],
  ['recipient mismatch blocks before type', dispatcherSource, /RECIPIENT_UNVERIFIED/],
  ['type before recipient verification blocked', dispatcherSource, /OUT_OF_ORDER_STEP/],
  ['valid approved text hash checked', dispatcherSource, /sha256Hex\(approvedText\) != plan\.optString\("approvedPayloadHash"\)/],
  ['text hash mismatch blocks', dispatcherSource, /PAYLOAD_HASH_MISMATCH/],
  ['execution budget exceeded', dispatcherSource, /EXECUTION_BUDGET_EXCEEDED/],
  ['user interruption aborts', dispatcherSource, /USER_INTERRUPTED/],
  ['result ack status available', dispatcherSource, /DRAFT_PREPARED/],
  ['step result index reported', dispatcherSource, /stepIndex/],
  ['no raw message logging', dispatcherSource, /approvedText/, /Log\.|printStackTrace|println/],
  ['service active availability exposed', serviceSource, /fun active\(\): NagexAccessibilityExecutionService\?/],
  ['relative hierarchy selector supported', serviceSource, /ancestorResourceViewId/],
  ['selected chat tab is a no-op pass', serviceSource, /NAV_ALREADY_SELECTED/],
  ['unselected chat tab is verified after click', serviceSource, /NAV_SELECTED_AFTER_CLICK/],
  ['selection verification can fail closed', serviceSource, /NAV_SELECTION_VERIFY_FAILED/],
  ['ambiguous matching nodes fail closed', serviceSource, /AMBIGUOUS_NODE/],
  ['no coordinate execution primitives', serviceSource, /ACTION_SET_TEXT/, /dispatchGesture|GestureDescription|coordinate|CLICK_SEND/],
];

for (const [name, read, must, mustNot] of sourceChecks) {
  test(`M4C-R2A ${name}`, () => {
    const source = read();
    assert.match(source, must);
    if (mustNot) assert.doesNotMatch(source, mustNot);
  });
}
