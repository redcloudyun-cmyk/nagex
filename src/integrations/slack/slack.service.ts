import type { AiService } from '../../model-gateway/ai-service.js';
import type { SessionStore } from '../../sessions/session.store.js';
import type { AuditLogger } from '../../governance/audit.logger.js';
import type { MemoryRecord } from '../../context/memory.engine.js';
import type { PlanResolver } from '../../planning/plan-resolver.js';
import { SlackClient, type SlackEventPayload } from './slack.client.js';
import { SlackIdentityStore } from './slack-identity.store.js';
import { NagexError } from '../../common/errors.js';
import { ChannelLinkChallengeStore, parseChannelLinkCommand } from '../channel-link-challenge.store.js';

import type { ConversationStore } from '../../conversations/conversation.store.js';
import type { ConversationContextService } from '../../conversations/conversation-context.service.js';

export interface SlackServiceOptions {
  slackClient: SlackClient;
  identityStore: SlackIdentityStore;
  sessionStore: SessionStore;
  aiService: AiService;
  planResolver: PlanResolver;
  getMemories: (tenantId: string, principalId: string, prompt: string) => MemoryRecord[];
  auditLogger: AuditLogger;
  conversationStore?: ConversationStore;
  conversationContextService?: ConversationContextService;
  // S2B — ownership-proof challenges. Defaults to a private store; the route that issues a challenge and the events
  // endpoint that redeems it always reach the same store through this service.
  challengeStore?: ChannelLinkChallengeStore;
}

export interface SlackProcessResult {
  ok: boolean;
  channel: string;
  principalId: string;
  sessionId: string;
  responseText: string;
  planGenerated?: boolean;
  challenge?: string;
  // S2B — set when the message was an ownership-proof (link) attempt rather than a chat message
  linkOutcome?: 'LINKED' | 'DENIED';
}

export class SlackService {
  private readonly challenges: ChannelLinkChallengeStore;

  constructor(private readonly options: SlackServiceOptions) {
    this.challenges = options.challengeStore ?? new ChannelLinkChallengeStore();
  }

  // ── S2B: ownership of a Slack account is proven FROM Slack ──
  public createLinkChallenge(principalId: string, tenantId: string): { token: string; expiresAt: string; ttlSeconds: number } {
    return this.challenges.issue('slack', principalId, tenantId);
  }

  public listLinks(principalId: string, tenantId: string): ReturnType<SlackIdentityStore['listForPrincipal']> {
    return this.options.identityStore.listForPrincipal(principalId, tenantId);
  }

  public unlinkAll(principalId: string, tenantId: string): number {
    return this.options.identityStore.unlinkForPrincipal(principalId, tenantId);
  }

  // Runs on the signed event only (S2A). The Slack user id and the workspace (team) id are the platform's own data; the
  // code in the text only selects WHICH challenge is being redeemed. Nothing here touches the conversation, memory or the
  // model, and the code is never persisted or logged.
  private async redeemLinkChallenge(payload: SlackEventPayload, code: string, malformed: boolean, requestId: string): Promise<SlackProcessResult> {
    const event = payload.event!;
    const slackUserId = event.user!;
    const channel = event.channel!;
    const teamId = typeof payload.team_id === 'string' ? payload.team_id.trim() : '';
    let outcome: 'LINKED' | 'DENIED' = 'DENIED';
    let reason = 'INVALID_CHALLENGE';
    let reply = 'This link code is invalid or has expired. Create a new one in NAgex and send it here again.';
    let linkedPrincipal = '';
    let linkedTenant = `ten_slack_${slackUserId}`;

    // consume + link are one synchronous step: no await between them, so a challenge cannot be spent twice
    const consumed = this.challenges.consume('slack', code);
    if (!consumed.ok) {
      reason = consumed.reason;
    } else if (malformed) {
      // a code followed by other text is not a valid command; the code is spent
      reason = 'MALFORMED_COMMAND';
    } else if (event.channel_type !== 'im' || !teamId || payload.type !== 'event_callback') {
      // proof must come from the person's own direct message and name the workspace; a code sent anywhere else is
      // treated as exposed and is spent
      reason = 'NOT_DIRECT_MESSAGE';
    } else {
      try {
        const record = this.options.identityStore.link(slackUserId, consumed.principalId, consumed.tenantId, teamId);
        outcome = 'LINKED';
        reason = 'OWNERSHIP_PROVEN';
        linkedPrincipal = record.principalId;
        linkedTenant = record.tenantId;
        reply = 'Your Slack account is now linked to the NAgex account that created this code.';
      } catch (error) {
        if (error instanceof NagexError && error.code === 'CHANNEL_IDENTITY_ALREADY_LINKED') {
          reason = 'ALREADY_LINKED';
          reply = 'This Slack account is already linked to a NAgex account. Unlink it there first, then create a new code.';
        } else {
          throw error;
        }
      }
    }

    this.options.auditLogger.logEvent({
      actor: outcome === 'LINKED' ? { type: 'user', id: linkedPrincipal } : { type: 'system', id: 'slack-service' },
      tenant_id: linkedTenant,
      action: outcome === 'LINKED' ? 'channel:slack_identity_linked' : 'channel:slack_identity_link_denied',
      resource: { type: 'SlackIdentityLink', id: slackUserId },
      result: outcome === 'LINKED' ? 'SUCCESS' : 'DENIED',
      reason_code: reason,
      request_id: requestId,
      details: { slackUserId, slackTeamId: teamId || undefined, proof: 'CHALLENGE' },
    });

    await this.options.slackClient.postMessage({ channel, text: reply });
    return { ok: outcome === 'LINKED', channel, principalId: linkedPrincipal, sessionId: '', responseText: reply, linkOutcome: outcome };
  }

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

    // S2B — an ownership-proof attempt is handled here, before identity resolution, conversation, memory or the model.
    const linkAttempt = parseChannelLinkCommand('slack', event.text);
    if (linkAttempt) return this.redeemLinkChallenge(payload, linkAttempt.code, linkAttempt.trailing !== '', requestId);

    const slackUserId = event.user;
    const channel = event.channel;
    const text = event.text.trim();

    // 2. Identity Resolution -> Canonical Principal & Tenant (AC-13)
    const { principalId, tenantId } = this.options.identityStore.resolve(slackUserId, payload.team_id);
    const session = this.options.sessionStore.getOrCreateMain(tenantId, principalId);

    // Persist USER message if conversation store is provided
    if (this.options.conversationStore) {
      this.options.conversationStore.append({
        tenantId,
        principalId,
        sessionId: session.sessionId,
        role: 'USER',
        source: 'SLACK',
        content: text,
        requestId,
      });
    }

    this.options.auditLogger.logEvent({
      actor: { type: 'user', id: principalId },
      tenant_id: tenantId,
      action: 'channel:slack_message_received',
      resource: { type: 'SlackChannel', id: channel },
      result: 'SUCCESS',
      request_id: requestId,
      details: { text, slackUserId, teamId: payload.team_id },
    });

    // 3. Fetch Relevant Memories & Conversation Context
    const memories = this.options.getMemories(tenantId, principalId, text);
    const conversation = this.options.conversationContextService?.buildContext({
      tenantId,
      principalId,
      sessionId: session.sessionId,
    });

    // 4. Process Intent via AI Service
    let responseText = '';
    let planGenerated = false;

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
        .map((s, idx) => `${idx + 1}. *${s.title}* (${s.tool || 'System'})`)
        .join('\n');

      responseText = `🤖 *NAgex Action Plan*\n\nGoal: _${resolved.goal}_\n\n*Steps:*\n${stepsList}\n\n_To review or execute approval-gated steps, open your NAgex Control Center._`;
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
        source: 'SLACK',
        content: responseText,
        requestId,
      });
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
