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
import type { AiService, PlanPreview } from '../../model-gateway/ai-service.js';
import { parseRoutingMode } from '../../model-gateway/ai-service.js';
import type { PlanResolver } from '../../planning/plan-resolver.js';
import { defaultPlanSeal, type PlanSeal } from '../../planning/plan-seal.js';
import { assessReviewedPlan } from '../../planning/reviewed-plan-eligibility.js';
import { buildVaultSavePlan } from '../../planning/vault-save-plan.js';
import { decideRouting } from '../../workspace/input-router.js';
import { VAULT_SAVE_LIMITS } from '../../workspace/vault-save-intent.js';
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
import type { EvidencePackService } from '../../research/evidence-pack.service.js';
import type { EvidencePack } from '../../research/evidence-pack.types.js';
import { callerIdentity } from '../request-identity.js';

export interface ConversationRouteDeps {
  service: AiService;
  planResolver: PlanResolver;
  sessionStore: SessionStore;
  convStore: ConversationStore;
  convContextService: ConversationContextService;
  auditLogger: AuditLogger;
  getRelevantMemories: (tenantId: string, principalId: string, prompt: string) => MemoryRecord[];
  memoryExtractor?: ConversationMemoryExtractor;
  evidencePackService?: EvidencePackService;
  // the seal of reviewed plans (one per process); optional so tests can inject a clock
  planSeal?: PlanSeal;
}

export const handleConversationRoutes: AsyncRouteRegistrar<ConversationRouteDeps> = async (method, pathname, body, headers, _query, deps): Promise<ApiResult | undefined> => {
  const { service, planResolver, sessionStore, convStore, convContextService, auditLogger, getRelevantMemories } = deps;

  if (pathname === '/api/v1/conversations/main' && method === 'GET') {
    const tenantId = callerIdentity(headers).tenantId;
    const principalId = callerIdentity(headers).principalId;
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
    const tenantId = callerIdentity(headers).tenantId;
    const principalId = callerIdentity(headers).principalId;
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
    const tenantId = callerIdentity(headers).tenantId;
    const principalId = callerIdentity(headers).principalId;
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
    const rawInput = body?.message ?? body?.prompt;
    const message = typeof rawInput === 'string' ? rawInput.trim() : '';
    if (!message) throw new NagexError({ code: 'MESSAGE_REQUIRED', category: 'VALIDATION', message: 'message is required.', request_id: `req_${crypto.randomUUID()}` });
    const tenantId = callerIdentity(headers).tenantId;
    const principalId = callerIdentity(headers).principalId;
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

    // P0 R22.3 Closure: Run deterministic memory extraction IMMEDIATELY after USER message persistence and before model call
    if (deps.memoryExtractor) {
      deps.memoryExtractor.processMessage({
        tenantId,
        principalId,
        sessionId: session.sessionId,
        messageId: userMsgRecord.messageId,
        content: message,
      });
    }

    const conversation = convContextService.buildContext({
      tenantId,
      principalId,
      sessionId: session.sessionId,
    });

    const memories = getRelevantMemories(tenantId, principalId, message);

    let evidencePack: EvidencePack | undefined;
    if (deps.evidencePackService) {
      evidencePack = await deps.evidencePackService.buildEvidencePack(message, { requestId });
      if (evidencePack.freshnessRequirement === 'REQUIRED' && (evidencePack.status !== 'SUCCESS' || evidencePack.sources.length === 0)) {
        const notAvailMsg = evidencePack.status === 'UNAVAILABLE'
          ? "I can't verify current information right now because live web search is unavailable."
          : `I can't verify current information right now because live web search returned no verified sources (${evidencePack.status}).`;
        const botMsgRecord = convStore.append({
          tenantId,
          principalId,
          sessionId: session.sessionId,
          role: 'ASSISTANT',
          source: 'SYSTEM',
          content: notAvailMsg,
          requestId,
        });

        auditLogger.logEvent({
          actor: { type: 'user', id: principalId },
          tenant_id: tenantId,
          action: 'conversation.message.created',
          resource: { type: 'ConversationMessage', id: botMsgRecord.messageId },
          result: 'SUCCESS',
          request_id: requestId,
          details: { sessionId: session.sessionId, messageId: botMsgRecord.messageId, role: 'ASSISTANT', source: 'SYSTEM' },
        });

        return {
          status: 200,
          data: {
            message: notAvailMsg,
            messageId: botMsgRecord.messageId,
            sessionId: session.sessionId,
            freshness: evidencePack.freshnessRequirement,
            evidencePack,
            sources: [],
          },
        };
      }
    }

    const result = await service.chat({
      message,
      conversation,
      memories,
      evidencePack,
      mode: parseRoutingMode(body?.provider, process.env.NAGEX_MODEL_PROVIDER),
      requestId,
    });

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
    const tenantId = callerIdentity(headers).tenantId;
    const principalId = callerIdentity(headers).principalId;
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

    // D-9: "save this to my Vault" is planned by NAgex itself from the person's own words (no model, nothing invented). The screen may send the answer it is showing as `saveContext`;
    // it is only ever used when the request names no text of its own, and it is shown whole in the plan the person approves.
    if (decideRouting(prompt).reasonCodes.includes('VAULT_SAVE')) {
      const saveContext = typeof body?.saveContext === 'string' ? body.saveContext.slice(0, VAULT_SAVE_LIMITS.contentChars + 1) : null;
      const built = buildVaultSavePlan({ prompt, contextText: saveContext });
      const reply = built.kind === 'PLAN' ? built.plan.summary : (built.language === 'ko' ? built.message.ko : built.message.en);
      const vaultAssistant = convStore.append({ tenantId, principalId, sessionId: session.sessionId, role: 'ASSISTANT', source: 'WEB', content: reply, requestId });
      auditLogger.logEvent({
        actor: { type: 'user', id: principalId },
        tenant_id: tenantId,
        action: 'conversation.message.created',
        resource: { type: 'ConversationMessage', id: vaultAssistant.messageId },
        result: 'SUCCESS',
        request_id: requestId,
        details: { sessionId: session.sessionId, messageId: vaultAssistant.messageId, role: 'ASSISTANT', source: 'WEB' },
      });
      if (built.kind !== 'PLAN') {
        return { status: 200, data: { status: 'NEEDS_DETAIL', executable: false, reason: built.kind === 'INVALID' ? built.problem : 'NEEDS_CONTENT', message: reply, language: built.language, requestId } };
      }
      const vaultIdentity = { tenantId, principalId };
      const vaultSeal = (deps.planSeal ?? defaultPlanSeal).seal(vaultIdentity, built.plan);
      let vaultRunnable: { ok: boolean; reasons: string[]; capabilityId: string | null };
      try {
        const assessment = assessReviewedPlan(planResolver.resolve(built.plan, vaultIdentity));
        vaultRunnable = { ok: assessment.ok, reasons: assessment.reasons, capabilityId: assessment.capabilityId };
      } catch {
        vaultRunnable = { ok: false, reasons: ['PLAN_BLOCKED'], capabilityId: null };
      }
      return { status: 200, data: { status: 'PLAN_PREVIEW', message: 'Plan generated. Review it before anything is saved.', plan: built.plan, planSeal: vaultSeal, runnable: vaultRunnable, draftSource: built.source, provider: 'nagex', model: null, latencyMs: 0, requestId } };
    }

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
      identity: { tenantId, principalId },
      // The person reads this answer: an advice-only request may be answered with advice (no steps). Everything that can ever execute still needs a real plan.
      allowAdvisory: true,
    });

    const advisory = result.data.kind === 'ADVISORY';
    // Section 6: Persist ASSISTANT message AFTER successful AI generation
    const assistantContent = advisory
      ? [result.data.summary, ...(result.data.suggestions ?? []).map((s) => '- ' + s)].join(String.fromCharCode(10))
      : result.data.summary || result.data.goal || 'Plan generated.';
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
      details: { sessionId: session.sessionId, messageId: assistantMsgRecord.messageId, role: 'ASSISTANT', source: 'WEB', ...(advisory ? { responseKind: 'ADVISORY' } : {}) },
    });

    // An advisory answer is advice, not a plan: it carries NO plan object, no steps, nothing to resolve, approve or run, and says so.
    if (advisory) {
      const { goal, summary, reasoningSummary, suggestions } = result.data;
      return { status: 200, data: { status: 'ADVISORY_RESPONSE', executable: false, message: 'No actions were taken. This is advice only.', advice: { goal, summary, reasoningSummary, suggestions: suggestions ?? [] }, provider: result.provider, model: result.model, latencyMs: result.latencyMs, requestId: result.requestId } };
    }

    // A plan preview is only a preview. It is SEALED (hash + owner-bound token) so a later "request approval to run" can only ever run exactly this plan for this person,
    // and it says up front whether the existing approval machinery can take it from Home (never dispatching anything before a concrete human approval).
    const identity = { tenantId, principalId };
    const planSealIssue = (deps.planSeal ?? defaultPlanSeal).seal(identity, result.data);
    let runnable: { ok: boolean; reasons: string[]; capabilityId: string | null };
    try {
      const assessment = assessReviewedPlan(planResolver.resolve(result.data, identity));
      runnable = { ok: assessment.ok, reasons: assessment.reasons, capabilityId: assessment.capabilityId };
    } catch {
      runnable = { ok: false, reasons: ['PLAN_BLOCKED'], capabilityId: null };
    }
    return { status: 200, data: { status: 'PLAN_PREVIEW', message: 'Plan generated. Review it before any tools are executed.', plan: result.data, planSeal: planSealIssue, runnable, provider: result.provider, model: result.model, latencyMs: result.latencyMs, requestId: result.requestId } };
  }
  if (pathname === '/api/v1/plans/resolve' && method === 'POST') {
    const candidate = body?.plan && typeof body.plan === 'object' ? body.plan : body;
    const identity = callerIdentity(headers);
    return { status: 200, data: planResolver.resolve(candidate as unknown as PlanPreview, { tenantId: identity.tenantId, principalId: identity.principalId }) };
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
