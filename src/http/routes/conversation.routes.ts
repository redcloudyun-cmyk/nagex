// R10.2-D Increment 5 — Main Session / conversational core routes,
// extracted verbatim from server_web.ts. Two registrars, matching the two
// real dispatch entry points the original inline blocks lived in:
//   - handleConversationRoutes (async) — conversations/main GET/POST-
//     messages/DELETE, ai/chat, ambient/intent, plans/resolve. All of
//     these translate HTTP <-> the existing SessionStore/ConversationStore/
//     ConversationContextService/AiService/PlanResolver/MemoryEngine
//     layers; none of them absorb planning, memory, model-routing, or
//     conversation-state logic themselves — that all still lives in those
//     services, exactly as before this move.
//   - handleSessionRoutes (sync) — GET /api/v1/sessions/main, originally
//     inline in handleApiRequest.
// This file intentionally does NOT introduce new clarification/intent
// logic (out of scope per the governing directive) — it is a routing/
// composition move only.
import crypto from 'node:crypto';
import { NagexError } from '../../common/errors.js';
import type { PrincipalReference } from '../../common/types.js';
import { DEFAULT_GOOGLE_TENANT_ID } from '../../integrations/google/token.store.js';
import type { AiService, PlanPreview } from '../../model-gateway/ai-service.js';
import { parseRoutingMode } from '../../model-gateway/ai-service.js';
import type { PlanResolver } from '../../planning/plan-resolver.js';
import type { SessionStore } from '../../sessions/session.store.js';
import type { ConversationStore } from '../../conversations/conversation.store.js';
import type { ConversationContextService } from '../../conversations/conversation-context.service.js';
import type { AuditLogger } from '../../governance/audit.logger.js';
import type { MemoryRecord } from '../../context/memory.engine.js';
import type { ApiResult, SyncRouteRegistrar, AsyncRouteRegistrar } from '../http-types.js';

function getHeaderValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

import type { ConversationMemoryExtractor } from '../../context/conversation-memory-extractor.js';

export interface ConversationRouteDeps {
  service: AiService;
  planResolver: PlanResolver;
  sessionStore: SessionStore;
  convStore: ConversationStore;
  convContextService: ConversationContextService;
  auditLogger: AuditLogger;
  getRelevantMemories: (tenantId: string, principalId: string, prompt: string) => MemoryRecord[];
  memoryExtractor?: ConversationMemoryExtractor;
}

export const handleConversationRoutes: AsyncRouteRegistrar<ConversationRouteDeps> = async (method, pathname, body, headers, _query, deps): Promise<ApiResult | undefined> => {
  const { service, planResolver, sessionStore, convStore, convContextService, auditLogger, getRelevantMemories } = deps;

  if (pathname === '/api/v1/conversations/main' && method === 'GET') {
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
    const principalId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_conv_get_${crypto.randomUUID()}`;
    const session = sessionStore.getOrCreateMain(tenantId, principalId);
    const messages = convStore.listSession(tenantId, principalId, session.sessionId)
      .filter((m) => m.status !== 'DELETED');

    auditLogger.logEvent({
      actor: { type: 'user', id: principalId },
      tenant_id: tenantId,
      action: 'conversation.context.loaded',
      resource: { type: 'Session', id: session.sessionId },
      result: 'SUCCESS',
      request_id: requestId,
      details: { sessionId: session.sessionId, messageCount: messages.length },
    });

    return {
      status: 200,
      data: {
        session: { sessionId: session.sessionId, type: session.type },
        messages,
      },
    };
  }
  if (pathname === '/api/v1/conversations/main/messages' && method === 'POST') {
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
    const principalId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_conv_msg_${crypto.randomUUID()}`;
    const content = typeof body?.content === 'string' ? body.content.trim() : '';
    if (!content) {
      throw new NagexError({ code: 'INVALID_CONVERSATION_PAYLOAD', category: 'VALIDATION', message: 'content is required.', request_id: requestId });
    }
    const role = (typeof body?.role === 'string' ? body.role : 'USER') as any;
    const source = (typeof body?.source === 'string' ? body.source : 'WEB') as any;
    const session = sessionStore.getOrCreateMain(tenantId, principalId);

    const record = convStore.append({
      tenantId,
      principalId,
      sessionId: session.sessionId,
      role,
      source,
      content,
      requestId,
    });

    auditLogger.logEvent({
      actor: { type: 'user', id: principalId },
      tenant_id: tenantId,
      action: 'conversation.message.created',
      resource: { type: 'ConversationMessage', id: record.messageId },
      result: 'SUCCESS',
      request_id: requestId,
      details: { sessionId: session.sessionId, messageId: record.messageId, role: record.role, source: record.source },
    });

    return { status: 201, data: record };
  }
  if (pathname === '/api/v1/conversations/main' && method === 'DELETE') {
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
    const principalId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_conv_del_${crypto.randomUUID()}`;
    const session = sessionStore.getOrCreateMain(tenantId, principalId);
    const clearedCount = convStore.deleteSession(tenantId, principalId, session.sessionId);

    auditLogger.logEvent({
      actor: { type: 'user', id: principalId },
      tenant_id: tenantId,
      action: 'conversation.session.cleared',
      resource: { type: 'Session', id: session.sessionId },
      result: 'SUCCESS',
      request_id: requestId,
      details: { sessionId: session.sessionId, clearedCount },
    });

    return { status: 200, data: { clearedCount } };
  }
  if (pathname === '/api/v1/ai/chat' && method === 'POST') {
    const message = typeof body?.message === 'string' ? body.message.trim() : '';
    if (!message) throw new NagexError({ code: 'MESSAGE_REQUIRED', category: 'VALIDATION', message: 'message is required.', request_id: `req_${crypto.randomUUID()}` });
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
    const principalId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_chat_${crypto.randomUUID()}`;
    const session = sessionStore.getOrCreateMain(tenantId, principalId);

    // Section 6: Persist USER message BEFORE AI reasoning
    const userMsgRecord = convStore.append({
      tenantId,
      principalId,
      sessionId: session.sessionId,
      role: 'USER',
      source: 'WEB',
      content: message,
      requestId,
    });

    auditLogger.logEvent({
      actor: { type: 'user', id: principalId },
      tenant_id: tenantId,
      action: 'conversation.message.created',
      resource: { type: 'ConversationMessage', id: userMsgRecord.messageId },
      result: 'SUCCESS',
      request_id: requestId,
      details: { sessionId: session.sessionId, messageId: userMsgRecord.messageId, role: 'USER', source: 'WEB' },
    });

    const conversation = convContextService.buildContext({
      tenantId,
      principalId,
      sessionId: session.sessionId,
    });

    const memories = getRelevantMemories(tenantId, principalId, message);

    const result = await service.chat({
      message,
      conversation,
      memories,
      mode: parseRoutingMode(body?.provider, process.env.NAGEX_MODEL_PROVIDER),
      requestId,
    });

    if (deps.memoryExtractor) {
      deps.memoryExtractor.processMessage({
        tenantId,
        principalId,
        sessionId: session.sessionId,
        messageId: userMsgRecord.messageId,
        content: message,
        modelProvider: result.provider,
        modelName: result.model,
      });
    }

    // Section 6: Persist ASSISTANT message AFTER successful AI response
    const assistantMsgRecord = convStore.append({
      tenantId,
      principalId,
      sessionId: session.sessionId,
      role: 'ASSISTANT',
      source: 'WEB',
      content: result.data.message,
      requestId,
    });

    auditLogger.logEvent({
      actor: { type: 'user', id: principalId },
      tenant_id: tenantId,
      action: 'conversation.message.created',
      resource: { type: 'ConversationMessage', id: assistantMsgRecord.messageId },
      result: 'SUCCESS',
      request_id: requestId,
      details: { sessionId: session.sessionId, messageId: assistantMsgRecord.messageId, role: 'ASSISTANT', source: 'WEB' },
    });

    return { status: 200, data: result };
  }
  if (pathname === '/api/v1/ambient/intent' && method === 'POST') {
    const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt) throw new NagexError({ code: 'PROMPT_REQUIRED', category: 'VALIDATION', message: 'prompt is required.', request_id: `req_${crypto.randomUUID()}` });
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
    const principalId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_intent_${crypto.randomUUID()}`;
    const session = sessionStore.getOrCreateMain(tenantId, principalId);

    // Section 6: Persist USER message BEFORE AI reasoning
    const userMsgRecord = convStore.append({
      tenantId,
      principalId,
      sessionId: session.sessionId,
      role: 'USER',
      source: 'WEB',
      content: prompt,
      requestId,
    });

    auditLogger.logEvent({
      actor: { type: 'user', id: principalId },
      tenant_id: tenantId,
      action: 'conversation.message.created',
      resource: { type: 'ConversationMessage', id: userMsgRecord.messageId },
      result: 'SUCCESS',
      request_id: requestId,
      details: { sessionId: session.sessionId, messageId: userMsgRecord.messageId, role: 'USER', source: 'WEB' },
    });

    const conversation = convContextService.buildContext({
      tenantId,
      principalId,
      sessionId: session.sessionId,
    });

    const result = await service.plan({
      prompt,
      memories: getRelevantMemories(tenantId, principalId, prompt),
      conversation,
      mode: parseRoutingMode(body?.provider, process.env.NAGEX_MODEL_PROVIDER),
      requestId,
    });

    // Section 6: Persist ASSISTANT message AFTER successful AI generation
    const assistantContent = result.data.summary || result.data.goal || 'Plan generated.';
    const assistantMsgRecord = convStore.append({
      tenantId,
      principalId,
      sessionId: session.sessionId,
      role: 'ASSISTANT',
      source: 'WEB',
      content: assistantContent,
      requestId,
    });

    auditLogger.logEvent({
      actor: { type: 'user', id: principalId },
      tenant_id: tenantId,
      action: 'conversation.message.created',
      resource: { type: 'ConversationMessage', id: assistantMsgRecord.messageId },
      result: 'SUCCESS',
      request_id: requestId,
      details: { sessionId: session.sessionId, messageId: assistantMsgRecord.messageId, role: 'ASSISTANT', source: 'WEB' },
    });

    return { status: 200, data: { status: 'PLAN_PREVIEW', message: 'Plan generated. Review it before any tools are executed.', plan: result.data, provider: result.provider, model: result.model, latencyMs: result.latencyMs, requestId: result.requestId } };
  }
  if (pathname === '/api/v1/plans/resolve' && method === 'POST') {
    const candidate = body?.plan && typeof body.plan === 'object' ? body.plan : body;
    return { status: 200, data: planResolver.resolve(candidate as unknown as PlanPreview) };
  }

  return undefined;
};

export interface SessionRouteDeps {
  sessionStore: SessionStore;
  tenantId: string;
  principal: PrincipalReference;
}

export const handleSessionRoutes: SyncRouteRegistrar<SessionRouteDeps> = (method, pathname, _body, _headers, _query, deps): ApiResult | undefined => {
  const { sessionStore, tenantId, principal } = deps;

  if (pathname === '/api/v1/sessions/main' && method === 'GET') {
    const session = sessionStore.getOrCreateMain(tenantId, principal.id);
    return { status: 200, data: session };
  }

  return undefined;
};
