// R10.2-D Increment 4 — Telegram integration routes (MASTER.md Section
// 14.5 item 10), extracted verbatim from server_web.ts's
// handleAsyncApiRequest.
import crypto from 'node:crypto';
import { NagexError } from '../../common/errors.js';
import { DEFAULT_GOOGLE_TENANT_ID } from '../../integrations/google/token.store.js';
import type { TelegramIdentityStore } from '../../integrations/telegram/telegram-identity.store.js';
import type { TelegramBotClient, TelegramUpdate } from '../../integrations/telegram/telegram.client.js';
import type { TelegramService } from '../../integrations/telegram/telegram.service.js';
import type { AuditLogger } from '../../governance/audit.logger.js';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';

function getHeaderValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export interface TelegramRouteDeps {
  telegramBotClient: TelegramBotClient;
  telegramApiService: TelegramService;
  telegramIdentityStore: TelegramIdentityStore;
  auditLogger: AuditLogger;
}

export const handleTelegramRoutes: AsyncRouteRegistrar<TelegramRouteDeps> = async (method, pathname, body, headers, _query, deps): Promise<ApiResult | undefined> => {
  const { telegramBotClient, telegramApiService, telegramIdentityStore, auditLogger } = deps;

  if (pathname === '/api/v1/integrations/telegram/status' && method === 'GET') {
    return { status: 200, data: telegramBotClient.getStatus() };
  }
  if (pathname === '/api/v1/integrations/telegram/webhook' && method === 'POST') {
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_tg_wh_${crypto.randomUUID()}`;
    const update = (body || {}) as unknown as TelegramUpdate;
    const result = await telegramApiService.processUpdate(update, requestId);
    return { status: 200, data: { status: 'ok', handled: result !== null, result } };
  }
  if (pathname === '/api/v1/integrations/telegram/send' && method === 'POST') {
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_tg_send_${crypto.randomUUID()}`;
    const chatId = body?.chatId ? (typeof body.chatId === 'number' || typeof body.chatId === 'string' ? body.chatId : '') : '';
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    if (!chatId || !text) {
      throw new NagexError({ code: 'INVALID_TELEGRAM_SEND_PAYLOAD', category: 'VALIDATION', message: 'chatId and text are required.', request_id: requestId });
    }
    const sent = await telegramBotClient.sendMessage({ chatId, text });
    return { status: 200, data: { success: sent } };
  }
  if (pathname === '/api/v1/integrations/telegram/identity/link' && method === 'POST') {
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_tg_link_${crypto.randomUUID()}`;
    const telegramUserId = String(body?.telegramUserId || '').trim();
    const principalId = typeof body?.principalId === 'string' && body.principalId.trim() ? body.principalId.trim() : (getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001');
    const tenantId = typeof body?.tenantId === 'string' && body.tenantId.trim() ? body.tenantId.trim() : (getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID);
    const username = typeof body?.username === 'string' ? body.username.trim() : undefined;

    if (!telegramUserId) {
      throw new NagexError({ code: 'TELEGRAM_USER_ID_REQUIRED', category: 'VALIDATION', message: 'telegramUserId is required.', request_id: requestId });
    }
    const record = telegramIdentityStore.link(telegramUserId, principalId, tenantId, username);
    auditLogger.logEvent({
      actor: { type: 'user', id: principalId },
      tenant_id: tenantId,
      action: 'channel:telegram_identity_linked',
      resource: { type: 'TelegramIdentityLink', id: telegramUserId },
      result: 'SUCCESS',
      request_id: requestId,
      details: { telegramUserId, principalId, tenantId, username },
    });
    return { status: 200, data: record };
  }
  if (pathname === '/api/v1/integrations/telegram/identities' && method === 'GET') {
    const identities = telegramIdentityStore.list();
    return { status: 200, data: { identities, total: identities.length } };
  }

  return undefined;
};
