import type { AiService } from '../../model-gateway/ai-service.js';
import type { SessionStore } from '../../sessions/session.store.js';
import type { AuditLogger } from '../../governance/audit.logger.js';
import type { MemoryRecord } from '../../context/memory.engine.js';
import type { PlanResolver } from '../../planning/plan-resolver.js';
import { SlackClient, type SlackEventPayload } from './slack.client.js';
import { SlackIdentityStore } from './slack-identity.store.js';

export interface SlackServiceOptions {
  slackClient: SlackClient;
  identityStore: SlackIdentityStore;
  sessionStore: SessionStore;
  aiService: AiService;
  planResolver: PlanResolver;
  getMemories: (principalId: string, prompt: string) => MemoryRecord[];
  auditLogger: AuditLogger;
}

export interface SlackProcessResult {
  ok: boolean;
  channel: string;
  principalId: string;
  sessionId: string;
  responseText: string;
  planGenerated?: boolean;
  challenge?: string;
}

export class SlackService {
  constructor(private readonly options: SlackServiceOptions) {}

  public async processEvent(payload: SlackEventPayload, requestId = `req_slack_${Date.now()}`): Promise<SlackProcessResult | null> {
    // 1. Handle URL Verification Challenge required by Slack Event API setup
    if (payload.type === 'url_verification' && payload.challenge) {
      return {
        ok: true,
        channel: '',
        principalId: '',
        sessionId: '',
        responseText: payload.challenge,
        challenge: payload.challenge,
      };
    }

    const event = payload.event;
    if (!event || event.bot_id || event.subtype || !event.text?.trim() || !event.user || !event.channel) {
      return null;
    }

    const slackUserId = event.user;
    const channel = event.channel;
    const text = event.text.trim();

    // 2. Identity Resolution -> Canonical Principal & Tenant (AC-13)
    const { principalId, tenantId } = this.options.identityStore.resolve(slackUserId);
    const session = this.options.sessionStore.getOrCreateMain(tenantId, principalId);

    this.options.auditLogger.logEvent({
      actor: { type: 'user', id: principalId },
      tenant_id: tenantId,
      action: 'channel:slack_message_received',
      resource: { type: 'SlackChannel', id: channel },
      result: 'SUCCESS',
      request_id: requestId,
      details: { text, slackUserId, teamId: payload.team_id },
    });

    // 3. Fetch Relevant Memories
    const memories = this.options.getMemories(principalId, text);

    // 4. Process Intent via AI Service
    let responseText = '';
    let planGenerated = false;

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
        .map((s, idx) => `${idx + 1}. *${s.title}* (${s.tool || 'System'})`)
        .join('\n');

      responseText = `🤖 *NAgex Action Plan*\n\nGoal: _${resolved.goal}_\n\n*Steps:*\n${stepsList}\n\n_To review or execute approval-gated steps, open your NAgex Control Center._`;
    } else {
      const chatRes = await this.options.aiService.chat({
        message: text,
        mode: 'auto',
        requestId,
      });
      responseText = chatRes.data.message || 'I processed your request.';
    }

    // 5. Send Response Back to Slack
    await this.options.slackClient.postMessage({
      channel,
      text: responseText,
      threadTs: event.thread_ts || event.ts,
    });

    this.options.auditLogger.logEvent({
      actor: { type: 'system', id: 'slack-service' },
      tenant_id: tenantId,
      action: 'channel:slack_response_sent',
      resource: { type: 'SlackChannel', id: channel },
      result: 'SUCCESS',
      request_id: requestId,
    });

    return {
      ok: true,
      channel,
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
}
