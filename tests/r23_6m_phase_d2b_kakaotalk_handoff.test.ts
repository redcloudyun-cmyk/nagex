import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ActionApprovalStore } from '../src/governance/action-approval.store.js';
import { AuditLogger } from '../src/governance/audit.logger.js';
import { ExecutionRouteResolver } from '../src/messaging/execution-route-resolver.js';
import { KakaoTalkHandoffAdapter } from '../src/messaging/kakaotalk-handoff-adapter.js';
import { MessagingAdapterRegistry } from '../src/messaging/messaging-adapter-registry.js';
import { MessagingHandoffRunStore } from '../src/messaging/messaging-handoff-run.store.js';
import { KAKAOTALK_SHARE_CAPABILITIES, MessagingHandoffService } from '../src/messaging/messaging-handoff.service.js';
import { SmsMessagingAdapter } from '../src/messaging/sms-messaging-adapter.js';
import { MobileMessageRunService } from '../src/mobile/mobile-message-run.service.js';
import { MobileMessageRunStore } from '../src/mobile/mobile-message-run.store.js';
import { RecipientRefStore } from '../src/mobile/recipient-ref.store.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-d2b-'));
function harness() {
  const approvals = new ActionApprovalStore();
  const store = new MessagingHandoffRunStore({ dir: tmp() });
  const recipients = new RecipientRefStore({ dir: tmp() });
  const audit = new AuditLogger();
  const intended = recipients.mintOrReuse({ tenantId: 'ten', ownerId: 'usr', deviceId: 'dev', androidContactId: 'contact', displayName: 'Intended Person' });
  const service = new MessagingHandoffService(store, approvals, recipients, audit);
  const sms = new MobileMessageRunService(new MobileMessageRunStore({ dir: tmp() }), recipients, approvals);
  const registry = new MessagingAdapterRegistry();
  registry.register(new SmsMessagingAdapter(sms)); registry.register(new KakaoTalkHandoffAdapter(service));
  const action = { recipientRef: intended.recipientRef, message: 'approved exact text', preferredChannel: 'KAKAOTALK' as const, tenantId: 'ten', ownerId: 'usr', deviceId: 'dev', locale: 'ko-KR', requestId: 'req' };
  return { approvals, audit, store, service, registry, resolver: new ExecutionRouteResolver(registry), action };
}
function approve(h: ReturnType<typeof harness>) {
  let run = h.service.createReady(h.action); run = h.service.requestApproval(run.runId, 'ten', 'usr', 'req2');
  h.approvals.approve(run.approvalId!, 'ten', 'usr', 'req3'); run = h.service.confirmApproval(run.runId, 'ten', 'usr', 'req4'); return run;
}

test('D2B A/B/C/K/L/P. explicit KakaoTalk selects truthful human handoff capabilities, never SMS or confirmed send', async () => {
  const h = harness(); const resolved = await h.resolver.resolve(h.action);
  assert.equal(resolved.channel, 'KAKAOTALK'); assert.equal(resolved.route, 'KAKAOTALK_SHARE');
  assert.deepEqual(resolved.capabilities, KAKAOTALK_SHARE_CAPABILITIES);
  assert.equal(resolved.capabilities.recipientEnforced, false); assert.equal(resolved.capabilities.completionVerifiable, false);
  assert.equal(resolved.capabilities.requiresHumanCompletion, true);
});

test('D2B D/E. official and Accessibility routes are absent and cannot be selected', () => {
  const source = fs.readFileSync('src/messaging/send-message-action.types.ts', 'utf8');
  assert.match(source, /KAKAOTALK_OFFICIAL_MESSAGE_API/);
  assert.doesNotMatch(source, /ACCESSIBILITY/i);
  assert.equal(harness().registry.listRegisteredChannels().filter((c) => c === 'KAKAOTALK').length, 1);
});

test('D2B F/O. APPROVED_MESSAGE_EQUALS_HANDOFF_EXTRA_TEXT and intended recipient is bound but explicitly not enforced', () => {
  const h = harness(); const run = approve(h);
  const authorized = h.service.authorizeHandoff(run.runId, 'ten', 'usr', 'dev', 'req5');
  assert.equal(authorized.message, h.action.message);
  const approval = h.approvals.get(run.approvalId!, 'ten', 'usr')!;
  assert.equal(approval.canonicalPayload.intendedRecipientRef, h.action.recipientRef);
  assert.equal(run.routeCapabilities.recipientEnforced, false);
});

test('D2B G/H. route or channel drift after approval requires reapproval', () => {
  for (const patch of [{ executionRoute: 'KAKAOTALK_MANUAL' }, { channel: 'SMS' }]) {
    const h = harness(); const run = approve(h); h.store.save({ ...run, ...patch } as typeof run);
    assert.throws(() => h.service.authorizeHandoff(run.runId, 'ten', 'usr', 'dev', 'req_drift'), /reapproval is required/i);
    assert.equal(h.service.getOwned(run.runId, 'ten', 'usr', 'req').status, 'APPROVAL_REQUIRED');
  }
});

test('D2B M/N. Share ends at NEEDS_HUMAN; returning or elapsed time cannot confirm send', () => {
  const h = harness(); const run = approve(h); h.service.authorizeHandoff(run.runId, 'ten', 'usr', 'dev', 'req5');
  const needsHuman = h.service.reportHandoffStarted(run.runId, 'ten', 'usr', 'dev', 'req6');
  assert.equal(needsHuman.status, 'NEEDS_HUMAN');
  assert.throws(() => h.service.reportHandoffStarted(run.runId, 'ten', 'usr', 'dev', 'return_to_nagex'));
  assert.equal(h.service.getOwned(run.runId, 'ten', 'usr', 'later').status, 'NEEDS_HUMAN');
});

test('D2B I/J. SMS adapter remains autonomous verified and Android handoff contains no automation', () => {
  const h = harness(); const sms = h.registry.get('SMS')!;
  assert.deepEqual(sms.getRouteCapabilities(h.action), { executionMode: 'AUTONOMOUS_VERIFIED', recipientEnforced: true, messageEnforced: true, completionVerifiable: true, requiresHumanCompletion: false });
  const android = fs.readFileSync('mobile-android/app/src/main/java/com/nagex/mobile/KakaoTalkHandoffExecutor.kt', 'utf8');
  assert.match(android, /Intent\.EXTRA_TEXT/); assert.doesNotMatch(android, /Accessibility|performAction|click|SENT_CONFIRMED/i);
  const compose = fs.readFileSync('mobile-android/app/src/main/java/com/nagex/mobile/MessageComposeActivity.kt', 'utf8');
  assert.match(compose, /cannot select or enforce the chat recipient/);
  assert.match(compose, /cannot confirm sending/);
  assert.match(compose, /send manually/);
});

test('D2B approval and handoff audit records intended recipient and truthful enforcement limits without message content', () => {
  const h = harness(); const run = approve(h);
  h.service.authorizeHandoff(run.runId, 'ten', 'usr', 'dev', 'req5');
  h.service.reportHandoffStarted(run.runId, 'ten', 'usr', 'dev', 'req6');
  const logs = h.audit.getAuditLogs('ten');
  assert.ok(logs.some((log) => log.action === 'messaging.handoff.approval_requested'));
  const handoff = logs.find((log) => log.action === 'messaging.handoff.needs_human')!;
  assert.equal(handoff.details?.intendedRecipientRef, h.action.recipientRef);
  assert.equal(handoff.details?.recipientEnforced, false);
  assert.equal(handoff.details?.messageEnforced, false);
  assert.doesNotMatch(JSON.stringify(logs), /approved exact text/);
});
