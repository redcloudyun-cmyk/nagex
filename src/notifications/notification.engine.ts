import crypto from 'node:crypto';
import { NagexError } from '../common/errors.js';
import type { AuditLogger } from '../governance/audit.logger.js';
import type { TelegramIdentityStore } from '../integrations/telegram/telegram-identity.store.js';
import type { TelegramBotClient } from '../integrations/telegram/telegram.client.js';
import type { SlackIdentityStore } from '../integrations/slack/slack-identity.store.js';
import type { SlackClient } from '../integrations/slack/slack.client.js';
import type { DesktopRuntimeEngine } from '../desktop/desktop-runtime.engine.js';
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
  // P04 — caller-supplied deduplication key.  When provided, dispatch()
  // returns the existing record if one with the same key already exists,
  // guaranteeing exactly-one logical notification per event.
  dedupeKey?: string;
}

// S2C — who a notification is FOR.
//   dispatch()          INTERNAL_SERVER_DISPATCH_AUTHORITY: trusted server code (daily brief, task runners, system workflows) names
//                       the recipient. It is not reachable from an HTTP request.
//   dispatchForCaller() EXTERNAL_HTTP_USER_AUTHORITY: the recipient IS the authenticated caller. A principal/tenant in the
//                       request is, at most, a redundant assertion; a different one is refused before anything is written or sent.
//                       Its external channels are limited to the caller's own OWNERSHIP-PROVEN links, because its content is
//                       chosen by the user.
// There is no flag a request can set to move from one to the other: they are different methods and only the server calls dispatch().
type ChannelPolicy = 'ANY_LINK' | 'PROVEN_LINKS_ONLY';

export interface CallerRecipient {
  tenantId: string;
  principalId: string;
}

export interface UserDispatchOptions {
  type: NotificationType;
  title: string;
  body: string;
  metadata?: Record<string, unknown>;
  requestId?: string;
  dedupeKey?: string;
  // whatever the request body carried; only an assertion, never authority
  assertedPrincipalId?: unknown;
  assertedTenantId?: unknown;
}

export interface NotificationEngineOptions {
  store: NotificationStore;
  telegramIdentityStore?: TelegramIdentityStore;
  telegramBotClient?: TelegramBotClient;
  slackIdentityStore?: SlackIdentityStore;
  slackClient?: SlackClient;
  desktopRuntimeEngine?: DesktopRuntimeEngine;
  auditLogger: AuditLogger;
}

export class NotificationEngine {
  constructor(private readonly options: NotificationEngineOptions) {}

  // INTERNAL_SERVER_DISPATCH_AUTHORITY — trusted server code names the recipient (unchanged behavior).
  public async dispatch(opts: DispatchNotificationOptions): Promise<NotificationRecord> {
    return this.deliver(opts, 'ANY_LINK');
  }

  // EXTERNAL_HTTP_USER_AUTHORITY — the authenticated caller is the only possible recipient.
  public async dispatchForCaller(caller: CallerRecipient, opts: UserDispatchOptions): Promise<NotificationRecord> {
    const absent = (v: unknown): boolean => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
    const principalOverride = !absent(opts.assertedPrincipalId) && opts.assertedPrincipalId !== caller.principalId;
    const tenantOverride = !absent(opts.assertedTenantId) && opts.assertedTenantId !== caller.tenantId;
    if (principalOverride || tenantOverride) {
      // refused BEFORE any notification write, channel fan-out or provider call
      this.options.auditLogger.logEvent({
        actor: { type: 'user', id: caller.principalId },
        tenant_id: caller.tenantId,
        action: 'notification:dispatch_denied',
        resource: { type: 'Notification', id: 'not_created' },
        result: 'DENIED',
        reason_code: 'RECIPIENT_NOT_CALLER',
        request_id: opts.requestId || `req_notif_${Date.now()}`,
        details: { principalOverride, tenantOverride },
      });
      throw new NagexError({ code: 'NOTIFICATION_RECIPIENT_NOT_AUTHORIZED', category: 'AUTHORIZATION', message: 'A notification can only be sent to your own account.', request_id: opts.requestId });
    }
    return this.deliver({
      tenantId: caller.tenantId,
      principalId: caller.principalId,
      type: opts.type,
      title: opts.title,
      body: opts.body,
      metadata: opts.metadata,
      requestId: opts.requestId,
      dedupeKey: opts.dedupeKey,
    }, 'PROVEN_LINKS_ONLY');
  }

  private async deliver(opts: DispatchNotificationOptions, channelPolicy: ChannelPolicy): Promise<NotificationRecord> {
    const id = `notif_${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const requestId = opts.requestId || `req_notif_${Date.now()}`;

    // P04-R1 — deduplication identity is tenantId + principalId + dedupeKey,
    // not the key alone: the same logical dedupeKey (taskId:runId:eventType)
    // must never suppress a notification for a different tenant/principal.
    if (opts.dedupeKey) {
      const existing = this.options.store.getByDedupeKey(opts.tenantId, opts.principalId, opts.dedupeKey);
      if (existing) return existing;
    }

    // P04 — persist-first: save the WEB-only record to durable storage
    // BEFORE attempting any optional external channels.  This guarantees
    // the user always receives at least the WEB notification, even if an
    // optional channel throws an unexpected error.
    const record: NotificationRecord = {
      id,
      tenantId: opts.tenantId,
      principalId: opts.principalId,
      type: opts.type,
      title: opts.title,
      body: opts.body,
      read: false,
      channelDeliveries: [
        { channel: 'WEB', status: 'DELIVERED', deliveredAt: now },
      ],
      metadata: opts.metadata,
      dedupeKey: opts.dedupeKey,
      createdAt: now,
    };

    this.options.store.save(record);

    // ── Optional additive channels (failures never lose the WEB record) ──

    // 1. Telegram Multi-channel Dispatch
    if (this.options.telegramIdentityStore && this.options.telegramBotClient) {
      // user-originated content goes only to the caller's own ownership-proven link (S2C); trusted server dispatch keeps its lookup
      const tgIdentity = channelPolicy === 'PROVEN_LINKS_ONLY'
        ? this.options.telegramIdentityStore.listVerifiedForPrincipal(opts.principalId, opts.tenantId)[0]
        : this.options.telegramIdentityStore.get(opts.principalId) ||
          [...this.options.telegramIdentityStore.list()].find((rec) => rec.principalId === opts.principalId);

      if (tgIdentity) {
        try {
          const text = `🔔 <b>NAgex Notification: ${this.escapeHtml(opts.title)}</b>\n\n${this.escapeHtml(opts.body)}`;
          const sent = await this.options.telegramBotClient.sendMessage({
            chatId: tgIdentity.telegramUserId,
            text,
          });
          record.channelDeliveries.push({
            channel: 'TELEGRAM',
            status: sent.ok ? 'DELIVERED' : 'FAILED',
            targetId: tgIdentity.telegramUserId,
            deliveredAt: sent.ok ? new Date().toISOString() : undefined,
            error: sent.ok ? undefined : sent.reason,
          });
        } catch (err) {
          record.channelDeliveries.push({
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
      const slackIdentity = channelPolicy === 'PROVEN_LINKS_ONLY'
        ? this.options.slackIdentityStore.listVerifiedForPrincipal(opts.principalId, opts.tenantId)[0]
        : [...this.options.slackIdentityStore.list()].find((rec) => rec.principalId === opts.principalId);

      if (slackIdentity) {
        try {
          const text = `🔔 *NAgex Notification: ${opts.title}*\n\n${opts.body}`;
          const sent = await this.options.slackClient.postMessage({
            channel: slackIdentity.slackUserId,
            text,
          });
          record.channelDeliveries.push({
            channel: 'SLACK',
            status: sent.ok ? 'DELIVERED' : 'FAILED',
            targetId: slackIdentity.slackUserId,
            deliveredAt: sent.ok ? new Date().toISOString() : undefined,
            error: sent.ok ? undefined : sent.reason,
          });
        } catch (err) {
          record.channelDeliveries.push({
            channel: 'SLACK',
            status: 'FAILED',
            targetId: slackIdentity.slackUserId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // 3. Desktop Native Notification Dispatch
    if (this.options.desktopRuntimeEngine) {
      try {
        const desktopSent = this.options.desktopRuntimeEngine.dispatchNotification({
          type: opts.type,
          title: opts.title,
          body: opts.body,
          metadata: opts.metadata,
        });
        record.channelDeliveries.push({
          channel: 'DESKTOP',
          status: desktopSent ? 'DELIVERED' : 'SKIPPED',
          targetId: opts.principalId,
          deliveredAt: desktopSent ? new Date().toISOString() : undefined,
        });
      } catch (err) {
        record.channelDeliveries.push({
          channel: 'DESKTOP',
          status: 'FAILED',
          targetId: opts.principalId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Update the persisted record with optional channel outcomes.
    // If the update fails, the WEB-only record already persisted above
    // remains — the user still has the core notification.
    if (record.channelDeliveries.length > 1) {
      this.options.store.save(record);
    }

    this.options.auditLogger.logEvent({
      actor: { type: 'system', id: 'notification-engine' },
      tenant_id: opts.tenantId,
      action: 'notification:dispatched',
      resource: { type: 'Notification', id },
      result: 'SUCCESS',
      request_id: requestId,
      details: { type: opts.type, title: opts.title, deliveries: record.channelDeliveries.map((d) => `${d.channel}:${d.status}`) },
    });

    return record;
  }

  public list(tenantId: string, principalId: string, limit = 50): NotificationRecord[] {
    return this.options.store.list(tenantId, principalId, limit);
  }

  public getUnreadCount(tenantId: string, principalId: string): number {
    return this.options.store.getUnreadCount(tenantId, principalId);
  }

  public markAsRead(id: string, tenantId: string, principalId: string): NotificationRecord | undefined {
    return this.options.store.markAsRead(id, tenantId, principalId);
  }

  public dismiss(id: string, tenantId: string, principalId: string): NotificationRecord | undefined {
    return this.options.store.dismiss(id, tenantId, principalId);
  }

  public markAllAsRead(tenantId: string, principalId: string): number {
    return this.options.store.markAllAsRead(tenantId, principalId);
  }

  private escapeHtml(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}

