import type { ChannelSendFailureReason } from '../channel-send.js';

export interface SlackEventItem {
  type: string;
  user?: string;
  text?: string;
  channel?: string;
  ts?: string;
  thread_ts?: string;
  bot_id?: string;
  subtype?: string;
  // 'im' for a direct message to the bot (S2B ownership proof is accepted only there)
  channel_type?: string;
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

export interface SlackSendResult {
  ok: boolean;
  ts?: string;
  // set when ok is false (S2C): never a successful delivery
  reason?: ChannelSendFailureReason;
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

  // The workspace the bot token belongs to, when the operator configured it (SLACK_TEAM_ID). A send whose verified
  // link belongs to a different workspace is refused (S2C).
  public getWorkspaceId(): string | null {
    return process.env.SLACK_TEAM_ID || null;
  }

  // S2C — truthful result: no credential, a provider rejection and a network failure are failures, never a success.
  public async postMessage(options: PostMessageOptions): Promise<SlackSendResult> {
    if (!this.token) return { ok: false, reason: 'NO_PROVIDER_CREDENTIAL' };

    const payload = {
      channel: options.channel,
      text: options.text,
      thread_ts: options.threadTs,
    };

    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}/chat.postMessage`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify(payload),
      });
    } catch {
      // the error object is deliberately not logged
      return { ok: false, reason: 'NETWORK_FAILURE' };
    }
    try {
      const data = (await res.json()) as any;
      return data && data.ok === true ? { ok: true, ts: data.ts } : { ok: false, reason: 'PROVIDER_REJECTION' };
    } catch {
      return { ok: false, reason: 'PROVIDER_REJECTION' };
    }
  }
}
