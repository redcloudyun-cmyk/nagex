import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const servicePath = path.join(root, 'mobile-android/app/src/main/java/com/nagex/mobile/NagexAccessibilityExecutionService.kt');
const approvalsRoutePath = path.join(root, 'src/http/routes/approvals.routes.ts');
const deviceAgentRoutePath = path.join(root, 'src/http/routes/device-agent.routes.ts');
const appJsPath = path.join(root, 'public/app.js');

function read(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

test('Device foreground recovery treats Launcher and unrelated apps as recoverable target-app activation context', () => {
  const source = read(servicePath);

  assert.match(source, /fun ensureTargetAppForeground\(targetPackage: String\): ActionResult/);
  assert.match(source, /packageManager\.getLaunchIntentForPackage\(targetPackage\)/);
  assert.match(source, /Intent\.FLAG_ACTIVITY_NEW_TASK/);
  assert.match(source, /"RECOVERABLE_FOREGROUND_CONTEXT"/);
  assert.match(source, /"com\.sec\.android\.app\.launcher"/);
  assert.match(source, /"com\.android\.settings"/);
  assert.match(source, /packageName == null \|\| packageName in RECOVERABLE_FOREGROUND_PACKAGES \|\| packageName !in FATAL_FOREGROUND_PACKAGES/);
});

test('Device root acquisition is retried before NO_ACTIVE_WINDOW is emitted for Kakao execution actions', () => {
  const source = read(servicePath);
  const actionEntry = source.slice(source.indexOf('fun executeBoundedAction'), source.indexOf('fun ensureTargetAppForeground'));

  assert.match(source, /private fun activeRootWithRetry\(maxAttempts: Int = 5, delayMs: Long = 200\)/);
  assert.match(source, /private fun waitForTargetRoot\(targetPackage: String\)/);
  assert.match(actionEntry, /requiresKakaoForegroundRecovery\(action\)[\s\S]*ensureTargetAppForeground\("com\.kakao\.talk"\)/);
  assert.match(actionEntry, /val root = activeRootWithRetry\(\) \?: return ActionResult\(false, "NO_ACTIVE_WINDOW"\)/);
  assert.doesNotMatch(actionEntry, /val root = rootInActiveWindow \?: return ActionResult\(false, "NO_ACTIVE_WINDOW"\)/);
});

test('SystemUI recovery backs out safely and does not consume send authority while recovering foreground', () => {
  const source = read(servicePath);
  const foreground = source.slice(source.indexOf('fun ensureTargetAppForeground'), source.indexOf('private fun requiresKakaoForegroundRecovery'));

  assert.match(foreground, /packageName == "com\.android\.systemui"/);
  assert.match(foreground, /performGlobalAction\(GLOBAL_ACTION_BACK\)/);
  assert.match(foreground, /return ActionResult\(false, "WAITING_FOR_PRECONDITION"\)/);
  assert.doesNotMatch(foreground, /REQUEST_SEND_APPROVAL|PRESS_SEND|usedAt|markUsed|consumeApproval/);
});

test('Right rail keeps the same approved card visible as Working during command creation gaps', () => {
  const route = read(approvalsRoutePath);
  const app = read(appJsPath);

  assert.match(route, /record\.status === 'APPROVED'[\s\S]*\? 'APPROVED'/);
  assert.match(route, /stage === 'APPROVED' \|\| stage === 'COMMAND_CREATED'/);
  assert.match(app, /if \(a\.status === 'APPROVED' \|\| status\.executing[\s\S]*return 'WORKING'/);
  assert.match(app, /WORKING: 'Working'/);
});

test('Recovery repair preserves fail-closed recipient and duplicate-send boundaries', () => {
  const source = read(servicePath);

  assert.match(source, /KAKAO_DIRECT_TARGET_IDENTITY_REQUIRED/);
  assert.match(source, /KAKAO_DIRECT_TARGET_AMBIGUOUS/);
  assert.match(source, /KAKAO_DIRECT_TARGET_NOT_FOUND/);
  assert.match(source, /if \(action == "PRESS_SEND" \|\| action == "REQUEST_SEND_APPROVAL"\) return ActionResult\(false, "SEND_ACTION_DISABLED_IN_M4C"\)/);
  assert.match(source, /if \(approvedText == null \|\| expectedMessageHash\.isNullOrBlank\(\)\) return ActionResult\(false, "KAKAO_SEND_MESSAGE_REQUIRED"\)/);
});

test('JIT SEND preparation can type and verify without requiring or consuming send approval', () => {
  const service = read(servicePath);
  const dispatcher = read(path.join(root, 'mobile-android/app/src/main/java/com/nagex/mobile/AccessibilityExecutionPlanDispatcher.kt'));
  const route = read(deviceAgentRoutePath);

  assert.match(service, /"KAKAOTALK_PREPARE_MESSAGE" ->/);
  assert.match(service, /"KAKAOTALK_SEARCH_TO_PREPARE_MESSAGE" ->/);
  assert.match(service, /private fun prepareKakaoSearchToMessage\(searchQuery: String, expectedProviderDisplayName: String, approvedText: String, expectedMessageHash: String\): ActionResult/);
  assert.match(service, /private fun prepareKakaoMessage\(expectedProviderDisplayName: String, approvedText: String, expectedMessageHash: String\): ActionResult/);
  assert.match(service, /return ActionResult\(true, "MESSAGE_PREPARED"\)/);
  assert.match(dispatcher, /stepAction != "KAKAOTALK_PREPARE_MESSAGE"/);
  assert.match(dispatcher, /stepAction != "KAKAOTALK_SEARCH_TO_PREPARE_MESSAGE"/);
  assert.match(route, /\/api\/v1\/device-agent\/accessibility-prepare-message-plans/);
  assert.match(route, /requiresSendApproval: false/);
  assert.doesNotMatch(route.slice(route.indexOf('/api/v1/device-agent/accessibility-prepare-message-plans')), /assertSendApprovalExecutable|consumeDraftApproval|consumeSendApproval/);
});
