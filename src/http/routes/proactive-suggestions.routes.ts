import crypto from 'node:crypto';
import { NagexError } from '../../common/errors.js';
import type { ActivityStore } from '../../governance/activity.store.js';
import type { NotificationEngine } from '../../notifications/notification.engine.js';
import type { ProactiveSuggestion } from '../../personal/proactive-suggestion.service.js';
import type { ProactiveInteractionDecision, ProactiveInteractionStore } from '../../personal/proactive-interaction.store.js';
import type { RightNowIntelligenceService } from '../../personal/right-now-intelligence.service.js';
import type { TaskStore } from '../../tasks/task.store.js';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';
import { callerIdentity } from '../request-identity.js';

export interface ProactiveSuggestionsRouteDeps {
  rightNowIntelligenceService: RightNowIntelligenceService;
  proactiveInteractionStore: ProactiveInteractionStore;
  taskStore: TaskStore;
  activityStore: ActivityStore;
  notificationEngine: NotificationEngine;
  modelErrorResult: (error: unknown) => ApiResult;
}

function getRequestId(headers: Record<string, string | string[] | undefined>): string {
  const value = headers['x-request-id'] ?? headers['X-Request-Id'];
  return (Array.isArray(value) ? value[0] : value) || `req_proactive_${crypto.randomUUID()}`;
}

function actionFromPath(pathname: string): ProactiveInteractionDecision | null {
  if (pathname.endsWith('/accept')) return 'ACCEPTED';
  if (pathname.endsWith('/dismiss')) return 'DISMISSED';
  if (pathname.endsWith('/snooze')) return 'SNOOZED';
  if (pathname.endsWith('/modify')) return 'MODIFIED';
  if (pathname.endsWith('/dont-suggest-again')) return 'DONT_SUGGEST_AGAIN';
  return null;
}

function suggestionIdFromPath(pathname: string, action: ProactiveInteractionDecision): string {
  const suffix = {
    ACCEPTED: '/accept',
    DISMISSED: '/dismiss',
    SNOOZED: '/snooze',
    MODIFIED: '/modify',
    DONT_SUGGEST_AGAIN: '/dont-suggest-again',
  }[action];
  return decodeURIComponent(pathname.slice('/api/v1/proactive-suggestions/'.length, pathname.length - suffix.length));
}

function suppressKey(suggestion: ProactiveSuggestion): string {
  const firstSource = suggestion.sourceRefs[0];
  return `${suggestion.kind}:${suggestion.action.type}:${firstSource?.type ?? 'UNKNOWN'}`;
}

async function findSuggestion(deps: ProactiveSuggestionsRouteDeps, tenantId: string, principalId: string, suggestionId: string, requestId: string): Promise<ProactiveSuggestion | null> {
  const intel = await deps.rightNowIntelligenceService.buildRightNow({ tenantId, userId: principalId, requestId });
  return intel.suggestions.find((suggestion) => suggestion.id === suggestionId) ?? null;
}

export const handleProactiveSuggestionsRoutes: AsyncRouteRegistrar<ProactiveSuggestionsRouteDeps> = async (method, pathname, body, headers, _query, deps): Promise<ApiResult | undefined> => {
  if (!pathname.startsWith('/api/v1/proactive-suggestions/')) return undefined;
  if (method !== 'POST') return undefined;
  const decision = actionFromPath(pathname);
  if (!decision) return undefined;

  const { tenantId, principalId } = callerIdentity(headers);
  const requestId = getRequestId(headers);
  try {
    const suggestionId = suggestionIdFromPath(pathname, decision);
    const suggestion = await findSuggestion(deps, tenantId, principalId, suggestionId, requestId);
    if (!suggestion) {
      throw new NagexError({ code: 'PROACTIVE_SUGGESTION_NOT_FOUND', category: 'NOT_FOUND', message: 'This suggestion is no longer available.', request_id: requestId });
    }

    if (decision === 'ACCEPTED') {
      const title = typeof body?.title === 'string' && body.title.trim() ? body.title.trim() : suggestion.title;
      const task = deps.taskStore.create({
        tenantId,
        ownerId: principalId,
        name: title,
        objective: `${suggestion.action.label}: ${suggestion.reason}`,
        type: 'ONE_TIME',
        trigger: { type: 'MANUAL' },
        approvalPolicy: suggestion.action.requiresApproval ? 'ALWAYS_APPROVE' : 'READ_ONLY_AUTO',
      });
      const record = deps.proactiveInteractionStore.save({ tenantId, principalId, suggestionId, decision, sourceRefs: suggestion.sourceRefs, taskId: task.taskId });
      deps.activityStore.record({ tenantId, principalId, type: 'PROACTIVE_ACCEPTED', title: `Created task from suggestion: ${task.name}`, description: suggestion.reason, status: 'COMPLETED', source: { taskId: task.taskId }, dedupeKey: `proactive:${suggestionId}:accepted` });
      await deps.notificationEngine.dispatch({ tenantId, principalId, type: 'ACTION_COMPLETED', title: 'Suggestion accepted', body: `Created task: ${task.name}`, metadata: { target: `#tasks/${task.taskId}`, suggestionId, taskId: task.taskId }, dedupeKey: `proactive:${suggestionId}:accepted` });
      return { status: 201, data: { interaction: record, task, authorityGranted: false } };
    }

    const snoozedUntil = decision === 'SNOOZED'
      ? (typeof body?.snoozedUntil === 'string' ? body.snoozedUntil : new Date(Date.now() + 60 * 60 * 1000).toISOString())
      : undefined;
    const modifiedTitle = decision === 'MODIFIED' && typeof body?.title === 'string' ? body.title.trim() : undefined;
    const record = deps.proactiveInteractionStore.save({
      tenantId,
      principalId,
      suggestionId,
      decision,
      sourceRefs: suggestion.sourceRefs,
      snoozedUntil,
      modifiedTitle,
      suppressKey: decision === 'DONT_SUGGEST_AGAIN' ? suppressKey(suggestion) : undefined,
    });
    deps.activityStore.record({ tenantId, principalId, type: `PROACTIVE_${decision}`, title: `Suggestion ${decision.toLowerCase().replace(/_/g, ' ')}`, description: suggestion.title, status: 'COMPLETED', dedupeKey: `proactive:${suggestionId}:${decision}` });
    return { status: 200, data: { interaction: record, authorityGranted: false } };
  } catch (error) {
    return deps.modelErrorResult(error);
  }
};
