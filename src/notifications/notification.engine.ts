import crypto from 'node:crypto';
import type { AuditLogger } from '../governance/audit.logger.js';
import type { TelegramIdentityStore } from '../integrations/telegram/telegram-identity.store.js';
import type { TelegramBotClient } from '../integrations/telegram/telegram.client.js';
import type { SlackIdentityStore } from '../integrations/slack/slack-identity.store.js';
import type { SlackClient } from '../integrations/slack/slack.client.js';
import {
  NotificationStore,
  type NotificationRecord,
  type NotificationType,
  type ChannelDelivery,
} from './notification.store.js';

export interface DispatchNotificationOptions {
  tenantId: string;
  principalId: string;
  type: NotificationType;
  title: string;
  body: string;
  metadata?: Record<string, unknown>;
  requestId?: string;
}

export interface NotificationEngineOptions {
  store: NotificationStore;
  telegramIdentityStore?: TelegramIdentityStore;
  telegramBotClient?: TelegramBotClient;
  slackIdentityStore?: SlackIdentityStore;
  slackClient?: SlackClient;
  auditLogger: AuditLogger;
}

export class NotificationEngine {
  constructor(private readonly options: NotificationEngineOptions) {}

  public async dispatch(opts: DispatchNotificationOptions): Promise<NotificationRecord> {
    const id = `notif_${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const requestId = opts.requestId || `req_notif_${Date.now()}`;

    const deliveries: ChannelDelivery[] = [
      { channel: 'WEB', status: 'DELIVERED', deliveredAt: now },
    ];

    // 1. Telegram Multi-channel Dispatch
    if (this.options.telegramIdentityStore && this.options.telegramBotClient) {
      const tgIdentity = this.options.telegramIdentityStore.get(opts.principalId) ||
        [...this.options.telegramIdentityStore.list()].find((rec) => rec.principalId === opts.principalId);

      if (tgIdentity) {
        try {
          const text = `🔔 <b>NAgex Notification: ${this.escapeHtml(opts.title)}</b>\n\n${this.escapeHtml(opts.body)}`;
          const sent = await this.options.telegramBotClient.sendMessage({
            chatId: tgIdentity.telegramUserId,
            text,
          });
          deliveries.push({
            channel: 'TELEGRAM',
            status: sent.ok ? 'DELIVERED' : 'FAILED',
            targetId: tgIdentity.telegramUserId,
            deliveredAt: sent.ok ? new Date().toISOString() : undefined,
          });
        } catch (err) {
          deliveries.push({
            channel: 'TELEGRAM',
            status: 'FAILED',
            targetId: tgIdentity.telegramUserId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // 2. Slack Multi-channel Dispatch
    if (this.options.slackIdentityStore && this.options.slackClient) {
      const slackIdentity = [...this.options.slackIdentityStore.list()].find((rec) => rec.principalId === opts.principalId);

      if (slackIdentity) {
        try {
          const text = `🔔 *NAgex Notification: ${opts.title}*\n\n${opts.body}`;
          const sent = await this.options.slackClient.postMessage({
            channel: slackIdentity.slackUserId,
            text,
          });
          deliveries.push({
            channel: 'SLACK',
            status: sent.ok ? 'DELIVERED' : 'FAILED',
            targetId: slackIdentity.slackUserId,
            deliveredAt: sent.ok ? new Date().toISOString() : undefined,
          });
        } catch (err) {
          deliveries.push({
            channel: 'SLACK',
            status: 'FAILED',
            targetId: slackIdentity.slackUserId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    const record: NotificationRecord = {
      id,
      tenantId: opts.tenantId,
      principalId: opts.principalId,
      type: opts.type,
      title: opts.title,
      body: opts.body,
      read: false,
      channelDeliveries: deliveries,
      metadata: opts.metadata,
      createdAt: now,
    };

    this.options.store.save(record);

    this.options.auditLogger.logEvent({
      actor: { type: 'system', id: 'notification-engine' },
      tenant_id: opts.tenantId,
      action: 'notification:dispatched',
      resource: { type: 'Notification', id },
      result: 'SUCCESS',
      request_id: requestId,
      details: { type: opts.type, title: opts.title, deliveries: deliveries.map((d) => `${d.channel}:${d.status}`) },
    });

    return record;
  }

  public list(principalId: string, limit = 50): NotificationRecord[] {
    return this.options.store.list(principalId, limit);
  }

  public getUnreadCount(principalId: string): number {
    return this.options.store.getUnreadCount(principalId);
  }

  public markAsRead(id: string): NotificationRecord | undefined {
    return this.options.store.markAsRead(id);
  }

  public markAllAsRead(principalId: string): number {
    return this.options.store.markAllAsRead(principalId);
  }

  private escapeHtml(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}
