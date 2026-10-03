import type { AiService } from '../../model-gateway/ai-service.js';
import type { SessionStore } from '../../sessions/session.store.js';
import type { AuditLogger } from '../../governance/audit.logger.js';
import type { MemoryRecord } from '../../context/memory.engine.js';
import type { PlanResolver } from '../../planning/plan-resolver.js';
import { TelegramBotClient, type TelegramMessage, type TelegramUpdate } from './telegram.client.js';
import { TelegramIdentityStore } from './telegram-identity.store.js';
import { NagexError } from '../../common/errors.js';
import { ChannelLinkChallengeStore, parseChannelLinkCommand } from '../channel-link-challenge.store.js';

import type { ConversationStore } from '../../conversations/conversation.store.js';
import type { ConversationContextService } from '../../conversations/conversation-context.service.js';

export interface TelegramServiceOptions {
  botClient: TelegramBotClient;
  identityStore: TelegramIdentityStore;
  sessionStore: SessionStore;
  aiService: AiService;
  planResolver: PlanResolver;
  getMemories: (tenantId: string, principalId: string, prompt: string) => MemoryRecord[];
  auditLogger: AuditLogger;
  conversationStore?: ConversationStore;
  conversationContextService?: ConversationContextService;
  // S2B — ownership-proof challenges. Defaults to a private store; the route that issues a challenge and the webhook that
  // redeems it always reach the same store through this service.
  challengeStore?: ChannelLinkChallengeStore;
}

export interface TelegramProcessResult {
  ok: boolean;
  chatId: number | string;
  principalId: string;
  sessionId: string;
  responseText: string;
  planGenerated?: boolean;
  // S2B — set when the message was an ownership-proof (link) attempt rather than a chat message
  linkOutcome?: 'LINKED' | 'DENIED';
}

export class TelegramService {
  private readonly challenges: ChannelLinkChallengeStore;

  constructor(private readonly options: TelegramServiceOptions) {
    this.challenges = options.challengeStore ?? new ChannelLinkChallengeStore();
  }

  // ── S2B: ownership of a Telegram account is proven FROM Telegram ──
  public createLinkChallenge(principalId: string, tenantId: string): { token: string; expiresAt: string; ttlSeconds: number } {
    return this.challenges.issue('telegram', principalId, tenantId);
  }

  public listLinks(principalId: string, tenantId: string): ReturnType<TelegramIdentityStore['listForPrincipal']> {
    return this.options.identityStore.listForPrincipal(principalId, tenantId);
  }

  public unlinkAll(principalId: string, tenantId: string): number {
    return this.options.identityStore.unlinkForPrincipal(principalId, tenantId);
  }

  // Runs on the verified update only (S2A). The sender identity is the platform's own `from.id`; the code in the text
  // only selects WHICH challenge is being redeemed. Nothing here touches the conversation, memory or the model, and the
  // code is never persisted or logged.
  private async redeemLinkChallenge(update: TelegramUpdate, msg: TelegramMessage, code: string, malformed: boolean, requestId: string): Promise<TelegramProcessResult> {
    const tgUserId = String(msg.from!.id);
    const chatId = msg.chat.id;
    const isoTenant = `ten_telegram_${tgUserId}`;
    let outcome: 'LINKED' | 'DENIED' = 'DENIED';
    let reason = 'INVALID_CHALLENGE';
    let reply = 'This link code is invalid or has expired. Create a new one in NAgex and send it here again.';
    let linkedPrincipal = '';
    let linkedTenant = isoTenant;

    // consume + link are one synchronous step: no await between them, so a challenge cannot be spent twice
    const consumed = this.challenges.consume('telegram', code);
    if (!consumed.ok) {
      reason = consumed.reason;
    } else if (malformed) {
      // a code followed by other text (for example another account id) is not a valid command; the code is spent
      reason = 'MALFORMED_COMMAND';
    } else if (!update.message || msg.chat.type !== 'private' || msg.from!.is_bot) {
      // proof must come from the person's own private chat; a code sent anywhere else is treated as exposed and is spent
      reason = 'NOT_PRIVATE_CHAT';
    } else {
      try {
        const record = this.options.identityStore.link(tgUserId, consumed.principalId, consumed.tenantId, msg.from!.username);
        outcome = 'LINKED';
        reason = 'OWNERSHIP_PROVEN';
        linkedPrincipal = record.principalId;
        linkedTenant = record.tenantId;
        reply = 'Your Telegram account is now linked to the NAgex account that created this code.';
      } catch (error) {
        if (error instanceof NagexError && error.code === 'CHANNEL_IDENTITY_ALREADY_LINKED') {
          reason = 'ALREADY_LINKED';
          reply = 'This Telegram account is already linked to a NAgex account. Unlink it there first, then create a new code.';
        } else {
          throw error;
        }
      }
    }

    this.options.auditLogger.logEvent({
      actor: outcome === 'LINKED' ? { type: 'user', id: linkedPrincipal } : { type: 'system', id: 'telegram-service' },
      tenant_id: linkedTenant,
      action: outcome === 'LINKED' ? 'channel:telegram_identity_linked' : 'channel:telegram_identity_link_denied',
      resource: { type: 'TelegramIdentityLink', id: tgUserId },
      result: outcome === 'LINKED' ? 'SUCCESS' : 'DENIED',
      reason_code: reason,
      request_id: requestId,
      details: { telegramUserId: tgUserId, proof: 'CHALLENGE' },
    });

    await this.options.botClient.sendMessage({ chatId, text: reply, replyToMessageId: msg.message_id });
    return { ok: outcome === 'LINKED', chatId, principalId: linkedPrincipal, sessionId: '', responseText: reply, linkOutcome: outcome };
  }

  public async processUpdate(update: TelegramUpdate, requestId = `req_tg_${Date.now()}`): Promise<TelegramProcessResult | null> {
    const msg = update.message || update.edited_message;
    if (!msg || !msg.from || !msg.text?.trim()) {
      return null;
    }

    // S2B — an ownership-proof attempt is handled here, before identity resolution, conversation, memory or the model.
    // An EDITED message carrying a code is dropped (never stored, never treated as chat).
    const linkAttempt = parseChannelLinkCommand('telegram', msg.text);
    if (linkAttempt) {
      if (!update.message) return null;
      return this.redeemLinkChallenge(update, msg, linkAttempt.code, linkAttempt.trailing !== '', requestId);
    }

    const tgUserId = String(msg.from.id);
    const chatId = msg.chat.id;
    const text = msg.text.trim();

    // 1. Resolve Identity -> Principal & Tenant (AC-13)
    const { principalId, tenantId } = this.options.identityStore.resolve(tgUserId);
    const session = this.options.sessionStore.getOrCreateMain(tenantId, principalId);

    // Persist USER message if conversation store is provided
    if (this.options.conversationStore) {
      this.options.conversationStore.append({
        tenantId,
        principalId,
        sessionId: session.sessionId,
        role: 'USER',
        source: 'TELEGRAM',
        content: text,
        requestId,
      });
    }

    this.options.auditLogger.logEvent({
      actor: { type: 'user', id: principalId },
      tenant_id: tenantId,
      action: 'channel:telegram_message_received',
      resource: { type: 'TelegramChat', id: String(chatId) },
      result: 'SUCCESS',
      request_id: requestId,
      details: { text, telegramUserId: tgUserId, username: msg.from.username },
    });

    // 2. Fetch Relevant Memory Context & Conversation Context
    const memories = this.options.getMemories(tenantId, principalId, text);
    const conversation = this.options.conversationContextService?.buildContext({
      tenantId,
      principalId,
      sessionId: session.sessionId,
    });

    // 3. Process Intent via AI Service (Chat or Plan Preview)
    let responseText = '';
    let planGenerated = false;

    // Check if intent looks like an action plan or simple chat
    if (this.isActionIntent(text)) {
      const planRes = await this.options.aiService.plan({
        prompt: text,
        memories,
        conversation,
        mode: 'auto',
        requestId,
      });

      const resolved = this.options.planResolver.resolve(planRes.data);
      planGenerated = true;

      const stepsList = resolved.steps
        .map((s, idx) => `${idx + 1}. <b>${this.escapeHtml(s.title)}</b> (${this.escapeHtml(s.tool || 'System')})`)
        .join('\n');

      responseText = `🤖 <b>NAgex Action Plan</b>\n\nGoal: <i>${this.escapeHtml(resolved.goal)}</i>\n\n<b>Steps:</b>\n${stepsList}\n\n<i>To review or execute approval-gated steps, open your NAgex Control Center.</i>`;
    } else {
      const chatRes = await this.options.aiService.chat({
        message: text,
        conversation,
        mode: 'auto',
        requestId,
      });
      responseText = chatRes.data.message || 'I processed your request.';
    }

    // Persist ASSISTANT message if conversation store is provided
    if (this.options.conversationStore) {
      this.options.conversationStore.append({
        tenantId,
        principalId,
        sessionId: session.sessionId,
        role: 'ASSISTANT',
        source: 'TELEGRAM',
        content: responseText,
        requestId,
      });
    }

    // 4. Send Response Back to Telegram
    await this.options.botClient.sendMessage({
      chatId,
      text: responseText,
      replyToMessageId: msg.message_id,
    });

    this.options.auditLogger.logEvent({
      actor: { type: 'system', id: 'telegram-service' },
      tenant_id: tenantId,
      action: 'channel:telegram_response_sent',
      resource: { type: 'TelegramChat', id: String(chatId) },
      result: 'SUCCESS',
      request_id: requestId,
    });

    return {
      ok: true,
      chatId,
      principalId,
      sessionId: session.sessionId,
      responseText,
      planGenerated,
    };
  }

  private isActionIntent(text: string): boolean {
    const actionKeywords = ['schedule', 'email', 'meeting', 'send', 'create', 'update', 'cancel', 'check', 'book', 'draft'];
    const lower = text.toLowerCase();
    return actionKeywords.some((kw) => lower.includes(kw));
  }

  private escapeHtml(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}
