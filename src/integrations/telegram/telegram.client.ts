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

  public async sendMessage(options: SendMessageOptions): Promise<{ ok: boolean; messageId?: number }> {
    if (!this.token) {
      // Mock mode for local testing without bot token
      return { ok: true, messageId: Math.floor(Math.random() * 1000000) };
    }

    const payload = {
      chat_id: options.chatId,
      text: options.text,
      parse_mode: options.parseMode || 'HTML',
      reply_to_message_id: options.replyToMessageId,
    };

    try {
      const res = await this.fetchFn(`${this.baseUrl}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as any;
      return { ok: Boolean(data.ok), messageId: data.result?.message_id };
    } catch (error) {
      console.error('Telegram sendMessage error:', error);
      return { ok: false };
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
