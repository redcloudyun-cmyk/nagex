import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuditLogger } from '../src/governance/audit.logger.js';
import { ActionApprovalStore } from '../src/governance/action-approval.store.js';
import { MemoryEngine } from '../src/context/memory.engine.js';
import { InMemoryGoogleOAuthTokenStore } from '../src/integrations/google/token.store.js';
import { GOOGLE_OAUTH_SCOPES, type GoogleOAuthConfig } from '../src/integrations/google/oauth.client.js';
import { GmailService, GMAIL_CREATE_DRAFT_TOOL_ID } from '../src/modules/gmail/index.js';
import { GmailEmailExecutionAdapter } from '../src/messaging/gmail-email-execution-adapter.js';
import { buildGmailApprovalBinding, GMAIL_EMAIL_EXECUTION_CAPABILITY, mapGmailCanonicalResult } from '../src/messaging/gmail-canonical-mapping.js';
import { assertRuntimeMessagingEvidence } from '../src/messaging/messaging-capability-registry.js';
import type { SendMessageAction } from '../src/messaging/send-message-action.types.js';
import type { SendEmailAction } from '../src/messaging/send-email-action.types.js';

const config: GoogleOAuthConfig = { clientId: 'cid', clientSecret: 'secret', redirectUri: 'https://example.test/oauth' };
const scopes = GOOGLE_OAUTH_SCOPES.join(' ');

function harness() {
  const tokenStore = new InMemoryGoogleOAuthTokenStore();
  tokenStore.saveForPrincipal('ten', 'usr', { accessToken: 'oauth-access-canary', refreshToken: 'refresh-a', expiresAt: Date.now() + 60_000, scope: scopes });
  const approvals = new ActionApprovalStore();
  const service = new GmailService(tokenStore, approvals, new AuditLogger(), new MemoryEngine(), async () => new Response(JSON.stringify({ id: 'gmail-message-1', threadId: 'gmail-thread-1' }), { status: 200 }), () => config);
  const adapter = new GmailEmailExecutionAdapter(service);
  const action: SendEmailAction = {
    canonicalAction: 'SEND_EMAIL', tenantId: 'ten', ownerId: 'usr', requestId: 'req', providerAccountRef: service.getProviderAccountRef('ten', 'usr', 'req'),
    displayIdentity: 'sender@example.com', to: ['to@example.com'], cc: ['cc@example.com'], bcc: ['bcc@example.com'], subject: 'Subject', body: 'Body', attachments: [],
  };
  return { tokenStore, approvals, service, adapter, action };
}

test('A-E: SEND_EMAIL is distinct and Gmail capability is SERVER/GOOGLE/GMAIL_API/AUTONOMOUS_VERIFIED', () => {
  const message: SendMessageAction = { recipientRef: 'recipient', message: 'hello', tenantId: 'ten', ownerId: 'usr', deviceId: 'dev', locale: 'en', requestId: 'req' };
  const { action } = harness();
  assert.equal(action.canonicalAction, 'SEND_EMAIL');
  assert.equal('canonicalAction' in message, false);
  assert.deepEqual({ environment: GMAIL_EMAIL_EXECUTION_CAPABILITY.environment, provider: GMAIL_EMAIL_EXECUTION_CAPABILITY.provider, route: GMAIL_EMAIL_EXECUTION_CAPABILITY.executionRoute, mode: GMAIL_EMAIL_EXECUTION_CAPABILITY.executionMode }, { environment: 'SERVER', provider: 'GOOGLE', route: 'GMAIL_API', mode: 'AUTONOMOUS_VERIFIED' });
});

test('F-I: real Gmail success maps only to PROVIDER_ACCEPTED with API and message-id evidence', async () => {
  const { service, adapter, action } = harness();
  const requested = adapter.requestApproval(action);
  service.approve(requested.approval.approvalId, 'ten', 'usr', 'approve');
  const result = await adapter.executeApproved(action, requested.approval.approvalId, requested.approval.canonicalPayload);
  assert.equal(result.status, 'PROVIDER_ACCEPTED');
  assert.deepEqual(result.evidence.map((item) => item.evidenceType), ['PROVIDER_API_RESPONSE', 'PROVIDER_MESSAGE_ID']);
  assert.equal(result.evidence[1]?.providerMessageId, 'gmail-message-1');
  assert.notEqual(result.status as string, 'DELIVERY_CONFIRMED');
  assert.notEqual(result.status as string, 'READ_CONFIRMED');
});

test('J: provider-account drift rotates authority and requires fresh approval', async () => {
  const { tokenStore, service, adapter, action } = harness();
  const requested = adapter.requestApproval(action);
  service.approve(requested.approval.approvalId, 'ten', 'usr', 'approve');
  tokenStore.saveForPrincipal('ten', 'usr', { accessToken: 'new-access', refreshToken: 'refresh-b', expiresAt: Date.now() + 60_000, scope: scopes });
  await assert.rejects(() => adapter.executeApproved(action, requested.approval.approvalId, requested.approval.canonicalPayload), (error: unknown) => (error as { code: string }).code === 'REAPPROVAL_REQUIRED');
});

test('legacy Gmail approval cannot execute under D4B binding and never reaches Gmail API', async () => {
  let gmailApiCalls = 0;
  const tokenStore = new InMemoryGoogleOAuthTokenStore();
  tokenStore.saveForPrincipal('ten', 'usr', { accessToken: 'access', refreshToken: 'refresh', expiresAt: Date.now() + 60_000, scope: scopes });
  const approvals = new ActionApprovalStore();
  const service = new GmailService(tokenStore, approvals, new AuditLogger(), new MemoryEngine(), async () => { gmailApiCalls += 1; return new Response(JSON.stringify({ id: 'must-not-exist', threadId: 'must-not-exist' }), { status: 200 }); }, () => config);
  const legacyPayload = { from: 'me', to: ['to@example.com'], cc: [], bcc: [], subject: 'Legacy', body: 'Legacy body', attachments: [], threadId: null, replyToMessageId: null };
  const legacy = approvals.request({ toolId: 'gmail.send_email', tenantId: 'ten', principalId: 'usr', payload: legacyPayload });
  approvals.approve(legacy.approvalId, 'ten', 'usr', 'approve');
  await assert.rejects(() => service.executeSendEmail({ approvalId: legacy.approvalId, payload: legacy.canonicalPayload, tenantId: 'ten', principalId: 'usr', requestId: 'execute' }), (error: unknown) => (error as { code: string }).code === 'REAPPROVAL_REQUIRED');
  assert.equal(gmailApiCalls, 0);
  assert.equal(approvals.get(legacy.approvalId, 'ten', 'usr')?.status, 'APPROVED');
});

test('K-O: recipient, subject, body, attachment, and reply/thread changes alter the approval binding', () => {
  const { action } = harness();
  const original = buildGmailApprovalBinding(action);
  const drifts: SendEmailAction[] = [
    { ...action, to: ['other@example.com'] }, { ...action, subject: 'Other' }, { ...action, body: 'Other' },
    { ...action, attachments: [{ filename: 'a.txt', mimeType: 'text/plain', sizeBytes: 1 }] },
    { ...action, replyContext: { threadId: 'thread-other', replyToMessageId: 'message-other' } },
  ];
  for (const drift of drifts) assert.notDeepEqual(buildGmailApprovalBinding(drift), original);
});

test('P: create_draft remains outside SEND_EMAIL canonical success', () => {
  const { service } = harness();
  const draft = service.requestApproval({ toolId: GMAIL_CREATE_DRAFT_TOOL_ID, tenantId: 'ten', principalId: 'usr', requestId: 'draft', payload: { from: 'me', to: ['to@example.com'], cc: [], bcc: [], subject: 'Draft', body: 'Body', attachments: [], threadId: null, replyToMessageId: null } });
  assert.equal(draft.toolId, 'gmail.create_draft');
  assert.equal(draft.canonicalPayload.canonicalAction, undefined);
});

test('Q: synthetic Gmail success is rejected as runtime evidence', () => {
  assert.throws(() => assertRuntimeMessagingEvidence({ evidenceType: 'PROVIDER_API_RESPONSE', evidenceSource: 'GMAIL_TEST_DOUBLE', observedAt: new Date().toISOString(), synthetic: true }));
});

test('R: canonical approval/result contain account reference but no OAuth credential', () => {
  const { adapter, action } = harness();
  const requested = adapter.requestApproval(action);
  const mapped = mapGmailCanonicalResult(action, { executionId: 'exe', toolId: 'gmail.send_email', status: 'SUCCEEDED', externalId: 'msg', externalUrl: 'https://mail.google.com/msg', startedAt: '2026-09-28T00:00:00.000Z', completedAt: '2026-09-28T00:00:01.000Z' });
  const serialized = JSON.stringify({ approval: requested.approval, result: mapped });
  assert.match(serialized, /gacct_/);
  assert.doesNotMatch(serialized, /oauth-access-canary|refresh-a/);
});

test('unsupported attachment upload fails truthfully before approval', () => {
  const { adapter, action } = harness();
  assert.throws(() => adapter.requestApproval({ ...action, attachments: [{ filename: 'a.txt', mimeType: 'text/plain', sizeBytes: 1 }] }), (error: unknown) => (error as { code: string }).code === 'ATTACHMENTS_UNSUPPORTED');
});
