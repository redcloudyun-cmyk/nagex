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
import { analyzeTurn } from '../../research/turn-analysis.js';
import { limitationNotice, liveValueRefusal, mustNotAnswerWithoutEvidence, parseWebMode } from '../../research/limitation-notice.js';
import { callerIdentity } from '../request-identity.js';
import { resolveEffectiveTimeZone } from '../../common/time-context.js';
import { classifyPlanRequest } from '../../model-gateway/plan-request-kind.js';
import { detectRequestLanguage } from '../../common/request-language.js';
import type { ScheduleClock } from '../../planning/schedule-grounding.js';
import { calendarQuestionRange, renderCalendarContext, type CalendarWindowReader } from '../../planning/calendar-context.js';
import { buildCalendarReschedulePlan, parseRescheduleRequest } from '../../planning/calendar-reschedule.js';
import type { DirectoryResult } from '../../planning/calendar-event-directory.js';

// The person's own clock for this request: the server's "now" (never the browser's) and their effective timezone - a timezone they set in their profile, else the one of the device that sent the
// request, else UTC. See common/time-context.ts.
function clockFor(deps: ConversationRouteDeps, principalId: string, body: Record<string, any> | null | undefined): ScheduleClock {
  const zone = resolveEffectiveTimeZone({
    profileTimezone: deps.getProfileTimezone ? deps.getProfileTimezone(principalId) : undefined,
    clientTimezone: body?.requestMetadata && typeof body.requestMetadata === 'object' ? body.requestMetadata.timezone : undefined,
  });
  return { nowMs: (deps.now ?? Date.now)(), timezone: zone.timezone, timezoneSource: zone.source };
}

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
  // the timezone saved in the person's profile (undefined when none), and the server clock (injectable for tests)
  getProfileTimezone?: (principalId: string) => string | undefined;
  now?: () => number;
  // reads the person's own calendar for a window (read-only); absent when the calendar integration is not wired
  readCalendarWindow?: CalendarWindowReader;
  // the events a request like "방금 만든 회의를 한 시간 늦춰줘" can mean (what NAgex created lately + the calendar window); absent when the calendar integration is not wired
  rescheduleCandidates?: (input: { tenantId: string; principalId: string; clock: ScheduleClock; requestId: string }) => Promise<DirectoryResult>;
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
        // a statement that bounds itself in time ("금요일까지") is judged on the person's own clock
        nowMs: clockFor(deps, principalId, body).nowMs,
        timezone: clockFor(deps, principalId, body).timezone,
      });
    }

    const conversation = convContextService.buildContext({
      tenantId,
      principalId,
      sessionId: session.sessionId,
    });

    const memories = getRelevantMemories(tenantId, principalId, message);

    // A turn is read in the light of the conversation: "make it a table" and "isn't that wrong, X is on sale now" have no subject of their own, so the subject of the earlier question travels with
    // them to the freshness check and the search. The person's Web switch (requestMetadata.allowWebResearch) is honoured: OFF means nothing is looked up, and the answer says so.
    const turn = analyzeTurn(message, conversation);
    const webMode = parseWebMode(body);
    const answerLanguage = detectRequestLanguage(message);
    let evidencePack: EvidencePack | undefined;
    if (deps.evidencePackService) {
      evidencePack = await deps.evidencePackService.buildEvidencePack(turn.retrievalQuery, { requestId, webMode, scopeKey: `${tenantId}|${principalId}`, planQueries: true });
      // A question whose whole answer is a live value (a price, a quote, the weather, a headline) is not answered from memory when it could not be checked: that would be an invented value (R22.4).
      // The reply says why, in the person's language, and what they can do. Everything else (a product's specifications, a technology, a company, a policy) is still ANSWERED - from what the model knows,
      // labelled as unverified and possibly out of date (see limitationNotice, and chat-grounding.ts, which forbids "not released" / "does not exist" guesses).
      if (mustNotAnswerWithoutEvidence(evidencePack)) {
        const refusal = liveValueRefusal(evidencePack, answerLanguage);
        const botMsgRecord = convStore.append({ tenantId, principalId, sessionId: session.sessionId, role: 'ASSISTANT', source: 'SYSTEM', content: refusal, requestId });
        auditLogger.logEvent({
          actor: { type: 'user', id: principalId },
          tenant_id: tenantId,
          action: 'conversation.message.created',
          resource: { type: 'ConversationMessage', id: botMsgRecord.messageId },
          result: 'SUCCESS',
          request_id: requestId,
          details: { sessionId: session.sessionId, messageId: botMsgRecord.messageId, role: 'ASSISTANT', source: 'SYSTEM', basis: 'NOT_VERIFIED_LIVE', evidenceStatus: evidencePack.status },
        });
        return {
          status: 200,
          data: {
            message: refusal,
            messageId: botMsgRecord.messageId,
            sessionId: session.sessionId,
            freshness: evidencePack.freshnessRequirement,
            evidencePack,
            sources: [],
            grounding: { basis: 'NOT_VERIFIED_LIVE', webMode, turnKind: turn.kind, freshness: evidencePack.freshnessRequirement, category: evidencePack.category, evidenceStatus: evidencePack.status, sourcesRetrieved: 0, citedSourceIds: [], removedCitations: [], languageRewritten: false, provider: evidencePack.provider ?? null, attempts: evidencePack.attempts ?? [], ...(evidencePack.noEvidenceReason ? { noEvidenceReason: evidencePack.noEvidenceReason } : {}), fromCache: false },
          },
        };
      }
    }

    // the person's real clock goes into every answer; a question about their own calendar gets the events read from it (or the honest reason there are none)
    const clock = clockFor(deps, principalId, body);
    let personalContext: string | undefined;
    // The "personal context" switch of the screen governs what NAgex adds on its own to a question. A question that names the calendar is the person asking NAgex to read it, so it is read (read-only,
    // their own events) whatever that switch says - the Main screen sends it OFF by default, which would otherwise make the question unanswerable.
    const calendarRange = calendarQuestionRange(message, clock);
    if (calendarRange) {
      const locale = detectRequestLanguage(message) === 'ko' ? 'ko' : 'en';
      let read = null;
      if (deps.readCalendarWindow) {
        try { read = await deps.readCalendarWindow({ tenantId, principalId, timeMin: new Date(calendarRange.startMs).toISOString(), timeMax: new Date(calendarRange.endMs).toISOString(), requestId }); } catch { read = { state: 'ERROR', events: [] }; }
      }
      personalContext = renderCalendarContext(calendarRange, clock, read, locale);
    }

    const result = await service.chat({
      message,
      conversation,
      memories,
      evidencePack,
      mode: parseRoutingMode(body?.provider, process.env.NAGEX_MODEL_PROVIDER),
      requestId,
      clock,
      turnKind: turn.kind,
      ...(personalContext ? { personalContext } : {}),
    });

    // When current facts were needed and could not be checked, the answer begins with one plain sentence saying so, in the person's language; it is stored with the answer so the next turn knows too.
    const notice = limitationNotice(evidencePack, answerLanguage);
    const finalMessage = notice ? `${notice}\n\n${result.data.message}` : result.data.message;
    result.data.message = finalMessage;
    const cited = result.data.grounding?.citedSourceIds ?? [];
    const sourcesRetrieved = evidencePack?.sources.length ?? 0;
    // What the answer rests on - retrieval level only. (Claim-level verification is a separate, later layer; nothing here says a claim was verified.)
    const grounding = {
      basis: sourcesRetrieved > 0 ? (cited.length > 0 ? 'SOURCES_CITED' : 'SOURCES_RETRIEVED_NOT_CITED') : (evidencePack && evidencePack.freshnessRequirement !== 'NONE' && evidencePack.status !== 'NOT_REQUIRED' ? 'NOT_VERIFIED_LIVE' : 'NOT_REQUIRED'),
      webMode,
      turnKind: turn.kind,
      freshness: evidencePack?.freshnessRequirement ?? 'NONE',
      category: evidencePack?.category ?? 'GENERAL',
      evidenceStatus: evidencePack?.status ?? 'NOT_REQUIRED',
      sourcesRetrieved,
      citedSourceIds: cited,
      removedCitations: result.data.grounding?.removedCitations ?? [],
      languageRewritten: result.data.grounding?.languageRewritten ?? false,
      releaseDenial: result.data.grounding?.releaseDenial ?? 'NONE',
      provider: evidencePack?.provider ?? null,
      attempts: evidencePack?.attempts ?? [],
      ...(evidencePack?.queries ? { queries: evidencePack.queries } : {}),
      ...(evidencePack?.noEvidenceReason ? { noEvidenceReason: evidencePack.noEvidenceReason } : {}),
      ...(evidencePack?.degraded ? { degraded: evidencePack.degraded } : {}),
      fromCache: evidencePack?.fromCache === true,
    };

    // Section 6: Persist ASSISTANT message AFTER successful AI response
    const assistantMsgRecord = convStore.append({
      tenantId,
      principalId,
      sessionId: session.sessionId,
      role: 'ASSISTANT',
      source: 'WEB',
      content: finalMessage,
      requestId,
    });

    auditLogger.logEvent({
      actor: { type: 'user', id: principalId },
      tenant_id: tenantId,
      action: 'conversation.message.created',
      resource: { type: 'ConversationMessage', id: assistantMsgRecord.messageId },
      result: 'SUCCESS',
      request_id: requestId,
      details: { sessionId: session.sessionId, messageId: assistantMsgRecord.messageId, role: 'ASSISTANT', source: 'WEB', basis: grounding.basis, evidenceStatus: grounding.evidenceStatus, sourcesRetrieved, turnKind: turn.kind },
    });

    return { status: 200, data: { ...result, data: { ...result.data, messageId: assistantMsgRecord.messageId, grounding } } };
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

    // Moving an event the person already has ("방금 만든 회의를 한 시간 늦춰줘") is planned by NAgex itself from their words: which event, and what the new time works out to, are facts a model cannot know.
    // One match becomes a reviewed plan with the exact before -> after (approval is still required); several matches, none, or no new time is a plain question - nothing is changed or invented.
    {
      const rescheduleClock = clockFor(deps, principalId, body);
      // the calendar is only read for a request that says how a time changes ("한 시간 늦춰", "3시로 옮겨") - never for an ordinary plan request
      const looksLikeReschedule = parseRescheduleRequest(prompt, rescheduleClock) !== null;
      const directory = looksLikeReschedule && deps.rescheduleCandidates ? await deps.rescheduleCandidates({ tenantId, principalId, clock: rescheduleClock, requestId }) : { events: [], calendarState: 'UNAVAILABLE' };
      const rescheduled = buildCalendarReschedulePlan({ prompt, clock: rescheduleClock, candidates: directory.events, calendarState: directory.calendarState });
      if (rescheduled.kind !== 'NOT_RESCHEDULE') {
        const language = rescheduled.kind === 'PLAN' ? (detectRequestLanguage(prompt) === 'ko' ? 'ko' : 'en') : rescheduled.language;
        const reply = rescheduled.kind === 'PLAN' ? rescheduled.plan.summary : (rescheduled.message[language]);
        const rescheduleAssistant = convStore.append({ tenantId, principalId, sessionId: session.sessionId, role: 'ASSISTANT', source: 'WEB', content: reply, requestId });
        auditLogger.logEvent({
          actor: { type: 'user', id: principalId },
          tenant_id: tenantId,
          action: 'conversation.message.created',
          resource: { type: 'ConversationMessage', id: rescheduleAssistant.messageId },
          result: 'SUCCESS',
          request_id: requestId,
          details: { sessionId: session.sessionId, messageId: rescheduleAssistant.messageId, role: 'ASSISTANT', source: 'WEB' },
        });
        if (rescheduled.kind === 'NEEDS_DETAIL') {
          return { status: 200, data: { status: 'NEEDS_DETAIL', executable: false, reason: rescheduled.reason, message: reply, language, ...(rescheduled.candidates ? { candidates: rescheduled.candidates } : {}), requestId } };
        }
        const rescheduleIdentity = { tenantId, principalId };
        const rescheduleSeal = (deps.planSeal ?? defaultPlanSeal).seal(rescheduleIdentity, rescheduled.plan);
        let rescheduleRunnable: { ok: boolean; reasons: string[]; capabilityId: string | null };
        try {
          const assessment = assessReviewedPlan(planResolver.resolve(rescheduled.plan, rescheduleIdentity));
          rescheduleRunnable = { ok: assessment.ok, reasons: assessment.reasons, capabilityId: assessment.capabilityId };
        } catch {
          rescheduleRunnable = { ok: false, reasons: ['PLAN_BLOCKED'], capabilityId: null };
        }
        return { status: 200, data: { status: 'PLAN_PREVIEW', message: 'Plan generated. Review it before anything is changed.', plan: rescheduled.plan, planSeal: rescheduleSeal, runnable: rescheduleRunnable, provider: 'nagex', model: null, latencyMs: 0, requestId } };
      }
    }

    const conversation = convContextService.buildContext({
      tenantId,
      principalId,
      sessionId: session.sessionId,
    });

    // an advice request about the person's own calendar ("이번 주 남은 일정을 정리해줘") is given the events read from it, exactly like a chat question
    const planClock = clockFor(deps, principalId, body);
    const planCalendarRange = classifyPlanRequest(prompt).kind === 'ADVISORY' ? calendarQuestionRange(prompt, planClock) : null; // never for a request to schedule something
    let planPersonalContext: string | undefined;
    if (planCalendarRange) {
      let read = null;
      if (deps.readCalendarWindow) {
        try { read = await deps.readCalendarWindow({ tenantId, principalId, timeMin: new Date(planCalendarRange.startMs).toISOString(), timeMax: new Date(planCalendarRange.endMs).toISOString(), requestId }); } catch { read = { state: 'ERROR', events: [] }; }
      }
      planPersonalContext = renderCalendarContext(planCalendarRange, planClock, read, detectRequestLanguage(prompt) === 'ko' ? 'ko' : 'en');
    }

    const result = await service.plan({
      prompt,
      memories: getRelevantMemories(tenantId, principalId, prompt),
      conversation,
      mode: parseRoutingMode(body?.provider, process.env.NAGEX_MODEL_PROVIDER),
      requestId,
      identity: { tenantId, principalId },
      // The person reads this answer: an advice-only request may be answered with advice (no steps). Everything that can ever execute still needs a real plan.
      allowAdvisory: true,
      // dates in the plan are resolved and checked against the person's real clock and timezone
      clock: planClock,
      ...(planPersonalContext ? { personalContext: planPersonalContext } : {}),
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
