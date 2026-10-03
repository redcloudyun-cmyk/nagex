import type { ChannelSendFailureReason } from '../channel-send.js';

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

export interface TelegramSendResult {
  ok: boolean;
  messageId?: number;
  // set when ok is false (S2C): never a successful delivery
  reason?: ChannelSendFailureReason;
}

export interface SendMessageOptions {
  chatId: number | string;
  text: string;
  parseMode?: 'Markdown' | 'HTML';
  replyToMessageId?: number;
}

export interface TelegramBotStatus {
  configured: boolean;
  botUsername: string | null;
  botName: string | null;
}

export class TelegramBotClient {
  private readonly token: string | null;
  private readonly baseUrl: string;

  constructor(token?: string | null, private readonly fetchFn = fetch) {
    this.token = token || process.env.TELEGRAM_BOT_TOKEN || null;
    this.baseUrl = this.token ? `https://api.telegram.org/bot${this.token}` : '';
  }

  public isConfigured(): boolean {
    return Boolean(this.token);
  }

  public getStatus(): TelegramBotStatus {
    return {
      configured: Boolean(this.token),
      botUsername: process.env.TELEGRAM_BOT_USERNAME || null,
      botName: process.env.TELEGRAM_BOT_NAME || null,
    };
  }

  public async getMe(): Promise<TelegramBotStatus> {
    if (!this.token) {
      return { configured: false, botUsername: null, botName: null };
    }
    try {
      const res = await this.fetchFn(`${this.baseUrl}/getMe`);
      const data = (await res.json()) as any;
      if (data.ok && data.result) {
        return {
          configured: true,
          botUsername: data.result.username || null,
          botName: data.result.first_name || null,
        };
      }
      return { configured: false, botUsername: null, botName: null };
    } catch {
      return { configured: false, botUsername: null, botName: null };
    }
  }

  // S2C — truthful result. Nothing is delivered without a bot credential, so that is a failure (it used to be a fake
  // success), and a provider rejection or a network failure are failures too.
  public async sendMessage(options: SendMessageOptions): Promise<TelegramSendResult> {
    if (!this.token) return { ok: false, reason: 'NO_PROVIDER_CREDENTIAL' };

    const payload = {
      chat_id: options.chatId,
      text: options.text,
      parse_mode: options.parseMode || 'HTML',
      reply_to_message_id: options.replyToMessageId,
    };

    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch {
      // the error object is deliberately not logged: the request URL carries the bot token
      return { ok: false, reason: 'NETWORK_FAILURE' };
    }
    try {
      const data = (await res.json()) as any;
      return data && data.ok === true ? { ok: true, messageId: data.result?.message_id } : { ok: false, reason: 'PROVIDER_REJECTION' };
    } catch {
      return { ok: false, reason: 'PROVIDER_REJECTION' };
    }
  }

  public async setWebhook(url: string, secretToken?: string): Promise<boolean> {
    if (!this.token) return false;
    try {
      const res = await this.fetchFn(`${this.baseUrl}/setWebhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, secret_token: secretToken }),
      });
      const data = (await res.json()) as any;
      return Boolean(data.ok);
    } catch {
      return false;
    }
  }
}
