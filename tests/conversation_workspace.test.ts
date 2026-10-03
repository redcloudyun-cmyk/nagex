import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConversationStore, compareConversationMessages } from '../src/conversations/conversation.store.js';
import { ConversationContextService } from '../src/conversations/conversation-context.service.js';
import { isConversationMessageRecord } from '../src/conversations/conversation.types.js';
import { SessionStore } from '../src/sessions/session.store.js';
import { AiService } from '../src/model-gateway/ai-service.js';
import { UnifiedModelRouter } from '../src/model-gateway/unified-model-router.js';
import { handleAsyncApiRequest, sessionStore } from '../src/server_web.js';
import { NagexError } from '../src/common/errors.js';
import { authAs, authAsWith } from './_s1_session_auth.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-conv-test-'));
}

test('ConversationStore: append USER and ASSISTANT messages with stable ordering', () => {
  const dir = tempDir();
  const store = new ConversationStore({ dir });

  const msg1 = store.append({
    tenantId: 'ten_01',
    principalId: 'usr_01',
    sessionId: 'sess_main',
    role: 'USER',
    source: 'WEB',
    content: 'Hello NAgex',
  });

  const msg2 = store.append({
    tenantId: 'ten_01',
    principalId: 'usr_01',
    sessionId: 'sess_main',
    role: 'ASSISTANT',
    source: 'WEB',
    content: 'Hello! How can I help you?',
  });

  assert.equal(msg1.role, 'USER');
  assert.equal(msg1.status, 'COMMITTED');
  assert.equal(msg2.role, 'ASSISTANT');
  assert.equal(msg2.status, 'COMMITTED');

  const list = store.listSession('ten_01', 'usr_01', 'sess_main');
  assert.equal(list.length, 2);
  assert.equal(list[0].messageId, msg1.messageId);
  assert.equal(list[1].messageId, msg2.messageId);
});

test('ConversationStore: restart restores messages from disk and verifies permissions', () => {
  const dir = tempDir();
  const store1 = new ConversationStore({ dir });

  const msg = store1.append({
    tenantId: 'ten_01',
    principalId: 'usr_01',
    sessionId: 'sess_01',
    role: 'USER',
    source: 'WEB',
    content: 'Persisted message test',
  });

  // Verify file written to disk
  const filePath = path.join(dir, `${msg.messageId}.json`);
  assert.equal(fs.existsSync(filePath), true);

  if (process.platform !== 'win32') {
    const stat = fs.statSync(filePath);
    assert.equal(stat.mode & 0o777, 0o600);
  }

  // Restore from fresh store instance
  const store2 = new ConversationStore({ dir });
  const restored = store2.get(msg.messageId, 'ten_01', 'usr_01');
  assert.notEqual(restored, null);
  assert.equal(restored?.content, 'Persisted message test');
});

test('ConversationStore: corrupted and invalid record files are skipped on restore', () => {
  const dir = tempDir();
  const store1 = new ConversationStore({ dir });

  const valid = store1.append({
    tenantId: 'ten_01',
    principalId: 'usr_01',
    sessionId: 'sess_01',
    role: 'USER',
    source: 'WEB',
    content: 'Valid message',
  });

  // Write a corrupted file
  fs.writeFileSync(path.join(dir, 'corrupt.json'), 'GARBAGE NOT JSON {{{');

  // Write a file with invalid schema (bad role)
  fs.writeFileSync(
    path.join(dir, 'invalid_role.json'),
    JSON.stringify({
      messageId: 'msg_bad',
      tenantId: 'ten_01',
      principalId: 'usr_01',
      sessionId: 'sess_01',
      role: 'INVALID_ROLE',
      status: 'COMMITTED',
      content: 'Bad',
      source: 'WEB',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
  );

  const store2 = new ConversationStore({ dir });
  const list = store2.listSession('ten_01', 'usr_01', 'sess_01');
  assert.equal(list.length, 1);
  assert.equal(list[0].messageId, valid.messageId);
});

test('ConversationStore: strict tenant, principal, and session isolation', () => {
  const dir = tempDir();
  const store = new ConversationStore({ dir });

  const msg = store.append({
    tenantId: 'ten_A',
    principalId: 'usr_A',
    sessionId: 'sess_A',
    role: 'USER',
    source: 'WEB',
    content: 'Secret text',
  });

  // Cross-tenant get
  assert.equal(store.get(msg.messageId, 'ten_B', 'usr_A'), null);
  // Cross-principal get
  assert.equal(store.get(msg.messageId, 'ten_A', 'usr_B'), null);

  // Cross-tenant list
  assert.equal(store.listSession('ten_B', 'usr_A', 'sess_A').length, 0);
  // Cross-principal list
  assert.equal(store.listSession('ten_A', 'usr_B', 'sess_A').length, 0);
  // Cross-session list
  assert.equal(store.listSession('ten_A', 'usr_A', 'sess_B').length, 0);
});

test('ConversationStore: redaction and deletion semantics', () => {
  const dir = tempDir();
  const store = new ConversationStore({ dir });

  const msg1 = store.append({
    tenantId: 'ten_01',
    principalId: 'usr_01',
    sessionId: 'sess_01',
    role: 'USER',
    source: 'WEB',
    content: 'Sensitive message',
  });

  const msg2 = store.append({
    tenantId: 'ten_01',
    principalId: 'usr_01',
    sessionId: 'sess_01',
    role: 'ASSISTANT',
    source: 'WEB',
    content: 'Response',
  });

  // Redact msg1
  const redacted = store.redact(msg1.messageId, 'ten_01', 'usr_01');
  assert.equal(redacted?.status, 'REDACTED');

  // getRecentContext must exclude REDACTED messages
  const recent = store.getRecentContext('ten_01', 'usr_01', 'sess_01');
  assert.equal(recent.length, 1);
  assert.equal(recent[0].messageId, msg2.messageId);

  // deleteSession
  const deletedCount = store.deleteSession('ten_01', 'usr_01', 'sess_01');
  assert.equal(deletedCount, 2);
  assert.equal(store.listSession('ten_01', 'usr_01', 'sess_01').length, 0);
});

test('ConversationContextService: bounds to 20 messages and 32,000 character limit', () => {
  const dir = tempDir();
  const store = new ConversationStore({ dir });
  const contextService = new ConversationContextService(store);

  // Append 25 messages
  for (let i = 1; i <= 25; i++) {
    store.append({
      tenantId: 'ten_01',
      principalId: 'usr_01',
      sessionId: 'sess_01',
      role: i % 2 === 1 ? 'USER' : 'ASSISTANT',
      source: 'WEB',
      content: `Message ${i}`,
    });
  }

  // Should bound to last 20 messages (Message 6 to 25)
  let context = contextService.buildContext({
    tenantId: 'ten_01',
    principalId: 'usr_01',
    sessionId: 'sess_01',
  });
  assert.equal(context.length, 20);
  assert.equal(context[0].content, 'Message 6');
  assert.equal(context[19].content, 'Message 25');

  // Test character budget limit
  const storeChar = new ConversationStore({ dir: tempDir() });
  const contextServiceChar = new ConversationContextService(storeChar);

  // Message 1: 20,000 chars
  storeChar.append({
    tenantId: 'ten_01',
    principalId: 'usr_01',
    sessionId: 'sess_01',
    role: 'USER',
    source: 'WEB',
    content: 'A'.repeat(20_000),
  });

  // Message 2: 20,000 chars
  storeChar.append({
    tenantId: 'ten_01',
    principalId: 'usr_01',
    sessionId: 'sess_01',
    role: 'ASSISTANT',
    source: 'WEB',
    content: 'B'.repeat(20_000),
  });

  // Total 40,000 > 32,000 -> oldest ('A'.repeat(20000)) discarded
  context = contextServiceChar.buildContext({
    tenantId: 'ten_01',
    principalId: 'usr_01',
    sessionId: 'sess_01',
  });
  assert.equal(context.length, 1);
  assert.equal(context[0].content, 'B'.repeat(20_000));
});

test('API: GET, POST, DELETE /api/v1/conversations/main', async () => {
  const dir = tempDir();
  const convStore = new ConversationStore({ dir });
  const convContext = new ConversationContextService(convStore);

  const headers = authAsWith('ten_test', 'usr_test', {  });

  // 1. GET main conversation -> initial empty
  let res = await handleAsyncApiRequest(
    'GET',
    '/api/v1/conversations/main',
    null,
    headers,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    convStore,
    convContext
  );
  assert.equal(res.status, 200);
  const data = res.data as { session: { sessionId: string; type: string }; messages: unknown[] };
  assert.ok(data.session.sessionId.startsWith('sess_'));
  assert.equal(data.messages.length, 0);

  // 2. POST /api/v1/conversations/main/messages -> append message
  res = await handleAsyncApiRequest(
    'POST',
    '/api/v1/conversations/main/messages',
    { content: 'Hello via channel adapter', role: 'USER', source: 'TELEGRAM' },
    headers,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    convStore,
    convContext
  );
  assert.equal(res.status, 201);
  const msgData = res.data as { messageId: string; content: string; source: string };
  assert.equal(msgData.content, 'Hello via channel adapter');
  assert.equal(msgData.source, 'TELEGRAM');

  // 3. GET main again -> returns 1 message
  res = await handleAsyncApiRequest(
    'GET',
    '/api/v1/conversations/main',
    null,
    headers,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    convStore,
    convContext
  );
  assert.equal(res.status, 200);
  const get2 = res.data as { messages: unknown[] };
  assert.equal(get2.messages.length, 1);

  // 4. Cross-tenant GET -> returns empty for different tenant
  const crossRes = await handleAsyncApiRequest(
    'GET',
    '/api/v1/conversations/main',
    null,
    authAs('ten_OTHER', 'usr_test'),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    convStore,
    convContext
  );
  assert.equal(crossRes.status, 200);
  assert.equal((crossRes.data as { messages: unknown[] }).messages.length, 0);

  // 5. DELETE main -> clears conversation only
  res = await handleAsyncApiRequest(
    'DELETE',
    '/api/v1/conversations/main',
    null,
    headers,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    convStore,
    convContext
  );
  assert.equal(res.status, 200);
  assert.equal((res.data as { clearedCount: number }).clearedCount, 1);

  // Verify empty after delete
  res = await handleAsyncApiRequest(
    'GET',
    '/api/v1/conversations/main',
    null,
    headers,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    convStore,
    convContext
  );
  assert.equal((res.data as { messages: unknown[] }).messages.length, 0);
});

test('Runtime / AI: USER message persisted before AI call, ASSISTANT message persisted after success', async () => {
  const dir = tempDir();
  const convStore = new ConversationStore({ dir });
  const convContext = new ConversationContextService(convStore);

  const mockAiService = {
    statuses: () => [],
    chat: async (input: { message: string; conversation?: Array<{ role: 'user' | 'assistant'; content: string }> }) => {
      // Assert that conversation context was supplied to AI and includes current USER message
      assert.ok(Array.isArray(input.conversation));
      assert.ok(input.conversation.length >= 1);
      assert.equal(input.conversation[input.conversation.length - 1].role, 'user');
      assert.equal(input.conversation[input.conversation.length - 1].content, input.message);

      return {
        data: { message: 'Mock assistant reply' },
        provider: 'mock',
        model: 'mock-model',
        latencyMs: 10,
        requestId: 'req_mock',
      };
    },
  } as unknown as AiService;

  const headers = authAsWith('ten_test', 'usr_test', {  });

  // B3 — this test's intent is conversation persistence/ordering, not
  // web-search routing: "What is the weather today?" now legitimately
  // triggers current-information/evidence-pack routing (see
  // src/http/routes/conversation.routes.ts + src/research/
  // question-classification.service.ts), which short-circuits before ever
  // calling the injected mock AiService. A prompt with no freshness
  // requirement exercises the exact same persistence/ordering behavior
  // without disabling that legitimate routing.
  const res = await handleAsyncApiRequest(
    'POST',
    '/api/v1/ai/chat',
    { message: 'Summarize the project note I just gave you.' },
    headers,
    mockAiService,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    convStore,
    convContext
  );

  assert.equal(res.status, 200);

  // Check store after success: should have 2 messages (USER + ASSISTANT)
  const mainSession = sessionStore.getOrCreateMain('ten_test', 'usr_test');
  const finalMessages = convStore.listSession('ten_test', 'usr_test', mainSession.sessionId);
  assert.equal(finalMessages.length, 2);
  assert.equal(finalMessages[0].role, 'USER');
  assert.equal(finalMessages[1].role, 'ASSISTANT');
  assert.equal(finalMessages[1].content, 'Mock assistant reply');
});

test('Runtime / AI: AI failure leaves USER message but creates no fake ASSISTANT message', async () => {
  const dir = tempDir();
  const convStore = new ConversationStore({ dir });
  const convContext = new ConversationContextService(convStore);

  const failingAiService = {
    statuses: () => [],
    chat: async () => {
      throw new NagexError({ code: 'PROVIDER_OUTAGE', category: 'PROVIDER', message: 'Provider failed', request_id: 'req_fail' });
    },
  } as unknown as AiService;

  const headers = authAsWith('ten_test', 'usr_test', {  });

  const res = await handleAsyncApiRequest(
    'POST',
    '/api/v1/ai/chat',
    { message: 'This call will fail' },
    headers,
    failingAiService,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    convStore,
    convContext
  );

  assert.equal(res.status, 502);

  // Store must still contain the USER message, but NO ASSISTANT message
  const mainSession = sessionStore.getOrCreateMain('ten_test', 'usr_test');
  const messages = convStore.listSession('ten_test', 'usr_test', mainSession.sessionId);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'USER');
  assert.equal(messages[0].content, 'This call will fail');
});

test('Restart E2E: session and conversation survive server restart', () => {
  const dir = tempDir();
  const sessDir = path.join(dir, 'sessions');
  const convDir = path.join(dir, 'conversations');

  // Instance 1: Create session and conversation
  const sessionStore1 = new SessionStore({ dir: sessDir });
  const convStore1 = new ConversationStore({ dir: convDir });

  const session1 = sessionStore1.getOrCreateMain('ten_e2e', 'usr_e2e');
  convStore1.append({
    tenantId: 'ten_e2e',
    principalId: 'usr_e2e',
    sessionId: session1.sessionId,
    role: 'USER',
    source: 'WEB',
    content: 'E2E prompt 1',
  });
  convStore1.append({
    tenantId: 'ten_e2e',
    principalId: 'usr_e2e',
    sessionId: session1.sessionId,
    role: 'ASSISTANT',
    source: 'WEB',
    content: 'E2E answer 1',
  });

  // Instance 2: Reload after simulated restart
  const sessionStore2 = new SessionStore({ dir: sessDir });
  const convStore2 = new ConversationStore({ dir: convDir });

  const session2 = sessionStore2.getOrCreateMain('ten_e2e', 'usr_e2e');
  assert.equal(session2.sessionId, session1.sessionId);

  const messages2 = convStore2.listSession('ten_e2e', 'usr_e2e', session2.sessionId);
  assert.equal(messages2.length, 2);
  assert.equal(messages2[0].content, 'E2E prompt 1');
  assert.equal(messages2[1].content, 'E2E answer 1');
});

test('ConversationStore: messages appended within the same createdAt millisecond still preserve append order (seq tie-break)', () => {
  const dir = tempDir();
  // Force every append in this test to report the identical millisecond
  // timestamp, reproducing the exact collision that a fast runtime can hit
  // in practice, without relying on real appends happening to land in the
  // same millisecond.
  const frozenNow = () => '2026-01-01T00:00:00.000Z';
  const store = new ConversationStore({ dir, now: frozenNow });

  const appended = [];
  for (let i = 0; i < 10; i++) {
    appended.push(
      store.append({
        tenantId: 'ten_seq',
        principalId: 'usr_seq',
        sessionId: 'sess_seq',
        role: i % 2 === 0 ? 'USER' : 'ASSISTANT',
        source: 'WEB',
        content: `Message ${i}`,
      })
    );
  }

  // Every appended record shares the identical createdAt.
  assert.ok(appended.every((m) => m.createdAt === '2026-01-01T00:00:00.000Z'));

  const listed = store.listSession('ten_seq', 'usr_seq', 'sess_seq');
  assert.equal(listed.length, 10);
  for (let i = 0; i < 10; i++) {
    assert.equal(listed[i].content, `Message ${i}`);
  }

  // seq survives a fresh store instance reading the same directory, and
  // ordering is still correct after "restart".
  const reloaded = new ConversationStore({ dir, now: frozenNow });
  const relisted = reloaded.listSession('ten_seq', 'usr_seq', 'sess_seq');
  for (let i = 0; i < 10; i++) {
    assert.equal(relisted[i].content, `Message ${i}`);
  }

  // A message appended after reload continues the monotonic counter rather
  // than restarting it (which would risk a fresh collision with existing
  // seq values).
  const next = reloaded.append({
    tenantId: 'ten_seq',
    principalId: 'usr_seq',
    sessionId: 'sess_seq',
    role: 'USER',
    source: 'WEB',
    content: 'Message 10',
  });
  assert.ok(typeof next.seq === 'number' && next.seq > (listed[9].seq ?? 0));
});

test('ConversationStore: a legacy record with no seq field still sorts safely alongside seq-bearing records', () => {
  const dir = tempDir();
  const store = new ConversationStore({ dir });

  const withSeq = store.append({
    tenantId: 'ten_legacy',
    principalId: 'usr_legacy',
    sessionId: 'sess_legacy',
    role: 'USER',
    source: 'WEB',
    content: 'Has seq',
  });
  assert.equal(typeof withSeq.seq, 'number');

  // Simulate a record persisted before this field existed.
  const legacyRecord = { ...withSeq, seq: undefined };
  delete (legacyRecord as { seq?: number }).seq;

  const ordered = [withSeq, legacyRecord].sort(compareConversationMessages);
  // Must not throw and must produce a stable, deterministic order (falls
  // back to messageId comparison when either side lacks seq).
  assert.equal(ordered.length, 2);
});
