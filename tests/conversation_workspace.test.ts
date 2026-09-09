import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConversationStore } from '../src/conversations/conversation.store.js';
import { ConversationContextService } from '../src/conversations/conversation-context.service.js';
import { isConversationMessageRecord } from '../src/conversations/conversation.types.js';
import { SessionStore } from '../src/sessions/session.store.js';
import { AiService } from '../src/model-gateway/ai-service.js';
import { UnifiedModelRouter } from '../src/model-gateway/unified-model-router.js';
import { handleAsyncApiRequest, sessionStore } from '../src/server_web.js';
import { NagexError } from '../src/common/errors.js';

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

  const headers = {
    'x-nagex-tenant': 'ten_test',
    'x-principal-id': 'usr_test',
  };

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
    { 'x-nagex-tenant': 'ten_OTHER', 'x-principal-id': 'usr_test' },
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

  const headers = {
    'x-nagex-tenant': 'ten_test',
    'x-principal-id': 'usr_test',
  };

  const res = await handleAsyncApiRequest(
    'POST',
    '/api/v1/ai/chat',
    { message: 'What is the weather today?' },
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

  const headers = {
    'x-nagex-tenant': 'ten_test',
    'x-principal-id': 'usr_test',
  };

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
