import type { AiService } from '../../model-gateway/ai-service.js';
import type { SessionStore } from '../../sessions/session.store.js';
import type { AuditLogger } from '../../governance/audit.logger.js';
import type { MemoryRecord } from '../../context/memory.engine.js';
import type { PlanResolver } from '../../planning/plan-resolver.js';
import { TelegramBotClient, type TelegramUpdate } from './telegram.client.js';
import { TelegramIdentityStore } from './telegram-identity.store.js';

export interface TelegramServiceOptions {
  botClient: TelegramBotClient;
  identityStore: TelegramIdentityStore;
  sessionStore: SessionStore;
  aiService: AiService;
  planResolver: PlanResolver;
  getMemories: (principalId: string, prompt: string) => MemoryRecord[];
  auditLogger: AuditLogger;
}

export interface TelegramProcessResult {
  ok: boolean;
  chatId: number | string;
  principalId: string;
  sessionId: string;
  responseText: string;
  planGenerated?: boolean;
}

export class TelegramService {
  constructor(private readonly options: TelegramServiceOptions) {}

  public async processUpdate(update: TelegramUpdate, requestId = `req_tg_${Date.now()}`): Promise<TelegramProcessResult | null> {
    const msg = update.message || update.edited_message;
    if (!msg || !msg.from || !msg.text?.trim()) {
      return null;
    }

    const tgUserId = String(msg.from.id);
    const chatId = msg.chat.id;
    const text = msg.text.trim();

    // 1. Resolve Identity -> Principal & Tenant (AC-13)
    const { principalId, tenantId } = this.options.identityStore.resolve(tgUserId);
    const session = this.options.sessionStore.getOrCreateMain(tenantId, principalId);

    this.options.auditLogger.logEvent({
      actor: { type: 'user', id: principalId },
      tenant_id: tenantId,
      action: 'channel:telegram_message_received',
      resource: { type: 'TelegramChat', id: String(chatId) },
      result: 'SUCCESS',
      request_id: requestId,
      details: { text, telegramUserId: tgUserId, username: msg.from.username },
    });

    // 2. Fetch Relevant Memory Context
    const memories = this.options.getMemories(principalId, text);

    // 3. Process Intent via AI Service (Chat or Plan Preview)
    let responseText = '';
    let planGenerated = false;

    // Check if intent looks like an action plan or simple chat
    if (this.isActionIntent(text)) {
      const planRes = await this.options.aiService.plan({
        prompt: text,
        memories,
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
        mode: 'auto',
        requestId,
      });
      responseText = chatRes.data.message || 'I processed your request.';
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
