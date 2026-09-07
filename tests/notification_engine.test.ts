import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NotificationStore } from '../src/notifications/notification.store.js';
import { NotificationEngine } from '../src/notifications/notification.engine.js';
import { TelegramIdentityStore } from '../src/integrations/telegram/telegram-identity.store.js';
import { TelegramBotClient } from '../src/integrations/telegram/telegram.client.js';
import { SlackIdentityStore } from '../src/integrations/slack/slack-identity.store.js';
import { SlackClient } from '../src/integrations/slack/slack.client.js';
import { AuditLogger } from '../src/governance/audit.logger.js';
import { handleAsyncApiRequest } from '../src/server_web.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-notif-test-'));
}

test('NotificationStore persists records, tracks unread counts, and supports read operations', () => {
  const dir = tempDir();
  const store1 = new NotificationStore({ dir });

  assert.equal(store1.getUnreadCount('usr_1'), 0);

  store1.save({
    id: 'notif_001',
    tenantId: 'ten_1',
    principalId: 'usr_1',
    type: 'TASK_COMPLETED',
    title: 'Task 1 Completed',
    body: 'Your task has completed successfully.',
    read: false,
    channelDeliveries: [{ channel: 'WEB', status: 'DELIVERED', deliveredAt: new Date().toISOString() }],
    createdAt: new Date().toISOString(),
  });

  store1.save({
    id: 'notif_002',
    tenantId: 'ten_1',
    principalId: 'usr_1',
    type: 'CONDITION_MET',
    title: 'Price Alert',
    body: 'Flight price dropped.',
    read: false,
    channelDeliveries: [{ channel: 'WEB', status: 'DELIVERED', deliveredAt: new Date().toISOString() }],
    createdAt: new Date().toISOString(),
  });

  assert.equal(store1.getUnreadCount('usr_1'), 2);
  assert.equal(store1.list('usr_1').length, 2);

  // Mark single as read
  const updated = store1.markAsRead('notif_001');
  assert.equal(updated?.read, true);
  assert.equal(store1.getUnreadCount('usr_1'), 1);

  // Persisted across fresh store instance
  const store2 = new NotificationStore({ dir });
  assert.equal(store2.getUnreadCount('usr_1'), 1);
  assert.equal(store2.list('usr_1').length, 2);

  // Mark all as read
  const count = store2.markAllAsRead('usr_1');
  assert.equal(count, 1);
  assert.equal(store2.getUnreadCount('usr_1'), 0);
});

test('NotificationEngine dispatches multi-channel notifications to WEB, Telegram, and Slack', async () => {
  const dir = tempDir();
  const store = new NotificationStore({ dir: path.join(dir, 'notifs') });
  const tgIdentityStore = new TelegramIdentityStore({ dir: path.join(dir, 'tg') });
  tgIdentityStore.link('998877', 'usr_multi_001', 'ten_1', 'multi_tg');

  const slackIdentityStore = new SlackIdentityStore({ dir: path.join(dir, 'slack') });
  slackIdentityStore.link('U998877', 'usr_multi_001', 'ten_1', 'T01', 'multi_slack');

  const tgBotClient = new TelegramBotClient(null);
  const slackClient = new SlackClient(null);
  const auditLogger = new AuditLogger();

  const engine = new NotificationEngine({
    store,
    telegramIdentityStore: tgIdentityStore,
    telegramBotClient: tgBotClient,
    slackIdentityStore: slackIdentityStore,
    slackClient: slackClient,
    auditLogger,
  });

  const record = await engine.dispatch({
    tenantId: 'ten_1',
    principalId: 'usr_multi_001',
    type: 'CONDITION_MET',
    title: 'Watched Price Met',
    body: 'The price for your watched flight is now ₩750,000.',
  });

  assert.equal(record.principalId, 'usr_multi_001');
  assert.equal(record.read, false);
  assert.equal(record.channelDeliveries.length, 3); // WEB, TELEGRAM, SLACK

  const webDel = record.channelDeliveries.find((d) => d.channel === 'WEB');
  const tgDel = record.channelDeliveries.find((d) => d.channel === 'TELEGRAM');
  const slackDel = record.channelDeliveries.find((d) => d.channel === 'SLACK');

  assert.equal(webDel?.status, 'DELIVERED');
  assert.equal(tgDel?.status, 'DELIVERED');
  assert.equal(tgDel?.targetId, '998877');
  assert.equal(slackDel?.status, 'DELIVERED');
  assert.equal(slackDel?.targetId, 'U998877');
});

test('Notification API endpoints in server_web.ts respond correctly', async () => {
  const dir = tempDir();
  const store = new NotificationStore({ dir: path.join(dir, 'notifs') });
  const auditLogger = new AuditLogger();
  const customEngine = new NotificationEngine({
    store,
    auditLogger,
  });

  const mockAiService: any = { statuses: () => [] };

  // Dispatch via API
  const dispatchRes = await handleAsyncApiRequest('POST', '/api/v1/notifications/dispatch', {
    tenantId: 'ten_test',
    principalId: 'usr_notif_api',
    type: 'TASK_COMPLETED',
    title: 'API Task Done',
    body: 'Your automated task finished cleanly.',
  }, {}, mockAiService, {}, undefined, undefined, undefined, undefined, undefined, customEngine);

  assert.equal(dispatchRes.status, 201);
  assert.equal((dispatchRes.data as any).title, 'API Task Done');
  const notifId = (dispatchRes.data as any).id;

  // List notifications
  const listRes = await handleAsyncApiRequest('GET', '/api/v1/notifications', null, { 'x-principal-id': 'usr_notif_api' }, mockAiService, {}, undefined, undefined, undefined, undefined, undefined, customEngine);
  assert.equal(listRes.status, 200);
  assert.equal((listRes.data as any).unreadCount, 1);
  assert.equal((listRes.data as any).notifications.length, 1);

  // Mark single as read
  const readRes = await handleAsyncApiRequest('POST', `/api/v1/notifications/${notifId}/read`, null, { 'x-principal-id': 'usr_notif_api' }, mockAiService, {}, undefined, undefined, undefined, undefined, undefined, customEngine);
  assert.equal(readRes.status, 200);
  assert.equal((readRes.data as any).read, true);

  // Mark all as read endpoint
  const readAllRes = await handleAsyncApiRequest('POST', '/api/v1/notifications/read-all', null, { 'x-principal-id': 'usr_notif_api' }, mockAiService, {}, undefined, undefined, undefined, undefined, undefined, customEngine);
  assert.equal(readAllRes.status, 200);
  assert.equal((readAllRes.data as any).success, true);
});
