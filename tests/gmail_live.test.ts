import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  InMemoryGoogleOAuthTokenStore,
  googleTokenStore as sharedGoogleTokenStore,
  DEFAULT_GOOGLE_TENANT_ID,
} from '../src/integrations/google/token.store.js';
import { GOOGLE_CALENDAR_SCOPES, GMAIL_SCOPES, GOOGLE_OAUTH_SCOPES, type GoogleOAuthConfig } from '../src/integrations/google/oauth.client.js';
import { ActionApprovalStore, hashCanonicalPayload } from '../src/governance/action-approval.store.js';
import { AuditLogger } from '../src/governance/audit.logger.js';
import { MemoryEngine } from '../src/context/memory.engine.js';
import { GmailService, GMAIL_SEND_EMAIL_TOOL_ID, GMAIL_REPLY_TOOL_ID, GMAIL_CREATE_DRAFT_TOOL_ID } from '../src/modules/gmail/index.js';
import { PlanResolver } from '../src/planning/plan-resolver.js';
import { skillRegistry } from '../src/skills/skill-registry.js';
import { toolRegistry as sharedToolRegistry } from '../src/tools/tool-registry.js';
import { handleApiRequest, handleAsyncApiRequest, actionApprovals as sharedActionApprovals } from '../src/server_web.js';
import { AiService, type PlanPreview } from '../src/model-gateway/ai-service.js';
import type { ModelProvider } from '../src/model-gateway/model-provider.js';
import { UnifiedModelRouter } from '../src/model-gateway/unified-model-router.js';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

const CALENDAR_ONLY_SCOPE_STRING = GOOGLE_CALENDAR_SCOPES.join(' ');
const FULL_SCOPE_STRING = GOOGLE_OAUTH_SCOPES.join(' ');
const config: GoogleOAuthConfig = { clientId: 'cid', clientSecret: 'csecret', redirectUri: 'https://nagex-test.agex.site/api/v1/oauth/google/callback' };

function validSendPayload(overrides: Record<string, unknown> = {}) {
  return {
    from: 'me',
    to: ['client@example.com'],
    cc: [],
    bcc: [],
    subject: 'Quarterly Update',
    body: 'Here is the update we discussed.',
    attachments: [],
    threadId: null,
    replyToMessageId: null,
    ...overrides,
  };
}

function validReplyPayload(overrides: Record<string, unknown> = {}) {
  return validSendPayload({ threadId: 'thread_123', replyToMessageId: '<msg-abc@mail.gmail.com>', ...overrides });
}

function buildHarness(fetchFn: typeof fetch, now: () => number = Date.now) {
  const tokenStore = new InMemoryGoogleOAuthTokenStore();
  const approvals = new ActionApprovalStore(now);
  const audit = new AuditLogger();
  const memory = new MemoryEngine();
  const service = new GmailService(tokenStore, approvals, audit, memory, fetchFn, () => config);
  return { tokenStore, approvals, audit, memory, service };
}

// ── OAuth scope status ──────────────────────────────────────────────────────

test('OAuth scope status: a Calendar-only connection does not carry the gmail.modify scope', async () => {
  const fetchFn: typeof fetch = async () => jsonResponse({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: CALENDAR_ONLY_SCOPE_STRING });
  const tokenStore = new InMemoryGoogleOAuthTokenStore();
  tokenStore.save('t1', { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: CALENDAR_ONLY_SCOPE_STRING });
  const status = tokenStore.getStatus('t1');
  assert.equal(status.connected, true);
  assert.ok(!status.scopes.includes(GMAIL_SCOPES[0]));
  void fetchFn;
});

test('OAuth scope status: a full connection carries both Calendar and Gmail scopes', () => {
  const tokenStore = new InMemoryGoogleOAuthTokenStore();
  tokenStore.save('t1', { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: FULL_SCOPE_STRING });
  const status = tokenStore.getStatus('t1');
  assert.ok(status.scopes.includes(GMAIL_SCOPES[0]));
  for (const scope of GOOGLE_CALENDAR_SCOPES) assert.ok(status.scopes.includes(scope));
});

// ── Gmail tool live/disconnected ────────────────────────────────────────────

test('Gmail tools report disconnected/unavailable with no OAuth connection at all', () => {
  sharedGoogleTokenStore.clear(DEFAULT_GOOGLE_TENANT_ID);
  for (const toolName of ['gmail.send_email', 'gmail.reply', 'gmail.create_draft', 'gmail.search', 'gmail.read_thread']) {
    const resolution = sharedToolRegistry.resolve(toolName);
    assert.equal(resolution.connectionStatus, 'disconnected', `expected ${toolName} disconnected`);
    assert.equal(resolution.executionMode, 'unavailable', `expected ${toolName} unavailable`);
  }
});

test('Gmail tools stay unavailable when Google is connected but WITHOUT the gmail.modify scope (Calendar-only)', () => {
  sharedGoogleTokenStore.save(DEFAULT_GOOGLE_TENANT_ID, { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: CALENDAR_ONLY_SCOPE_STRING });
  try {
    const resolution = sharedToolRegistry.resolve('gmail.send_email');
    assert.equal(resolution.connectionStatus, 'disconnected');
    assert.equal(resolution.executionMode, 'unavailable');
    // Calendar itself must remain live and unaffected — Gmail's own scope
    // gap must never weaken Calendar's status.
    const calendarResolution = sharedToolRegistry.resolve('Google Calendar');
    assert.equal(calendarResolution.executionMode, 'live');
  } finally {
    sharedGoogleTokenStore.clear(DEFAULT_GOOGLE_TENANT_ID);
  }
});

test('Gmail tools go LIVE once the connection carries the gmail.modify scope', () => {
  sharedGoogleTokenStore.save(DEFAULT_GOOGLE_TENANT_ID, { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: FULL_SCOPE_STRING });
  try {
    for (const toolName of ['gmail.send_email', 'gmail.reply', 'gmail.create_draft', 'gmail.search', 'gmail.read_thread']) {
      const resolution = sharedToolRegistry.resolve(toolName);
      assert.equal(resolution.connectionStatus, 'connected', `expected ${toolName} connected`);
      assert.equal(resolution.executionMode, 'live', `expected ${toolName} live`);
    }
    // Calendar remains live too — one connection covers both, and neither weakens the other.
    assert.equal(sharedToolRegistry.resolve('Google Calendar').executionMode, 'live');
  } finally {
    sharedGoogleTokenStore.clear(DEFAULT_GOOGLE_TENANT_ID);
  }
});

// ── approval required at plan resolution ────────────────────────────────────

test('approval required: a live gmail.send_email step always resolves to APPROVAL_REQUIRED', () => {
  sharedGoogleTokenStore.save(DEFAULT_GOOGLE_TENANT_ID, { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: FULL_SCOPE_STRING });
  try {
    const resolver = new PlanResolver(skillRegistry, sharedToolRegistry);
    const plan: PlanPreview = {
      goal: 'Email the client',
      summary: 'Send an update email.',
      reasoningSummary: 'Direct write action.',
      steps: [{ step: 1, title: 'Send email', reasoning: 'Notify the client.', skill: 'Email Drafting', tool: 'gmail.send_email', requiresApproval: false }],
    };
    const resolved = resolver.resolve(plan);
    assert.equal(resolved.status, 'APPROVAL_REQUIRED');
    assert.equal(resolved.steps[0].toolAvailability, 'AVAILABLE');
    assert.equal(resolved.steps[0].approvalRequired, true);
  } finally {
    sharedGoogleTokenStore.clear(DEFAULT_GOOGLE_TENANT_ID);
  }
});

test('search never requires approval, even when connected', () => {
  sharedGoogleTokenStore.save(DEFAULT_GOOGLE_TENANT_ID, { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: FULL_SCOPE_STRING });
  try {
    const resolution = sharedToolRegistry.resolve('gmail.search');
    assert.equal(resolution.sideEffectLevel, 'READ_ONLY');
    assert.equal(resolution.requiresApproval, false);
  } finally {
    sharedGoogleTokenStore.clear(DEFAULT_GOOGLE_TENANT_ID);
  }
});

// ── search / read thread (no approval) ──────────────────────────────────────

test('search: calls the Gmail threads.list API and returns normalized thread summaries', async () => {
  const fetchFn: typeof fetch = async (url) => {
    assert.match(String(url), /\/gmail\/v1\/users\/me\/threads\?q=/);
    return jsonResponse({ threads: [{ id: 'thread_1', snippet: 'Hi there' }], resultSizeEstimate: 1 });
  };
  const { tokenStore, service } = buildHarness(fetchFn);
  tokenStore.save('t1', { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: FULL_SCOPE_STRING });
  const result = await service.search({ tenantId: 't1', query: 'from:boss', requestId: 'req_1' });
  assert.deepEqual(result.threads, [{ threadId: 'thread_1', snippet: 'Hi there' }]);
});

test('read thread: calls the Gmail threads.get API and returns normalized messages', async () => {
  const fetchFn: typeof fetch = async (url) => {
    assert.match(String(url), /\/gmail\/v1\/users\/me\/threads\/thread_1$/);
    return jsonResponse({ id: 'thread_1', messages: [{ id: 'msg_1', snippet: 'Hello' }] });
  };
  const { tokenStore, service } = buildHarness(fetchFn);
  tokenStore.save('t1', { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: FULL_SCOPE_STRING });
  const result = await service.readThread({ tenantId: 't1', threadId: 'thread_1', requestId: 'req_1' });
  assert.equal(result.threadId, 'thread_1');
  assert.deepEqual(result.messages, [{ id: 'msg_1', snippet: 'Hello' }]);
});

test('search/read fail closed when Gmail is not connected', async () => {
  const fetchFn: typeof fetch = async () => { throw new Error('must not call Gmail when disconnected'); };
  const { service } = buildHarness(fetchFn); // tokenStore never connected
  await assert.rejects(() => service.search({ tenantId: 't1', query: 'x', requestId: 'req_1' }), (err: unknown) => (err as { code: string }).code === 'GMAIL_DISCONNECTED');
  await assert.rejects(() => service.readThread({ tenantId: 't1', threadId: 'thread_1', requestId: 'req_1' }), (err: unknown) => (err as { code: string }).code === 'GMAIL_DISCONNECTED');
});

// ── approval creation ────────────────────────────────────────────────────────

test('approval creation: requestApproval produces a PENDING record with the canonical fields', () => {
  const { service } = buildHarness(async () => { throw new Error('must not call Gmail during approval creation'); });
  const record = service.requestApproval({ toolId: GMAIL_SEND_EMAIL_TOOL_ID, tenantId: 't1', principalId: 'usr_1', payload: validSendPayload(), requestId: 'req_1' });
  assert.equal(record.status, 'PENDING');
  assert.equal(record.toolId, GMAIL_SEND_EMAIL_TOOL_ID);
  assert.equal(typeof record.payloadHash, 'string');
  assert.deepEqual(record.canonicalPayload.to, ['client@example.com']);
});

test('a reply approval requires both threadId and replyToMessageId', () => {
  const { service } = buildHarness(async () => { throw new Error('must not call Gmail'); });
  assert.throws(
    () => service.requestApproval({ toolId: GMAIL_REPLY_TOOL_ID, tenantId: 't1', principalId: 'usr_1', payload: validSendPayload(), requestId: 'req_1' }),
    /threadId and replyToMessageId/,
  );
  const record = service.requestApproval({ toolId: GMAIL_REPLY_TOOL_ID, tenantId: 't1', principalId: 'usr_1', payload: validReplyPayload(), requestId: 'req_2' });
  assert.equal(record.status, 'PENDING');
});

test('an unsupported toolId is rejected rather than silently accepted', () => {
  const { service } = buildHarness(async () => { throw new Error('must not call Gmail'); });
  assert.throws(
    () => service.requestApproval({ toolId: 'gmail.archive', tenantId: 't1', principalId: 'usr_1', payload: validSendPayload(), requestId: 'req_1' }),
    (err: unknown) => (err as { code: string }).code === 'UNSUPPORTED_APPROVAL_TOOL',
  );
});

test('payload validation: at least one valid "to" recipient and a non-empty body are required', () => {
  const { service } = buildHarness(async () => { throw new Error('must not call Gmail'); });
  assert.throws(() => service.requestApproval({ toolId: GMAIL_SEND_EMAIL_TOOL_ID, tenantId: 't1', principalId: 'usr_1', payload: validSendPayload({ to: [] }), requestId: 'req_1' }));
  assert.throws(() => service.requestApproval({ toolId: GMAIL_SEND_EMAIL_TOOL_ID, tenantId: 't1', principalId: 'usr_1', payload: validSendPayload({ to: ['not-an-email'] }), requestId: 'req_1' }));
  assert.throws(() => service.requestApproval({ toolId: GMAIL_SEND_EMAIL_TOOL_ID, tenantId: 't1', principalId: 'usr_1', payload: validSendPayload({ body: '' }), requestId: 'req_1' }));
});

// ── execution success / failure ─────────────────────────────────────────────

test('execution success: send returns a normalized SUCCEEDED result and never fakes success without calling Gmail', async () => {
  let calledSend = false;
  const fetchFn: typeof fetch = async (url) => {
    calledSend = true;
    assert.match(String(url), /\/gmail\/v1\/users\/me\/messages\/send/);
    return jsonResponse({ id: 'msg_sent_1', threadId: 'thread_sent_1' });
  };
  const { tokenStore, service, approvals } = buildHarness(fetchFn);
  tokenStore.save('t1', { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: FULL_SCOPE_STRING });

  const created = service.requestApproval({ toolId: GMAIL_SEND_EMAIL_TOOL_ID, tenantId: 't1', principalId: 'usr_1', payload: validSendPayload(), requestId: 'req_1' });
  service.approve(created.approvalId, 'usr_1', 'req_2');

  const result = await service.executeSendEmail({ approvalId: created.approvalId, payload: created.canonicalPayload, tenantId: 't1', principalId: 'usr_1', requestId: 'req_3' });
  assert.equal(calledSend, true);
  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(result.externalId, 'msg_sent_1');
  assert.match(result.externalUrl, /mail\.google\.com/);
  assert.equal(approvals.get(created.approvalId)?.status, 'CONSUMED');
});

test('execution provider error: a failing Gmail API call rejects and never returns a fake success', async () => {
  const fetchFn: typeof fetch = async () => jsonResponse({ error: { message: 'insufficient scope' } }, 403);
  const { tokenStore, service } = buildHarness(fetchFn);
  tokenStore.save('t1', { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: FULL_SCOPE_STRING });

  const created = service.requestApproval({ toolId: GMAIL_SEND_EMAIL_TOOL_ID, tenantId: 't1', principalId: 'usr_1', payload: validSendPayload(), requestId: 'req_1' });
  service.approve(created.approvalId, 'usr_1', 'req_2');

  await assert.rejects(() => service.executeSendEmail({ approvalId: created.approvalId, payload: created.canonicalPayload, tenantId: 't1', principalId: 'usr_1', requestId: 'req_3' }));
});

test('draft creation succeeds independently of send, and returns a Gmail drafts deep link', async () => {
  const fetchFn: typeof fetch = async (url) => {
    assert.match(String(url), /\/gmail\/v1\/users\/me\/drafts/);
    return jsonResponse({ id: 'draft_1', message: { id: 'msg_draft_1' } });
  };
  const { tokenStore, service } = buildHarness(fetchFn);
  tokenStore.save('t1', { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: FULL_SCOPE_STRING });

  const created = service.requestApproval({ toolId: GMAIL_CREATE_DRAFT_TOOL_ID, tenantId: 't1', principalId: 'usr_1', payload: validSendPayload(), requestId: 'req_1' });
  service.approve(created.approvalId, 'usr_1', 'req_2');
  const result = await service.executeCreateDraft({ approvalId: created.approvalId, payload: created.canonicalPayload, tenantId: 't1', principalId: 'usr_1', requestId: 'req_3' });
  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(result.externalId, 'draft_1');
});

test('reply succeeds and includes the thread context in the outgoing message', async () => {
  let capturedBody = '';
  const fetchFn: typeof fetch = async (url, init) => {
    capturedBody = String(init?.body ?? '');
    assert.match(String(url), /\/gmail\/v1\/users\/me\/messages\/send/);
    return jsonResponse({ id: 'msg_reply_1', threadId: 'thread_123' });
  };
  const { tokenStore, service } = buildHarness(fetchFn);
  tokenStore.save('t1', { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: FULL_SCOPE_STRING });

  const created = service.requestApproval({ toolId: GMAIL_REPLY_TOOL_ID, tenantId: 't1', principalId: 'usr_1', payload: validReplyPayload(), requestId: 'req_1' });
  service.approve(created.approvalId, 'usr_1', 'req_2');
  const result = await service.executeReply({ approvalId: created.approvalId, payload: created.canonicalPayload, tenantId: 't1', principalId: 'usr_1', requestId: 'req_3' });
  assert.equal(result.status, 'SUCCEEDED');
  assert.match(capturedBody, /"threadId":"thread_123"/);
});

// ── fail closed: mutation, expiry, rejection, replay, wrong tool, disconnected ──

test('modified payload rejection: executing with a changed field is rejected even with a valid approval', async () => {
  const { tokenStore, service } = buildHarness(async () => { throw new Error('must not reach Gmail with a tampered payload'); });
  tokenStore.save('t1', { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: FULL_SCOPE_STRING });

  const created = service.requestApproval({ toolId: GMAIL_SEND_EMAIL_TOOL_ID, tenantId: 't1', principalId: 'usr_1', payload: validSendPayload(), requestId: 'req_1' });
  service.approve(created.approvalId, 'usr_1', 'req_2');

  const tamperedPayload = { ...created.canonicalPayload, subject: 'Something else entirely' };
  await assert.rejects(
    () => service.executeSendEmail({ approvalId: created.approvalId, payload: tamperedPayload, tenantId: 't1', principalId: 'usr_1', requestId: 'req_3' }),
    (err: unknown) => (err as { code: string }).code === 'APPROVAL_PAYLOAD_MISMATCH',
  );
});

test('expired approval rejection: an approval past its TTL cannot be approved or consumed', () => {
  let clock = Date.now();
  const { service } = buildHarness(async () => { throw new Error('must not reach Gmail'); }, () => clock);
  const created = service.requestApproval({ toolId: GMAIL_SEND_EMAIL_TOOL_ID, tenantId: 't1', principalId: 'usr_1', payload: validSendPayload(), requestId: 'req_1' });
  clock += 16 * 60 * 1000; // past the default 15-minute TTL
  assert.throws(() => service.approve(created.approvalId, 'usr_1', 'req_2'), (err: unknown) => (err as { code: string }).code === 'APPROVAL_EXPIRED');
});

test('rejected approval rejection: a REJECTED approval can never be executed', async () => {
  const { tokenStore, service } = buildHarness(async () => { throw new Error('must not reach Gmail'); });
  tokenStore.save('t1', { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: FULL_SCOPE_STRING });
  const created = service.requestApproval({ toolId: GMAIL_SEND_EMAIL_TOOL_ID, tenantId: 't1', principalId: 'usr_1', payload: validSendPayload(), requestId: 'req_1' });
  service.reject(created.approvalId, 'usr_1', 'req_2');
  await assert.rejects(
    () => service.executeSendEmail({ approvalId: created.approvalId, payload: created.canonicalPayload, tenantId: 't1', principalId: 'usr_1', requestId: 'req_3' }),
    (err: unknown) => (err as { code: string }).code === 'APPROVAL_NOT_GRANTED',
  );
});

test('replay rejection: the same approval cannot send twice', async () => {
  const fetchFn: typeof fetch = async () => jsonResponse({ id: 'msg_1', threadId: 'thread_1' });
  const { tokenStore, service } = buildHarness(fetchFn);
  tokenStore.save('t1', { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: FULL_SCOPE_STRING });
  const created = service.requestApproval({ toolId: GMAIL_SEND_EMAIL_TOOL_ID, tenantId: 't1', principalId: 'usr_1', payload: validSendPayload(), requestId: 'req_1' });
  service.approve(created.approvalId, 'usr_1', 'req_2');

  const first = await service.executeSendEmail({ approvalId: created.approvalId, payload: created.canonicalPayload, tenantId: 't1', principalId: 'usr_1', requestId: 'req_3' });
  assert.equal(first.status, 'SUCCEEDED');

  await assert.rejects(
    () => service.executeSendEmail({ approvalId: created.approvalId, payload: created.canonicalPayload, tenantId: 't1', principalId: 'usr_1', requestId: 'req_4' }),
    (err: unknown) => (err as { code: string }).code === 'APPROVAL_ALREADY_CONSUMED',
  );
});

test('wrong tool rejection: a Calendar-approved record cannot execute a Gmail send, and vice versa', async () => {
  const { tokenStore, service, approvals } = buildHarness(async () => { throw new Error('must not reach Gmail'); });
  tokenStore.save('t1', { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: FULL_SCOPE_STRING });
  const calendarApproval = approvals.request({ toolId: 'google_calendar.create_event', tenantId: 't1', principalId: 'usr_1', payload: { summary: 'x' } });
  approvals.approve(calendarApproval.approvalId, 'req_2');
  await assert.rejects(
    () => service.executeSendEmail({ approvalId: calendarApproval.approvalId, payload: validSendPayload(), tenantId: 't1', principalId: 'usr_1', requestId: 'req_3' }),
    (err: unknown) => (err as { code: string }).code === 'APPROVAL_TOOL_MISMATCH',
  );
});

test('disconnected OAuth: execution is refused even with a valid, matching, approved payload', async () => {
  const { service } = buildHarness(async () => { throw new Error('must not reach Gmail when disconnected'); }); // tokenStore never connected
  const created = service.requestApproval({ toolId: GMAIL_SEND_EMAIL_TOOL_ID, tenantId: 't1', principalId: 'usr_1', payload: validSendPayload(), requestId: 'req_1' });
  service.approve(created.approvalId, 'usr_1', 'req_2');
  await assert.rejects(
    () => service.executeSendEmail({ approvalId: created.approvalId, payload: created.canonicalPayload, tenantId: 't1', principalId: 'usr_1', requestId: 'req_3' }),
    (err: unknown) => (err as { code: string }).code === 'GMAIL_DISCONNECTED',
  );
});

// ── audit: tokens are never logged, every stage is captured ────────────────

test('audit: every stage of the approval + execution lifecycle is logged, and no token/secret is ever included', async () => {
  const fetchFn: typeof fetch = async () => jsonResponse({ id: 'msg_audit', threadId: 'thread_audit' });
  const { tokenStore, service, audit } = buildHarness(fetchFn);
  tokenStore.save('t1', { accessToken: 'super-secret-access-token', refreshToken: 'super-secret-refresh-token', expiresAt: Date.now() + 3600_000, scope: FULL_SCOPE_STRING });

  const created = service.requestApproval({ toolId: GMAIL_SEND_EMAIL_TOOL_ID, tenantId: 't1', principalId: 'usr_1', payload: validSendPayload(), requestId: 'req_1' });
  service.approve(created.approvalId, 'usr_1', 'req_2');
  await service.executeSendEmail({ approvalId: created.approvalId, payload: created.canonicalPayload, tenantId: 't1', principalId: 'usr_1', requestId: 'req_3' });

  const actions = audit.getRecentLogs(10).map((e) => e.action).reverse();
  assert.deepEqual(actions, ['approval.requested', 'approval.approved', 'tool.execution.started', 'tool.execution.succeeded']);

  const serialized = JSON.stringify(audit.getRecentLogs(10));
  assert.doesNotMatch(serialized, /super-secret-access-token|super-secret-refresh-token/);
});

test('audit failure path: a rejected approval logs approval.rejected, and a failed execution logs tool.execution.failed', async () => {
  const { tokenStore, service, audit } = buildHarness(async () => jsonResponse({ error: { message: 'boom' } }, 500));
  tokenStore.save('t1', { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: FULL_SCOPE_STRING });

  const rejected = service.requestApproval({ toolId: GMAIL_SEND_EMAIL_TOOL_ID, tenantId: 't1', principalId: 'usr_1', payload: validSendPayload(), requestId: 'req_1' });
  service.reject(rejected.approvalId, 'usr_1', 'req_2');

  const forFailure = service.requestApproval({ toolId: GMAIL_SEND_EMAIL_TOOL_ID, tenantId: 't1', principalId: 'usr_1', payload: validSendPayload(), requestId: 'req_3' });
  service.approve(forFailure.approvalId, 'usr_1', 'req_4');
  await assert.rejects(() => service.executeSendEmail({ approvalId: forFailure.approvalId, payload: forFailure.canonicalPayload, tenantId: 't1', principalId: 'usr_1', requestId: 'req_5' }));

  const actions = audit.getRecentLogs(20).map((e) => e.action);
  assert.ok(actions.includes('approval.rejected'));
  assert.ok(actions.includes('tool.execution.failed'));
});

// ── real HTTP routes, shared server singletons, reusing the generic approval system ──

test('full flow through the real HTTP routes: POST /api/v1/approvals -> .../approve -> POST create-event-equivalent send, then replay is rejected', async () => {
  const payload = validSendPayload({ subject: 'NAgex Gmail Integration Test' });
  let calledSend = false;
  const mockFetch: typeof fetch = async (url) => {
    calledSend = true;
    assert.match(String(url), /\/gmail\/v1\/users\/me\/messages\/send/);
    return jsonResponse({ id: 'gmail_msg_flow', threadId: 'gmail_thread_flow' });
  };
  const testConfig: GoogleOAuthConfig = { clientId: 'x', clientSecret: 'y', redirectUri: 'https://nagex-test.agex.site/api/v1/oauth/google/callback' };
  const testGmailService = new GmailService(sharedGoogleTokenStore, sharedActionApprovals, new AuditLogger(), new MemoryEngine(), mockFetch, () => testConfig);

  sharedGoogleTokenStore.save(DEFAULT_GOOGLE_TENANT_ID, { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: FULL_SCOPE_STRING });
  try {
    const created = handleApiRequest('POST', '/api/v1/approvals', { toolId: GMAIL_SEND_EMAIL_TOOL_ID, payload });
    assert.equal(created.status, 201);
    const approvalId = (created.data as Record<string, unknown>).approvalId as string;
    assert.equal((created.data as Record<string, unknown>).status, 'PENDING');

    // GET /api/v1/approvals/:id and approve/reject already work generically
    // for any tool — no Gmail-specific route changes were needed for these.
    const fetched = handleApiRequest('GET', `/api/v1/approvals/${approvalId}`, null);
    assert.equal(fetched.status, 200);
    assert.equal((fetched.data as Record<string, unknown>).toolId, GMAIL_SEND_EMAIL_TOOL_ID);

    const approved = handleApiRequest('POST', `/api/v1/approvals/${approvalId}/approve`, null);
    assert.equal(approved.status, 200);
    assert.equal((approved.data as Record<string, unknown>).status, 'APPROVED');

    const executed = await handleAsyncApiRequest('POST', '/api/v1/tools/gmail/send-email', { approvalId, payload }, {}, undefined, {}, undefined, testGmailService);
    assert.equal(calledSend, true);
    assert.equal(executed.status, 200);
    const result = executed.data as Record<string, unknown>;
    assert.equal(result.status, 'SUCCEEDED');
    assert.equal(result.externalId, 'gmail_msg_flow');

    const replay = await handleAsyncApiRequest('POST', '/api/v1/tools/gmail/send-email', { approvalId, payload }, {}, undefined, {}, undefined, testGmailService);
    assert.notEqual(replay.status, 200);
    assert.equal((replay.data as { error: { code: string } }).error.code, 'APPROVAL_ALREADY_CONSUMED');
  } finally {
    sharedGoogleTokenStore.clear(DEFAULT_GOOGLE_TENANT_ID);
  }
});

test('POST /api/v1/approvals rejects an unsupported Gmail toolId rather than silently accepting it', () => {
  const result = handleApiRequest('POST', '/api/v1/approvals', { toolId: 'gmail.archive', payload: validSendPayload() });
  assert.notEqual(result.status, 201);
  assert.equal((result.data as { error: { code: string } }).error.code, 'UNSUPPORTED_APPROVAL_TOOL');
});

// ── task-triggered email still respects approval ────────────────────────────

function buildGmailPlanningService(): AiService {
  const provider: ModelProvider = {
    name: 'test',
    model: 'test-model',
    status: () => ({ configured: true, available: true, provider: 'test', model: 'test-model' }),
    generate: async (request) => ({
      text: JSON.stringify({
        goal: 'Send the quarterly update',
        summary: 'Email the client the quarterly update.',
        reasoningSummary: 'A recurring task objective that involves sending email.',
        suggestions: [],
        steps: [{ title: 'Send email', reasoning: 'Notify the client.', skill: 'Email Drafting', tool: 'gmail.send_email', requiresApproval: false, necessity: 'REQUIRED', dependsOn: [] }],
      }),
      provider: 'test',
      model: 'test-model',
      latencyMs: 1,
      requestId: request.requestId,
    }),
  };
  return new AiService(new UnifiedModelRouter([provider], { info: () => {}, warn: () => {} }));
}

test('task-triggered email still respects approval: a scheduled task whose objective resolves to gmail.send_email never auto-sends', async () => {
  const headers = { 'x-nagex-tenant': 'ten_production_01', 'x-principal-id': 'usr_gmail_task_test' };
  const created = handleApiRequest(
    'POST',
    '/api/v1/tasks',
    { name: 'Weekly client update', objective: 'Email the client the quarterly update.', type: 'ONE_TIME', trigger: { type: 'MANUAL' }, approvalPolicy: 'ALWAYS_APPROVE' },
    headers,
  );
  assert.equal(created.status, 201);
  const taskId = (created.data as { taskId: string }).taskId;

  const service = buildGmailPlanningService();
  // PlanPreviewTaskRunner (src/tasks/task.runner.ts) is constructed without
  // any reference to GmailService — it can only ever call AiService.plan()
  // and PlanResolver.resolve(). It is structurally incapable of sending an
  // email; this test proves the observable behavior matches that guarantee.
  const runRes = await handleAsyncApiRequest('POST', `/api/v1/tasks/${taskId}/run`, {}, headers, service);
  assert.equal(runRes.status, 200);
  const run = runRes.data as { status: string; result: { kind: string; plan: { steps: Array<{ resolvedToolId: string | null; executionReadiness: string }> } } };
  assert.equal(run.status, 'SUCCEEDED');
  assert.equal(run.result.kind, 'PLAN_PREVIEW');

  const step = run.result.plan.steps[0];
  assert.equal(step.resolvedToolId, GMAIL_SEND_EMAIL_TOOL_ID);
  // Never EXECUTION_READY/auto-run — Gmail is a consequential write and must
  // always land on APPROVAL_REQUIRED (connected) or BLOCKED (not connected),
  // and in neither case has any email actually been sent.
  assert.notEqual(step.executionReadiness, 'EXECUTION_READY');
});

// ── payload hash stability (shared with Calendar's precedent) ──────────────

test('payload hash stability: an identical Gmail payload (regardless of key order) hashes the same', () => {
  const a = validSendPayload();
  const b = { body: a.body, subject: a.subject, to: a.to, from: a.from, cc: a.cc, bcc: a.bcc, attachments: a.attachments, threadId: a.threadId, replyToMessageId: a.replyToMessageId };
  assert.equal(hashCanonicalPayload(a as unknown as Record<string, unknown>), hashCanonicalPayload(b as unknown as Record<string, unknown>));
});
