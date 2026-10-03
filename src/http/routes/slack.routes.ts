// R10.2-D Increment 4 — Slack integration routes (MASTER.md Section 14.5
// item 11), extracted verbatim from server_web.ts's handleAsyncApiRequest.
import crypto from 'node:crypto';
import { NagexError } from '../../common/errors.js';
import type { SlackIdentityStore } from '../../integrations/slack/slack-identity.store.js';
import type { SlackClient, SlackEventPayload } from '../../integrations/slack/slack.client.js';
import type { SlackService } from '../../integrations/slack/slack.service.js';
import type { AuditLogger } from '../../governance/audit.logger.js';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';
import { callerIdentity } from '../request-identity.js';
import { getRawBody } from '../raw-body.js';
import { SignedRequestReplayGuard, verifySlackWebhook, webhookRejection } from '../../integrations/webhook-auth.js';

// S2A — a signed delivery is processed once inside Slack's replay window.
const slackReplayGuard = new SignedRequestReplayGuard();

function getHeaderValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export interface SlackRouteDeps {
  slackClient: SlackClient;
  slackApiService: SlackService;
  slackIdentityStore: SlackIdentityStore;
  auditLogger: AuditLogger;
}

export const handleSlackRoutes: AsyncRouteRegistrar<SlackRouteDeps> = async (method, pathname, body, headers, _query, deps): Promise<ApiResult | undefined> => {
  const { slackClient, slackApiService, slackIdentityStore, auditLogger } = deps;

  if (pathname === '/api/v1/integrations/slack/status' && method === 'GET') {
    return { status: 200, data: slackClient.getStatus() };
  }
  if (pathname === '/api/v1/integrations/slack/events' && method === 'POST') {
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_slack_evt_${crypto.randomUUID()}`;
    // S2A — authenticity BEFORE trust, including the url_verification challenge: the signature is checked over the
    // authentic raw body and the timestamp must be inside the replay window. Fails closed without a signing secret.
    const verdict = verifySlackWebhook(headers, getRawBody(body));
    if (!verdict.ok) return webhookRejection('slack', verdict, requestId);
    if (verdict.signature && slackReplayGuard.checkAndRemember(verdict.signature)) {
      return { status: 200, data: { status: 'ok', handled: false, duplicate: true, result: null } };
    }
    const payload = (body || {}) as unknown as SlackEventPayload;
    if (payload.type === 'url_verification' && payload.challenge) {
      return { status: 200, data: { challenge: payload.challenge } };
    }
    const result = await slackApiService.processEvent(payload, requestId);
    return { status: 200, data: { status: 'ok', handled: result !== null, result } };
  }
  if (pathname === '/api/v1/integrations/slack/send' && method === 'POST') {
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_slack_send_${crypto.randomUUID()}`;
    const channel = typeof body?.channel === 'string' ? body.channel.trim() : '';
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    const threadTs = typeof body?.threadTs === 'string' ? body.threadTs.trim() : undefined;
    if (!channel || !text) {
      throw new NagexError({ code: 'INVALID_SLACK_SEND_PAYLOAD', category: 'VALIDATION', message: 'channel and text are required.', request_id: requestId });
    }
    const sent = await slackClient.postMessage({ channel, text, threadTs });
    return { status: 200, data: { success: sent } };
  }
  // S2B — the browser can no longer say "I own Slack user X". A signed-in caller asks for a one-time challenge and proves
  // ownership FROM Slack (see SlackService.redeemLinkChallenge, behind the S2A-authenticated events endpoint):
  // the link is created there from the platform-verified sender, bound to the principal and tenant that issued the challenge.
  if (pathname === '/api/v1/integrations/slack/identity/link/challenge' && method === 'POST') {
    const { principalId, tenantId } = callerIdentity(headers);
    const challenge = slackApiService.createLinkChallenge(principalId, tenantId);
    return {
      status: 201,
      headers: { 'Cache-Control': 'no-store' },
      data: {
        integration: 'slack',
        challenge: challenge.token,
        expiresAt: challenge.expiresAt,
        ttlSeconds: challenge.ttlSeconds,
        instructions: { command: `link ${challenge.token}`, note: 'Send this to the NAgex bot in a direct message from the Slack account you want to link.' },
      },
    };
  }
  if (pathname === '/api/v1/integrations/slack/identity/link' && method === 'POST') {
    callerIdentity(headers);
    throw new NagexError({ code: 'CHANNEL_LINK_PROOF_REQUIRED', category: 'VALIDATION', message: 'A Slack account is linked by proving you control it: request a link code, then send it to the NAgex bot from that Slack account. A Slack user id alone is not accepted.' });
  }
  if (pathname === '/api/v1/integrations/slack/identity' && method === 'DELETE') {
    const { principalId, tenantId } = callerIdentity(headers);
    return { status: 200, data: { unlinked: slackApiService.unlinkAll(principalId, tenantId) } };
  }
  if (pathname === '/api/v1/integrations/slack/identities' && method === 'GET') {
    // a principal sees only ITS OWN links
    const { principalId, tenantId } = callerIdentity(headers);
    const identities = slackApiService.listLinks(principalId, tenantId);
    return { status: 200, data: { identities, total: identities.length } };
  }
  return undefined;
};
