import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { hashCanonicalPayload } from '../src/governance/action-approval.store.js';
import {
  KAKAOTALK_26_8_2_SCREEN_CONTRACTS,
  classifyKakaoVersion,
  validateKakaoScreenContract,
  MobileAppAccessibilityExecutionService,
  type KakaoSemanticNodeContract,
} from '../src/execution/mobile-app-accessibility-execution.js';
import { DeviceUIActionGate, FakeDeviceUIReasoner } from '../src/execution/device-ui-reasoner.js';
import { harness, plan, proposal, reasoningInput } from './_m4a_device_ui_fixture.js';

const chatListNodes: KakaoSemanticNodeContract[] = [
  { nodeRef: 'kakao_search_entry', className: 'android.widget.Button', contentDescription: '검색', clickable: true, editable: false },
  { nodeRef: 'kakao_chat_list', className: 'androidx.recyclerview.widget.RecyclerView', contentDescription: 'Chat list', clickable: false, editable: false },
];

const homeNewsNodes: KakaoSemanticNodeContract[] = [
  { nodeRef: 'kakao_bottom_chat_tab', className: 'android.widget.RelativeLayout', contentDescription: '채팅 탭 225개의 새로운 업데이트', clickable: true, editable: false },
];

const homeNewsNodesWithDynamicUnreadCount: KakaoSemanticNodeContract[] = [
  { nodeRef: 'kakao_bottom_chat_tab', className: 'android.widget.RelativeLayout', contentDescription: '채팅 탭 226개의 새로운 업데이트', clickable: true, editable: false },
];

const searchNodes: KakaoSemanticNodeContract[] = [
  { nodeRef: 'kakao_search_input', className: 'android.widget.EditText', contentDescription: 'Search input', clickable: true, editable: true },
];

const recipientNodes: KakaoSemanticNodeContract[] = [
  { nodeRef: 'kakao_test_recipient', className: 'android.view.ViewGroup', text: 'NAgex Cert Test', clickable: true, editable: false },
];

const chatNodes: KakaoSemanticNodeContract[] = [
  { nodeRef: 'kakao_chat_title', className: 'android.widget.TextView', text: 'NAgex Cert Test', clickable: false, editable: false },
  { nodeRef: 'kakao_message_input', className: 'android.widget.EditText', contentDescription: 'Message input', clickable: true, editable: true },
];

test('M4C-R1 Android capability report exposes real accessibility state from Android OS source', () => {
  const manager = fs.readFileSync('mobile-android/app/src/main/java/com/nagex/mobile/DeviceEnrollmentManager.kt', 'utf8');
  const status = fs.readFileSync('mobile-android/app/src/main/java/com/nagex/mobile/StatusActivity.kt', 'utf8');
  assert.match(manager, /Settings\.Secure\.ACCESSIBILITY_ENABLED/);
  assert.match(manager, /Settings\.Secure\.ENABLED_ACCESSIBILITY_SERVICES/);
  for (const capability of ['ANDROID_ACCESSIBILITY', 'DEEP_LINK_OPEN', 'CONTACT_READ', 'SMS_SEND', 'VOICE_CAPTURE']) {
    assert.match(manager, new RegExp(capability));
  }
  assert.match(status, /DeviceAgentPayload\.heartbeat/);
  assert.doesNotMatch(manager, /enabled\s*=\s*true/i);
});

test('M4C-R1 real AccessibilityService implements bounded primitives and keeps send disabled', () => {
  const service = fs.readFileSync('mobile-android/app/src/main/java/com/nagex/mobile/NagexAccessibilityExecutionService.kt', 'utf8');
  for (const action of ['FIND_ELEMENT', 'FOCUS_INPUT', 'CLICK_ALLOWED_NODE', 'TYPE_APPROVED_RECIPIENT_QUERY', 'TYPE_APPROVED_TEXT', 'SCROLL_BOUNDED', 'NAVIGATE_BACK', 'OBSERVE_RESULT']) {
    assert.match(service, new RegExp(action));
  }
  assert.match(service, /AccessibilityNodeInfo\.ACTION_CLICK/);
  assert.match(service, /AccessibilityNodeInfo\.ACTION_FOCUS/);
  assert.match(service, /AccessibilityNodeInfo\.ACTION_SET_TEXT/);
  assert.match(service, /AccessibilityNodeInfo\.ACTION_SCROLL_FORWARD/);
  assert.match(service, /GLOBAL_ACTION_BACK/);
  assert.match(service, /SEND_ACTION_DISABLED_IN_M4C_R1/);
  assert.doesNotMatch(service, /dispatchGesture|GestureDescription|coordinate|PRESS_SEND",/i);
});

test('M4C-R1 KakaoTalk 26.8.2 has exact certified contracts and negative cases', () => {
  assert.equal(classifyKakaoVersion('com.kakao.talk', '26.8.2'), 'CERTIFIED');
  assert.equal(classifyKakaoVersion('com.kakao.talk', '26.9.0'), 'UNCERTIFIED');
  assert.equal(classifyKakaoVersion('com.kakao.talk', '27.0.0'), 'UNSUPPORTED');
  assert.equal(classifyKakaoVersion('evil.package', '26.8.2'), 'UNSUPPORTED');
  assert.equal(KAKAOTALK_26_8_2_SCREEN_CONTRACTS.length, 6);
  assert.equal(validateKakaoScreenContract('home-news', homeNewsNodes), true);
  assert.equal(validateKakaoScreenContract('home-news', homeNewsNodesWithDynamicUnreadCount), true);
  assert.equal(validateKakaoScreenContract('chat-list', chatListNodes), true);
  assert.equal(validateKakaoScreenContract('search', searchNodes), true);
  assert.equal(validateKakaoScreenContract('recipient-result', recipientNodes), true);
  assert.equal(validateKakaoScreenContract('conversation', chatNodes), true);
  assert.equal(validateKakaoScreenContract('composer', chatNodes), true);
  assert.equal(validateKakaoScreenContract('recipient-result', [{ ...recipientNodes[0], text: 'Wrong Recipient' }]), false);
  assert.equal(validateKakaoScreenContract('search', []), false);
});

test('M4C-R1 certified version can prepare non-send navigation but send remains blocked', async () => {
  const h = harness();
  const prepared = h.accessibility.prepare(plan(h, {
    detectedVersion: '26.8.2',
    actions: ['OPEN_APP', 'SEARCH_CONTACT', 'SELECT_CONTACT', 'FOCUS_MESSAGE_BOX', 'TYPE_MESSAGE', 'OBSERVE_RESULT'],
  }));
  assert.equal(prepared.resultCode, 'READY');
  assert.equal(prepared.command?.data.actions.includes('PRESS_SEND'), false);
  assert.deepEqual(prepared.command?.data.steps.map((step) => step.semanticTarget), [
    'open_app',
    'bottom-chat-tab',
    'search-control',
    'search-input',
    'approved-recipient-result',
    'conversation-recipient-identity',
    'message-composer',
    'message-composer',
    'observe_result',
  ]);
  assert.equal(prepared.command?.data.steps[1].selectorHints.contentDescriptionContains, '채팅 탭');
  assert.equal(prepared.command?.data.steps[1].selectorHints.ancestorResourceId, 'com.kakao.talk:id/sliding_tabs');
  assert.equal(prepared.command?.data.steps[1].selectorHints.requireSelectedAfterClick, true);
  assert.equal(prepared.command?.data.steps[3].action, 'TYPE_APPROVED_RECIPIENT_QUERY');

  assert.throws(() => h.accessibility.prepare(plan(h, { detectedVersion: '26.9.0' })), /APP_VERSION_UNSUPPORTED/);
  assert.throws(() => h.accessibility.prepare(plan(h, { actions: ['PRESS_SEND'] })), /ACTION_NOT_ALLOWLISTED/);

  const reasoner = new FakeDeviceUIReasoner([proposal({ action: 'FIND_ELEMENT', semanticTarget: 'search', targetNodeRef: 'kakao_search_entry' })]);
  const astraProposal = await reasoner.reason(reasoningInput(h, { allowedActions: ['FIND_ELEMENT', 'WAIT'] }));
  const gate = new DeviceUIActionGate();
  const gated = gate.validate(reasoningInput(h, { allowedActions: ['FIND_ELEMENT', 'WAIT'] }), astraProposal);
  assert.equal(gated.decision, 'AUTHORIZED_ACTION');
  assert.equal(gated.authorizedAction, 'SEARCH_CONTACT');

  const send = gate.validate(reasoningInput(h, { allowedActions: ['REQUEST_SEND'] }), proposal({ action: 'REQUEST_SEND' }));
  assert.equal(send.decision, 'BLOCKED');
  assert.equal(send.reasonCode, 'ACTION_NOT_ALLOWLISTED');
});
