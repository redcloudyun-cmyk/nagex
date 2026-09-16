// R10.2-D Increment 4 — Slack integration routes (MASTER.md Section 14.5
// item 11), extracted verbatim from server_web.ts's handleAsyncApiRequest.
import crypto from 'node:crypto';
import { NagexError } from '../../common/errors.js';
import { DEFAULT_GOOGLE_TENANT_ID } from '../../integrations/google/token.store.js';
import type { SlackIdentityStore } from '../../integrations/slack/slack-identity.store.js';
import type { SlackClient, SlackEventPayload } from '../../integrations/slack/slack.client.js';
import type { SlackService } from '../../integrations/slack/slack.service.js';
import type { AuditLogger } from '../../governance/audit.logger.js';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';

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
  if (pathname === '/api/v1/integrations/slack/identity/link' && method === 'POST') {
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_slack_link_${crypto.randomUUID()}`;
    const slackUserId = String(body?.slackUserId || '').trim();
    const principalId = typeof body?.principalId === 'string' && body.principalId.trim() ? body.principalId.trim() : (getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001');
    const tenantId = typeof body?.tenantId === 'string' && body.tenantId.trim() ? body.tenantId.trim() : (getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID);
    const slackTeamId = typeof body?.slackTeamId === 'string' ? body.slackTeamId.trim() : undefined;
    const username = typeof body?.username === 'string' ? body.username.trim() : undefined;

    if (!slackUserId) {
      throw new NagexError({ code: 'SLACK_USER_ID_REQUIRED', category: 'VALIDATION', message: 'slackUserId is required.', request_id: requestId });
    }
    const record = slackIdentityStore.link(slackUserId, principalId, tenantId, slackTeamId, username);
    auditLogger.logEvent({
      actor: { type: 'user', id: principalId },
      tenant_id: tenantId,
      action: 'channel:slack_identity_linked',
      resource: { type: 'SlackIdentityLink', id: slackUserId },
      result: 'SUCCESS',
      request_id: requestId,
      details: { slackUserId, principalId, tenantId, slackTeamId, username },
    });
    return { status: 200, data: record };
  }
  if (pathname === '/api/v1/integrations/slack/identities' && method === 'GET') {
    const identities = slackIdentityStore.list();
    return { status: 200, data: { identities, total: identities.length } };
  }

  return undefined;
};
