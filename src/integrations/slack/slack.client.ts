export interface SlackEventItem {
  type: string;
  user?: string;
  text?: string;
  channel?: string;
  ts?: string;
  thread_ts?: string;
  bot_id?: string;
  subtype?: string;
}

export interface SlackEventPayload {
  type: 'url_verification' | 'event_callback';
  challenge?: string;
  token?: string;
  team_id?: string;
  event_id?: string;
  event_time?: number;
  event?: SlackEventItem;
}

export interface PostMessageOptions {
  channel: string;
  text: string;
  threadTs?: string;
}

export interface SlackBotStatus {
  configured: boolean;
  botId: string | null;
  teamName: string | null;
}

export class SlackClient {
  private readonly token: string | null;
  private readonly baseUrl = 'https://slack.com/api';

  constructor(token?: string | null, private readonly fetchFn = fetch) {
    this.token = token || process.env.SLACK_BOT_TOKEN || null;
  }

  public isConfigured(): boolean {
    return Boolean(this.token);
  }

  public getStatus(): SlackBotStatus {
    return {
      configured: Boolean(this.token),
      botId: process.env.SLACK_BOT_ID || null,
      teamName: process.env.SLACK_TEAM_NAME || null,
    };
  }

  public async postMessage(options: PostMessageOptions): Promise<{ ok: boolean; ts?: string }> {
    if (!this.token) {
      // Mock mode for offline testing without bot token
      return { ok: true, ts: String(Date.now() / 1000) };
    }

    const payload = {
      channel: options.channel,
      text: options.text,
      thread_ts: options.threadTs,
    };

    try {
      const res = await this.fetchFn(`${this.baseUrl}/chat.postMessage`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as any;
      return { ok: Boolean(data.ok), ts: data.ts };
    } catch (error) {
      console.error('Slack postMessage error:', error);
      return { ok: false };
    }
  }
}
