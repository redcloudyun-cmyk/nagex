import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NagexError } from '../src/common/errors.js';
import { ActionApprovalStore } from '../src/governance/action-approval.store.js';
import { ExecutionRouteResolver } from '../src/messaging/execution-route-resolver.js';
import { MessagingAdapterRegistry } from '../src/messaging/messaging-adapter-registry.js';
import { parseOptionalMessagingChannel } from '../src/messaging/messaging-channel.js';
import { SmsMessagingAdapter } from '../src/messaging/sms-messaging-adapter.js';
import { MessagingHandoffRunStore } from '../src/messaging/messaging-handoff-run.store.js';
import { MessagingHandoffService } from '../src/messaging/messaging-handoff.service.js';
import { KakaoTalkHandoffAdapter } from '../src/messaging/kakaotalk-handoff-adapter.js';
import type { SendMessageAction } from '../src/messaging/send-message-action.types.js';
import { MobileMessageRunService } from '../src/mobile/mobile-message-run.service.js';
import { MobileMessageRunStore } from '../src/mobile/mobile-message-run.store.js';
import { RecipientRefStore } from '../src/mobile/recipient-ref.store.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-r23-6m-d1-'));
}

function harness() {
  const runStore = new MobileMessageRunStore({ dir: tempDir() });
  const recipientRefs = new RecipientRefStore({ dir: tempDir() });
  const approvals = new ActionApprovalStore();
  const service = new MobileMessageRunService(runStore, recipientRefs, approvals);
  const adapter = new SmsMessagingAdapter(service);
  const registry = new MessagingAdapterRegistry();
  registry.register(adapter);
  const handoffs = new MessagingHandoffService(new MessagingHandoffRunStore({ dir: tempDir() }), approvals, recipientRefs);
  registry.register(new KakaoTalkHandoffAdapter(handoffs));
  const resolver = new ExecutionRouteResolver(registry);
  const recipient = recipientRefs.mintOrReuse({ tenantId: 'ten_a', ownerId: 'usr_a', deviceId: 'dev_a', androidContactId: 'contact_a', displayName: 'Alex' });
  const action: SendMessageAction = { recipientRef: recipient.recipientRef, message: 'hello', tenantId: 'ten_a', ownerId: 'usr_a', deviceId: 'dev_a', locale: 'en-US', requestId: 'req_a' };
  return { approvals, service, adapter, registry, resolver, action };
}

test('R23.6M-D1 regression. SMS remains the default autonomous route after later adapters are added', async () => {
  const h = harness();
  assert.equal(h.registry.isRegistered('SMS'), true);
  const resolved = await h.resolver.resolve(h.action);
  assert.equal(resolved.channel, 'SMS');
  assert.equal(resolved.route, 'ANDROID_SMS_MANAGER');
  assert.throws(
    () => parseOptionalMessagingChannel('WHATSAPP', 'req_unknown'),
    (error: unknown) => error instanceof NagexError && error.code === 'MESSAGING_CHANNEL_UNSUPPORTED',
  );
});

test('R23.6M-D1 E-H. SMS adapter is a transparent async wrapper over the certified run service', async () => {
  const h = harness();
  let run = h.service.createDraft({ ...h.action });
  run = h.service.requestApproval(run.runId, 'ten_a', 'usr_a', 'req_approval');
  h.approvals.approve(run.approvalId!, 'ten_a', 'usr_a', 'req_approve');
  run = h.service.confirmApproval(run.runId, 'ten_a', 'usr_a', 'req_confirm');

  assert.deepEqual(await h.adapter.prepare(run.runId, 'ten_a', 'usr_a', 'dev_a', 'req_prepare'), { recipientRef: h.action.recipientRef, message: 'hello' });
  run = await h.adapter.executeApproved(run.runId, 'ten_a', 'usr_a', 'dev_a', 'req_execute');
  assert.equal(run.status, 'SEND_ATTEMPTED');
  run = await h.adapter.reportResult(run.runId, 'ten_a', 'usr_a', 'dev_a', 'req_result', 'SENT_CONFIRMED');
  assert.equal(run.status, 'SENT_CONFIRMED');
  assert.equal(run.channel, 'SMS');
  assert.equal(run.executionRoute, 'ANDROID_SMS_MANAGER');
});

test('R23.6M-D1 J-L. Phase C executable and approval contracts remain SMS-only and unchanged', () => {
  const mobileTypes = fs.readFileSync('src/mobile/mobile-message.types.ts', 'utf8');
  const runService = fs.readFileSync('src/mobile/mobile-message-run.service.ts', 'utf8');
  const adapter = fs.readFileSync('src/messaging/sms-messaging-adapter.ts', 'utf8');
  assert.match(mobileTypes, /MobileMessageChannel = 'SMS'/);
  assert.match(mobileTypes, /MobileMessageExecutionRoute = 'ANDROID_SMS_MANAGER'/);
  assert.match(runService, /buildApprovalPayload\(run\)/);
  assert.doesNotMatch(adapter.replace(/\/\/.*$/gm, ''), /buildApprovalPayload|approvalId|transitionTo|hashCanonicalPayload/);
});

test('R23.6M-D1 production call path wires route -> resolver -> registry -> SMS adapter', () => {
  const composition = fs.readFileSync('src/app/create-nagex-application.ts', 'utf8');
  const route = fs.readFileSync('src/http/routes/mobile-message.routes.ts', 'utf8');
  const server = fs.readFileSync('src/server_web.ts', 'utf8');
  assert.match(composition, /messagingAdapterRegistry\.register\(new SmsMessagingAdapter\(mobileMessageRunService\)\)/);
  assert.match(route, /await executionRouteResolver\.resolve\(/);
  assert.match(server, /handleMobileMessageRoutes[\s\S]*executionRouteResolver/);
});
