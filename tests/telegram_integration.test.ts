import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelegramIdentityStore } from '../src/integrations/telegram/telegram-identity.store.js';
import { TelegramBotClient, type TelegramUpdate } from '../src/integrations/telegram/telegram.client.js';
import { TelegramService } from '../src/integrations/telegram/telegram.service.js';
import { SessionStore } from '../src/sessions/session.store.js';
import { handleAsyncApiRequest } from '../src/server_web.js';
import { AuditLogger } from '../src/governance/audit.logger.js';
import { PlanResolver } from '../src/planning/plan-resolver.js';
import { skillRegistry } from '../src/skills/skill-registry.js';
import { toolRegistry } from '../src/tools/tool-registry.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-tg-test-'));
}

test('TelegramIdentityStore links identities and persists across restarts', () => {
  const dir = tempDir();
  const store1 = new TelegramIdentityStore({ dir });

  // Default fallback resolution for unlinked ID
  const unlinked = store1.resolve('12345');
  assert.equal(unlinked.principalId, 'usr_telegram_12345');
  assert.equal(unlinked.tenantId, 'ten_production_01');

  // Explicit link
  const record = store1.link('12345', 'usr_admin_001', 'ten_custom_01', 'janesmith');
  assert.equal(record.telegramUserId, '12345');
  assert.equal(record.principalId, 'usr_admin_001');
  assert.equal(record.tenantId, 'ten_custom_01');
  assert.equal(record.username, 'janesmith');

  // Resolved now maps to linked identity
  const resolved = store1.resolve('12345');
  assert.equal(resolved.principalId, 'usr_admin_001');
  assert.equal(resolved.tenantId, 'ten_custom_01');

  // Persisted across new store instance
  const store2 = new TelegramIdentityStore({ dir });
  const loaded = store2.get('12345');
  assert.ok(loaded);
  assert.equal(loaded?.principalId, 'usr_admin_001');
  assert.equal(loaded?.username, 'janesmith');
  assert.equal(store2.list().length, 1);
});

test('TelegramBotClient handles unconfigured mock send and getStatus', async () => {
  const client = new TelegramBotClient(null);
  assert.equal(client.isConfigured(), false);

  const status = client.getStatus();
  assert.equal(status.configured, false);

  const res = await client.sendMessage({ chatId: 999, text: 'Hello Telegram' });
  assert.equal(res.ok, true);
  assert.ok(typeof res.messageId === 'number');
});

test('TelegramService resolves update to MainSession, retrieves memory, and returns AI response', async () => {
  const dir = tempDir();
  const identityStore = new TelegramIdentityStore({ dir });
  identityStore.link('98765', 'usr_jane_001', 'ten_jane_01', 'jane_tg');

  const sessionStore = new SessionStore({ dir: path.join(dir, 'sessions') });
  const botClient = new TelegramBotClient(null);
  const auditLogger = new AuditLogger();
  const planResolver = new PlanResolver(skillRegistry, toolRegistry);

  const mockAiService: any = {
    statuses: () => [],
    chat: async (params: any) => ({
      status: 'SUCCESS',
      provider: 'mock',
      model: 'mock-model',
      latencyMs: 10,
      requestId: params.requestId,
      data: { message: `Echoing: ${params.message}` },
    }),
    plan: async (params: any) => ({
      status: 'PLAN_PREVIEW',
      provider: 'mock',
      model: 'mock-model',
      latencyMs: 15,
      requestId: params.requestId,
      data: {
        goal: 'Schedule team sync',
        summary: 'Plan to schedule team meeting',
        reasoningSummary: 'Check calendar availability and schedule event',
        suggested_skills: ['calendar-assistant'],
        steps: [
          {
            step: 1,
            title: 'Check calendar',
            reasoning: 'Find available slots',
            skill: 'calendar-assistant',
            tool: 'google_calendar.find_free_slots',
            requiresApproval: false,
          },
        ],
      },
    }),
  };

  const service = new TelegramService({
    botClient,
    identityStore,
    sessionStore,
    aiService: mockAiService,
    planResolver,
    getMemories: () => [],
    auditLogger,
  });

  const update: TelegramUpdate = {
    update_id: 1001,
    message: {
      message_id: 50,
      date: Date.now(),
      chat: { id: 98765, type: 'private' },
      from: { id: 98765, is_bot: false, first_name: 'Jane' },
      text: 'Hello NAgex!',
    },
  };

  const result = await service.processUpdate(update);
  assert.ok(result);
  assert.equal(result.ok, true);
  assert.equal(result.principalId, 'usr_jane_001');
  assert.equal(result.chatId, 98765);
  assert.equal(result.planGenerated, false);
  assert.equal(result.responseText, 'Echoing: Hello NAgex!');

  // Verify MainSession was created / accessed
  const mainSession = sessionStore.getOrCreateMain('ten_jane_01', 'usr_jane_001');
  assert.equal(mainSession.sessionId, result.sessionId);

  // Test action intent trigger -> plan generated
  const actionUpdate: TelegramUpdate = {
    update_id: 1002,
    message: {
      message_id: 51,
      date: Date.now(),
      chat: { id: 98765, type: 'private' },
      from: { id: 98765, is_bot: false, first_name: 'Jane' },
      text: 'Schedule team meeting for tomorrow',
    },
  };

  const actionResult = await service.processUpdate(actionUpdate);
  assert.ok(actionResult);
  assert.equal(actionResult.planGenerated, true);
  assert.ok(actionResult.responseText.includes('NAgex Action Plan'));
});

test('Telegram API endpoints in server_web.ts respond correctly', async () => {
  const mockAiService: any = {
    statuses: () => [],
    chat: async (params: any) => ({
      status: 'SUCCESS',
      provider: 'mock',
      model: 'mock-model',
      latencyMs: 10,
      requestId: params.requestId,
      data: { message: `Echo: ${params.message}` },
    }),
    plan: async (params: any) => ({
      status: 'PLAN_PREVIEW',
      provider: 'mock',
      model: 'mock-model',
      latencyMs: 15,
      requestId: params.requestId,
      data: {
        goal: 'Mock goal',
        summary: 'Mock summary',
        reasoningSummary: 'Mock reasoning',
        steps: [{ step: 1, title: 'Step 1', reasoning: 'R1', skill: 'general-assistant', tool: null, requiresApproval: false }],
      },
    }),
  };

  const dir = tempDir();
  const identityStore = new TelegramIdentityStore({ dir });
  const customTgService = new TelegramService({
    botClient: new TelegramBotClient(null),
    identityStore,
    sessionStore: new SessionStore({ dir: path.join(dir, 'sessions') }),
    aiService: mockAiService,
    planResolver: new PlanResolver(skillRegistry, toolRegistry),
    getMemories: () => [],
    auditLogger: new AuditLogger(),
  });

  const statusRes = await handleAsyncApiRequest('GET', '/api/v1/integrations/telegram/status', null, {}, mockAiService, {}, undefined, undefined, undefined, customTgService);
  assert.equal(statusRes.status, 200);
  assert.equal((statusRes.data as any).configured, false);

  const linkRes = await handleAsyncApiRequest('POST', '/api/v1/integrations/telegram/identity/link', {
    telegramUserId: '555123',
    principalId: 'usr_link_test',
    tenantId: 'ten_link_test',
    username: 'link_user',
  }, {}, mockAiService, {}, undefined, undefined, undefined, customTgService);
  assert.equal(linkRes.status, 200);
  assert.equal((linkRes.data as any).telegramUserId, '555123');
  assert.equal((linkRes.data as any).principalId, 'usr_link_test');

  const listRes = await handleAsyncApiRequest('GET', '/api/v1/integrations/telegram/identities', null, {}, mockAiService, {}, undefined, undefined, undefined, customTgService);
  assert.equal(listRes.status, 200);
  assert.ok(Array.isArray((listRes.data as any).identities));
  assert.ok((listRes.data as any).identities.length >= 1);

  const sendRes = await handleAsyncApiRequest('POST', '/api/v1/integrations/telegram/send', {
    chatId: '555123',
    text: 'Test direct send',
  }, {}, mockAiService, {}, undefined, undefined, undefined, customTgService);
  assert.equal(sendRes.status, 200);
  assert.equal((sendRes.data as any).success.ok, true);

  const webhookRes = await handleAsyncApiRequest('POST', '/api/v1/integrations/telegram/webhook', {
    update_id: 99,
    message: {
      message_id: 1,
      date: Date.now(),
      chat: { id: 555123, type: 'private' },
      from: { id: 555123, is_bot: false, first_name: 'LinkUser' },
      text: 'Ping via webhook',
    },
  }, {}, mockAiService, {}, undefined, undefined, undefined, customTgService);
  assert.equal(webhookRes.status, 200);
  assert.equal((webhookRes.data as any).status, 'ok');
  assert.equal((webhookRes.data as any).handled, true);
});
