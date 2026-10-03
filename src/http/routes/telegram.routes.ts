// R10.2-D Increment 4 — Telegram integration routes (MASTER.md Section
// 14.5 item 10), extracted verbatim from server_web.ts's
// handleAsyncApiRequest.
import crypto from 'node:crypto';
import { NagexError } from '../../common/errors.js';
import type { TelegramIdentityStore } from '../../integrations/telegram/telegram-identity.store.js';
import type { TelegramBotClient, TelegramUpdate } from '../../integrations/telegram/telegram.client.js';
import type { TelegramService } from '../../integrations/telegram/telegram.service.js';
import type { AuditLogger } from '../../governance/audit.logger.js';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';
import { callerIdentity } from '../request-identity.js';
import { verifyTelegramWebhook, webhookRejection } from '../../integrations/webhook-auth.js';

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
    // S2A — authenticity BEFORE trust: nothing below (identity lookup, conversation write, model) runs for a request that
    // does not carry the server-configured webhook secret. Fails closed when the secret is not configured.
    const verdict = verifyTelegramWebhook(headers);
    if (!verdict.ok) return webhookRejection('telegram', verdict, requestId);
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
  // S2B — the browser can no longer say "I own Telegram user X". A signed-in caller asks for a one-time challenge and proves
  // ownership FROM Telegram (see TelegramService.redeemLinkChallenge, behind the S2A-authenticated webhook):
  // the link is created there from the platform-verified sender, bound to the principal and tenant that issued the challenge.
  if (pathname === '/api/v1/integrations/telegram/identity/link/challenge' && method === 'POST') {
    const { principalId, tenantId } = callerIdentity(headers);
    const challenge = telegramApiService.createLinkChallenge(principalId, tenantId);
    return {
      status: 201,
      headers: { 'Cache-Control': 'no-store' },
      data: {
        integration: 'telegram',
        challenge: challenge.token,
        expiresAt: challenge.expiresAt,
        ttlSeconds: challenge.ttlSeconds,
        instructions: { command: `/start ${challenge.token}`, note: 'Send this to the NAgex bot in a private chat from the Telegram account you want to link.' },
      },
    };
  }
  if (pathname === '/api/v1/integrations/telegram/identity/link' && method === 'POST') {
    callerIdentity(headers);
    throw new NagexError({ code: 'CHANNEL_LINK_PROOF_REQUIRED', category: 'VALIDATION', message: 'A Telegram account is linked by proving you control it: request a link code, then send it to the NAgex bot from that Telegram account. A Telegram user id alone is not accepted.' });
  }
  if (pathname === '/api/v1/integrations/telegram/identity' && method === 'DELETE') {
    const { principalId, tenantId } = callerIdentity(headers);
    return { status: 200, data: { unlinked: telegramApiService.unlinkAll(principalId, tenantId) } };
  }
  if (pathname === '/api/v1/integrations/telegram/identities' && method === 'GET') {
    // a principal sees only ITS OWN links
    const { principalId, tenantId } = callerIdentity(headers);
    const identities = telegramApiService.listLinks(principalId, tenantId);
    return { status: 200, data: { identities, total: identities.length } };
  }
  return undefined;
};
