// R10.2-D Increment 4 — Gmail routes, extracted verbatim from
// server_web.ts's handleAsyncApiRequest. Every mutation route
// (send-email/reply/create-draft) requires a pre-existing approvalId and
// calls GmailService.executeXxx(), which is itself built on R10.2-B's
// GoogleCapabilityExecutionPipeline — the canonical, approval-gated
// execution chokepoint for all Gmail mutations. This module never
// constructs a payload write itself and never imports gmail.client.ts
// directly; it only translates HTTP <-> GmailService.
import crypto from 'node:crypto';
import { NagexError } from '../../common/errors.js';
import type { GmailService } from '../../modules/gmail/index.js';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';
import { callerIdentity } from '../request-identity.js';

function getHeaderValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export interface GmailRouteDeps {
  gmailApiService: GmailService;
}

export const handleGmailRoutes: AsyncRouteRegistrar<GmailRouteDeps> = async (method, pathname, body, headers, _query, deps): Promise<ApiResult | undefined> => {
  const { gmailApiService } = deps;

  if (pathname === '/api/v1/tools/gmail/send-email' && method === 'POST') {
    const tenantId = callerIdentity(headers).tenantId;
    const principalId = callerIdentity(headers).principalId;
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
    const approvalId = typeof body?.approvalId === 'string' ? body.approvalId : '';
    if (!approvalId) throw new NagexError({ code: 'APPROVAL_ID_REQUIRED', category: 'VALIDATION', message: 'approvalId is required.', request_id: requestId });
    const result = await gmailApiService.executeSendEmail({ approvalId, payload: body?.payload, tenantId, principalId, requestId });
    return { status: 200, data: result };
  }

  if (pathname === '/api/v1/tools/gmail/reply' && method === 'POST') {
    const tenantId = callerIdentity(headers).tenantId;
    const principalId = callerIdentity(headers).principalId;
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
    const approvalId = typeof body?.approvalId === 'string' ? body.approvalId : '';
    if (!approvalId) throw new NagexError({ code: 'APPROVAL_ID_REQUIRED', category: 'VALIDATION', message: 'approvalId is required.', request_id: requestId });
    const result = await gmailApiService.executeReply({ approvalId, payload: body?.payload, tenantId, principalId, requestId });
    return { status: 200, data: result };
  }

  if (pathname === '/api/v1/tools/gmail/create-draft' && method === 'POST') {
    const tenantId = callerIdentity(headers).tenantId;
    const principalId = callerIdentity(headers).principalId;
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
    const approvalId = typeof body?.approvalId === 'string' ? body.approvalId : '';
    if (!approvalId) throw new NagexError({ code: 'APPROVAL_ID_REQUIRED', category: 'VALIDATION', message: 'approvalId is required.', request_id: requestId });
    const result = await gmailApiService.executeCreateDraft({ approvalId, payload: body?.payload, tenantId, principalId, requestId });
    return { status: 200, data: result };
  }

  if (pathname === '/api/v1/tools/gmail/search' && method === 'POST') {
    const tenantId = callerIdentity(headers).tenantId;
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
    const principalId = callerIdentity(headers).principalId;
    const query = typeof body?.query === 'string' ? body.query : '';
    const result = await gmailApiService.search({ tenantId, principalId, query, requestId });
    return { status: 200, data: result };
  }

  if (pathname === '/api/v1/tools/gmail/read-thread' && method === 'POST') {
    const tenantId = callerIdentity(headers).tenantId;
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
    const threadId = typeof body?.threadId === 'string' ? body.threadId : '';
    if (!threadId) throw new NagexError({ code: 'THREAD_ID_REQUIRED', category: 'VALIDATION', message: 'threadId is required.', request_id: requestId });
    const principalId = callerIdentity(headers).principalId;
    const result = await gmailApiService.readThread({ tenantId, principalId, threadId, requestId });
    return { status: 200, data: result };
  }

  return undefined;
};
