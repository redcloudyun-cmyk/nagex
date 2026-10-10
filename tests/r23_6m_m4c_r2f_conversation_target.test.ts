import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConversationTargetStore } from '../src/mobile/conversation-target.store.js';
import { isExecutableConversationTarget } from '../src/mobile/conversation-target.types.js';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-cvr-'));
}

function store(): ConversationTargetStore {
  return new ConversationTargetStore({ dir: tmp(), now: () => '2026-10-08T00:00:00.000Z' });
}

const base = {
  tenantId: 'ten',
  ownerId: 'usr',
  deviceId: 'dev',
  provider: 'KAKAOTALK' as const,
  targetType: 'DIRECT' as const,
  recipientRef: 'rcp_server_minted',
  providerDisplayName: '조민형 (Blue Dia/Mini)',
  conversationTitle: '조민형 (Blue Dia/Mini)',
  participantHints: ['조민형'],
};

function expectCode(fn: () => unknown, code: string) {
  assert.throws(fn, (error: unknown) => (error as { code?: string }).code === code);
}

test('M4C-R2F server alone mints opaque cvr_* and caller cannot choose conversationRef', () => {
  const s = store();
  const record = s.mintOrReuse({ ...base, conversationRef: 'caller_supplied' } as unknown as typeof base);
  assert.match(record.conversationRef, /^cvr_[a-f0-9]{16}$/);
  assert.notEqual(record.conversationRef, 'caller_supplied');
  assert.equal(record.provider, 'KAKAOTALK');
});

test('M4C-R2F tenant owner and device mismatches are rejected by getOwned', () => {
  const s = store();
  const record = s.mintOrReuse(base);
  assert.equal(s.getOwned(record.conversationRef, 'other', 'usr', 'dev'), null);
  assert.equal(s.getOwned(record.conversationRef, 'ten', 'other', 'dev'), null);
  assert.equal(s.getOwned(record.conversationRef, 'ten', 'usr', 'other'), null);
  assert.equal(s.getOwned(record.conversationRef, 'ten', 'usr', 'dev')?.conversationRef, record.conversationRef);
});

test('M4C-R2F same canonical target reuses ref and different target gets a different ref', () => {
  const s = store();
  const first = s.mintOrReuse({ ...base, participantHints: [' 조민형 ', 'Blue Dia'] });
  const same = s.mintOrReuse({ ...base, participantHints: ['blue dia', '조민형'] });
  const different = s.mintOrReuse({ ...base, providerDisplayName: '조민형 (Other)', conversationTitle: '조민형 (Other)' });
  assert.equal(same.conversationRef, first.conversationRef);
  assert.notEqual(different.conversationRef, first.conversationRef);
  assert.notEqual(different.identityFingerprint, first.identityFingerprint);
});

test('M4C-R2F DIRECT requires recipientRef and non-direct targets cannot inherit it', () => {
  const s = store();
  expectCode(() => s.mintOrReuse({ ...base, recipientRef: undefined }), 'DIRECT_CONVERSATION_REQUIRES_RECIPIENT_REF');
  expectCode(() => s.mintOrReuse({ ...base, targetType: 'GROUP', recipientRef: 'rcp_wrong' }), 'NON_DIRECT_CONVERSATION_FORBIDS_RECIPIENT_REF');
  const group = s.mintOrReuse({ ...base, targetType: 'GROUP', recipientRef: undefined, conversationTitle: '조민형 프로젝트방', participantHints: ['조민형', '김철수'] });
  assert.equal(group.recipientRef, undefined);
});

test('M4C-R2F UNKNOWN is non-executable', () => {
  const s = store();
  const unknown = s.mintOrReuse({ ...base, targetType: 'UNKNOWN', recipientRef: undefined, conversationTitle: 'ambiguous', participantHints: [] });
  assert.equal(isExecutableConversationTarget(unknown), false);
  expectCode(() => s.requireExecutable(unknown, 'req_unknown'), 'CONVERSATION_TARGET_NOT_EXECUTABLE');
});

test('M4C-R2F identity change produces new binding and post-selection re-resolution requirement', () => {
  const s = store();
  const record = s.mintOrReuse(base);
  const changed = s.mintOrReuse({ ...base, providerDisplayName: '조민형 (Changed)', conversationTitle: '조민형 (Changed)' });
  assert.notEqual(changed.conversationRef, record.conversationRef);

  assert.equal(s.verifyPostSelection({
    conversationRef: record.conversationRef,
    tenantId: 'ten',
    ownerId: 'usr',
    deviceId: 'dev',
    observedPackage: 'com.kakao.talk',
    observed: base,
    requestId: 'req_verify',
  }).conversationRef, record.conversationRef);

  expectCode(() => s.verifyPostSelection({
    conversationRef: record.conversationRef,
    tenantId: 'ten',
    ownerId: 'usr',
    deviceId: 'dev',
    observedPackage: 'com.kakao.talk',
    observed: { ...base, providerDisplayName: '조민형 (Changed)', conversationTitle: '조민형 (Changed)' },
    requestId: 'req_verify_changed',
  }), 'CONVERSATION_TARGET_MISMATCH_REQUIRES_RERESOLUTION');

  expectCode(() => s.verifyPostSelection({
    conversationRef: record.conversationRef,
    tenantId: 'ten',
    ownerId: 'usr',
    deviceId: 'dev',
    observedPackage: 'com.other',
    observed: base,
    requestId: 'req_verify_pkg',
  }), 'CONVERSATION_PACKAGE_MISMATCH');
});

test('M4C-R2F Android accessibility safety invariants remain closed', () => {
  const service = fs.readFileSync('mobile-android/app/src/main/java/com/nagex/mobile/NagexAccessibilityExecutionService.kt', 'utf8');
  assert.match(service, /KAKAOTALK_GOVERNED_SEND/);
  assert.match(service, /"com\.kakao\.talk"/);
  assert.doesNotMatch(service, /dispatchGesture|GestureDescription|RAW_TAP|SHELL|ARBITRARY_INTENT|ACTION_ARGUMENT_MOVE_WINDOW_X|ACTION_ARGUMENT_MOVE_WINDOW_Y/);
});

test('M4C-R2G DIRECT selection is classifier-bound and not generic visible-text clicking', () => {
  const service = fs.readFileSync('mobile-android/app/src/main/java/com/nagex/mobile/NagexAccessibilityExecutionService.kt', 'utf8');
  assert.match(service, /selectUniqueKakaoDirectConversation\(expectedProviderDisplayName: String\)/);
  assert.match(service, /KakaoTalkConversationClassifier\(\)/);
  assert.match(service, /resolveDirect\(root, expectedProviderDisplayName\)/);
  assert.match(service, /candidate\.clickableNode\s*\?:\s*return null/);
  assert.match(service, /activationNode\.node\.performAction\(AccessibilityNodeInfo\.ACTION_CLICK\)/);
  assert.match(service, /"SELECT_KAKAO_DIRECT_CONVERSATION"/);
  const selectBranch = service.match(/"SELECT_KAKAO_DIRECT_CONVERSATION" -> \{[\s\S]*?^\s*\}/m)?.[0] ?? '';
  assert.match(selectBranch, /selectUniqueKakaoDirectConversation\(expectedProviderDisplayName\)/);
  assert.doesNotMatch(selectBranch, /target\.visibleText|findFirstWithRetry|performAction/);
});

test('M4C-R2G accessibility plan wiring carries expectedProviderDisplayName to Android dispatcher', () => {
  const route = fs.readFileSync('src/http/routes/device-agent.routes.ts', 'utf8');
  const protocol = fs.readFileSync('src/device-agent/device-agent-protocol.ts', 'utf8');
  const dispatcher = fs.readFileSync('mobile-android/app/src/main/java/com/nagex/mobile/AccessibilityExecutionPlanDispatcher.kt', 'utf8');
  const payload = fs.readFileSync('mobile-android/app/src/main/java/com/nagex/mobile/DeviceAgentPayload.kt', 'utf8');

  assert.match(protocol, /'ACCESSIBILITY_EXECUTE_PLAN'/);
  assert.match(route, /\/api\/v1\/device-agent\/accessibility-plans/);
  assert.match(route, /expectedProviderDisplayName/);
  assert.match(route, /SELECT_KAKAO_DIRECT_CONVERSATION/);
  assert.match(dispatcher, /expectedProviderDisplayName/);
  assert.match(dispatcher, /executeBoundedAction\([\s\S]*SELECT_KAKAO_DIRECT_CONVERSATION[\s\S]*expectedProviderDisplayName = expectedProviderDisplayName/s);
  assert.match(payload, /accessibilitySelectKakaoDirectConversation/);
  assert.match(payload, /expectedProviderDisplayName/);
});
