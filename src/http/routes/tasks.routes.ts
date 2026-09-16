// R10.2-D Increment 3 — Task routes, extracted verbatim from
// server_web.ts. Two registrars, matching the two real dispatch entry
// points the original inline blocks lived in:
//   - handleTasksRoutes (sync)      — CRUD + pause/resume/cancel + runs,
//     originally inline in handleApiRequest.
//   - handleTasksRunRoutes (async)  — /run + the test-only-gated
//     /run-with-fixed-plan, originally inline in handleAsyncApiRequest
//     (both genuinely await scheduler.runOne(), so they cannot fall
//     through from the sync registrar).
// Risk classification (R10.2-D Increment 3 §4): GET routes are READ_ONLY;
// create/update/delete/pause/resume/cancel are LOCAL_MUTATION (TaskStore
// only, no external side effect); /run and /run-with-fixed-plan are
// SCHEDULER_MUTATION (they drive a real TaskScheduler.runOne(), which can
// itself reach EXTERNAL_MUTATION/APPROVAL_GATED capability execution
// downstream — that downstream safety chokepoint is untouched by this move).
import crypto from 'node:crypto';
import { NagexError } from '../../common/errors.js';
import { DEFAULT_GOOGLE_TENANT_ID } from '../../integrations/google/token.store.js';
import type { PrincipalReference } from '../../common/types.js';
import type { AuditLogger } from '../../governance/audit.logger.js';
import type { SessionStore } from '../../sessions/session.store.js';
import { TaskStore, type TaskType, type TaskTrigger, type TaskApprovalPolicy, type TaskRecord } from '../../tasks/task.store.js';
import { TaskRunStore } from '../../tasks/task-run.store.js';
import { TaskScheduler, computeNextRunAt } from '../../tasks/task.scheduler.js';
import { PlanPreviewTaskRunner, ConditionalWatchTaskRunner, BackgroundTaskRunner, CompositeTaskRunner, ExecutingTaskRunner } from '../../tasks/task.runner.js';
import type { TaskContinuationStore } from '../../tasks/task-continuation.store.js';
import type { DurableTaskRunStateStore } from '../../tasks/durable-task-run-state.store.js';
import type { AiService, PlanPreview } from '../../model-gateway/ai-service.js';
import type { PlanResolver } from '../../planning/plan-resolver.js';
import type { CapabilityBroker } from '../../capabilities/index.js';
import type { NotificationEngine } from '../../notifications/notification.engine.js';
import type { MemoryRecord } from '../../context/memory.engine.js';
import type { ApiResult, SyncRouteRegistrar, AsyncRouteRegistrar } from '../http-types.js';

function getHeaderValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

// V01a-R1 — timing-safe token comparison for the test-only fixed-plan
// injection route. An empty expected token is always invalid — this is
// what makes NAGEX_TEST_PLAN_INJECTION_TOKEN being unset/empty a real,
// independent gate, not just a formality.
function timingSafeTokenMatch(expectedToken: string, providedToken: string | undefined): boolean {
  if (!expectedToken || !providedToken) return false;
  const expectedBuf = Buffer.from(expectedToken, 'utf8');
  const providedBuf = Buffer.from(providedToken, 'utf8');
  if (expectedBuf.length !== providedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

export interface TasksRouteDeps {
  taskStore: TaskStore;
  taskRunStore: TaskRunStore;
  sessionStore: SessionStore;
  auditLogger: AuditLogger;
  tenantId: string;
  principal: PrincipalReference;
  modelErrorResult: (error: unknown) => ApiResult;
}

export const handleTasksRoutes: SyncRouteRegistrar<TasksRouteDeps> = (method, pathname, body, _headers, _query, deps): ApiResult | undefined => {
  const { taskStore, taskRunStore, sessionStore, auditLogger, tenantId, principal, modelErrorResult } = deps;

  if (pathname === '/api/v1/tasks' && method === 'GET') {
    const tasks = taskStore.list(tenantId, principal.id);
    return { status: 200, data: { tasks, total: tasks.length } };
  }

  if (pathname === '/api/v1/tasks' && method === 'POST') {
    const requestId = `req_task_${Date.now()}`;
    try {
      const VALID_TASK_TYPES: readonly string[] = ['ONE_TIME', 'RECURRING', 'CONDITIONAL', 'BACKGROUND', 'WAITING', 'STANDING_INTENT'];
      const VALID_TRIGGER_TYPES: readonly string[] = ['SCHEDULE', 'INTERVAL', 'CONDITION', 'WEBHOOK', 'EMAIL_EVENT', 'CALENDAR_EVENT', 'FILE_EVENT', 'MANUAL', 'SYSTEM_EVENT', 'AGENT_EVENT'];
      const typeRaw = body?.type;
      if (typeof typeRaw !== 'string' || !VALID_TASK_TYPES.includes(typeRaw)) {
        throw new NagexError({ code: 'INVALID_TASK_TYPE', category: 'VALIDATION', message: `type must be one of ${VALID_TASK_TYPES.join(', ')}.`, request_id: requestId });
      }
      const type = typeRaw as TaskType;
      const triggerRaw = (body?.trigger && typeof body.trigger === 'object' ? body.trigger : { type: 'MANUAL' }) as Record<string, unknown>;
      if (typeof triggerRaw.type !== 'string' || !VALID_TRIGGER_TYPES.includes(triggerRaw.type)) {
        throw new NagexError({ code: 'INVALID_TASK_TRIGGER_TYPE', category: 'VALIDATION', message: `trigger.type must be one of ${VALID_TRIGGER_TYPES.join(', ')}.`, request_id: requestId });
      }
      const trigger = triggerRaw as unknown as TaskTrigger;
      if (type === 'CONDITIONAL') {
        if (trigger.type !== 'CONDITION') {
          throw new NagexError({ code: 'CONDITIONAL_TASK_REQUIRES_CONDITION_TRIGGER', category: 'VALIDATION', message: 'A CONDITIONAL task requires trigger.type "CONDITION".', request_id: requestId });
        }
        if (!trigger.condition?.trim()) {
          throw new NagexError({ code: 'CONDITION_REQUIRED', category: 'VALIDATION', message: 'trigger.condition (what to watch for) is required for a CONDITIONAL task.', request_id: requestId });
        }
        if (!trigger.watchUrl?.trim() || !/^https?:\/\//i.test(trigger.watchUrl)) {
          throw new NagexError({ code: 'WATCH_URL_REQUIRED', category: 'VALIDATION', message: 'trigger.watchUrl (a real http(s) URL to check) is required for a CONDITIONAL task — NAgex never invents a page to watch.', request_id: requestId });
        }
        if (!trigger.checkIntervalMinutes || trigger.checkIntervalMinutes <= 0) trigger.checkIntervalMinutes = 15;
      }
      const now = new Date();
      const initialNextRunAt = computeNextRunAt(trigger, now);
      const session = sessionStore.getOrCreateMain(tenantId, principal.id);
      const task = taskStore.create({
        tenantId,
        ownerId: principal.id,
        name: (body?.name as string) || '',
        objective: (body?.objective as string) || '',
        type,
        sourceSessionId: session.sessionId,
        trigger,
        approvalPolicy: (body?.approvalPolicy as TaskApprovalPolicy) || 'ALWAYS_APPROVE',
        nextRunAt: initialNextRunAt ? initialNextRunAt.toISOString() : null,
      });
      auditLogger.logEvent({
        actor: principal,
        tenant_id: tenantId,
        action: 'task.created',
        resource: { type: 'Task', id: task.taskId },
        result: 'SUCCESS',
        request_id: requestId,
        details: { type: task.type, triggerType: task.trigger.type },
      });
      return { status: 201, data: task };
    } catch (error) {
      return modelErrorResult(error);
    }
  }

  if (pathname.startsWith('/api/v1/tasks/') && pathname.endsWith('/runs') && method === 'GET') {
    const taskId = pathname.slice('/api/v1/tasks/'.length, pathname.length - '/runs'.length);
    const parentTask = taskStore.get(taskId, tenantId, principal.id);
    if (!parentTask) return { status: 404, data: { error: { code: 'TASK_NOT_FOUND', category: 'NOT_FOUND', message: `Task ${taskId} was not found.`, request_id: `req_task_${Date.now()}` } } };
    const runs = taskRunStore.listForTask(taskId);
    return { status: 200, data: { runs, total: runs.length } };
  }

  if (pathname.startsWith('/api/v1/tasks/') && pathname.endsWith('/pause') && method === 'POST') {
    const taskId = pathname.slice('/api/v1/tasks/'.length, pathname.length - '/pause'.length);
    try {
      const task = taskStore.pause(taskId, tenantId, principal.id);
      auditLogger.logEvent({ actor: principal, tenant_id: task.tenantId, action: 'task.paused', resource: { type: 'Task', id: taskId }, result: 'SUCCESS', request_id: `req_task_${Date.now()}` });
      return { status: 200, data: task };
    } catch (error) {
      return modelErrorResult(error);
    }
  }

  if (pathname.startsWith('/api/v1/tasks/') && pathname.endsWith('/resume') && method === 'POST') {
    const taskId = pathname.slice('/api/v1/tasks/'.length, pathname.length - '/resume'.length);
    try {
      const task = taskStore.resume(taskId, tenantId, principal.id);
      auditLogger.logEvent({ actor: principal, tenant_id: task.tenantId, action: 'task.resumed', resource: { type: 'Task', id: taskId }, result: 'SUCCESS', request_id: `req_task_${Date.now()}` });
      return { status: 200, data: task };
    } catch (error) {
      return modelErrorResult(error);
    }
  }

  if (pathname.startsWith('/api/v1/tasks/') && pathname.endsWith('/cancel') && method === 'POST') {
    const taskId = pathname.slice('/api/v1/tasks/'.length, pathname.length - '/cancel'.length);
    try {
      const task = taskStore.cancel(taskId, tenantId, principal.id);
      auditLogger.logEvent({ actor: principal, tenant_id: task.tenantId, action: 'task.cancelled', resource: { type: 'Task', id: taskId }, result: 'SUCCESS', request_id: `req_task_${Date.now()}` });
      return { status: 200, data: task };
    } catch (error) {
      return modelErrorResult(error);
    }
  }

  if (pathname.startsWith('/api/v1/tasks/') && method === 'DELETE') {
    const taskId = pathname.slice('/api/v1/tasks/'.length);
    try {
      const task = taskStore.get(taskId, tenantId, principal.id);
      if (!task) {
        throw new NagexError({ code: 'TASK_NOT_FOUND', category: 'NOT_FOUND', message: `Task ${taskId} was not found.`, request_id: `req_task_${Date.now()}` });
      }
      taskStore.delete(taskId, tenantId, principal.id);
      auditLogger.logEvent({ actor: principal, tenant_id: task.tenantId, action: 'task.deleted', resource: { type: 'Task', id: taskId }, result: 'SUCCESS', request_id: `req_task_${Date.now()}` });
      return { status: 200, data: { success: true, deleted_id: taskId } };
    } catch (error) {
      return modelErrorResult(error);
    }
  }

  if (pathname.startsWith('/api/v1/tasks/') && method === 'PATCH') {
    const taskId = pathname.slice('/api/v1/tasks/'.length);
    try {
      const patch: Record<string, unknown> = {};
      if (typeof body?.name === 'string') patch.name = body.name;
      if (typeof body?.objective === 'string') patch.objective = body.objective;
      if (typeof body?.approvalPolicy === 'string') patch.approvalPolicy = body.approvalPolicy;
      if (body?.trigger && typeof body.trigger === 'object') {
        patch.trigger = body.trigger;
        const nextRun = computeNextRunAt(body.trigger as unknown as TaskTrigger, new Date());
        patch.nextRunAt = nextRun ? nextRun.toISOString() : null;
      }
      const task = taskStore.update(taskId, tenantId, principal.id, patch);
      auditLogger.logEvent({ actor: principal, tenant_id: task.tenantId, action: 'task.updated', resource: { type: 'Task', id: taskId }, result: 'SUCCESS', request_id: `req_task_${Date.now()}` });
      return { status: 200, data: task };
    } catch (error) {
      return modelErrorResult(error);
    }
  }

  if (pathname.startsWith('/api/v1/tasks/') && method === 'GET') {
    const taskId = pathname.slice('/api/v1/tasks/'.length);
    const task = taskStore.get(taskId, tenantId, principal.id);
    if (!task) return { status: 404, data: { error: { code: 'TASK_NOT_FOUND', category: 'NOT_FOUND', message: `Task ${taskId} was not found.`, request_id: `req_task_${Date.now()}` } } };
    return { status: 200, data: task };
  }

  return undefined;
};

// TasksRunRouteDeps is intentionally larger than a typical registrar's
// deps: /run must reconstruct the exact same conditional
// "real scheduler vs. throwaway test-DI scheduler" logic the original
// inline code had (see `service` vs `aiService` below), and
// /run-with-fixed-plan needs the same real capability/continuation/durable-
// state singletons any real Task execution needs. Every field here is
// task-execution-specific — none of this is "entireApplication" passed for
// convenience.
export interface TasksRunRouteDeps {
  taskStore: TaskStore;
  taskRunStore: TaskRunStore;
  taskScheduler: TaskScheduler;
  service: AiService;
  aiService: AiService;
  planResolver: PlanResolver;
  capabilityBroker: CapabilityBroker;
  getRelevantMemories: (tenantId: string, principalId: string, prompt: string) => MemoryRecord[];
  taskContinuations: TaskContinuationStore;
  durableTaskRunState: DurableTaskRunStateStore;
  auditLogger: AuditLogger;
  notificationEngine: NotificationEngine;
  modelErrorResult: (error: unknown) => ApiResult;
}

export const handleTasksRunRoutes: AsyncRouteRegistrar<TasksRunRouteDeps> = async (method, pathname, body, headers, _query, deps): Promise<ApiResult | undefined> => {
  const { taskStore, taskRunStore, taskScheduler, service, aiService, planResolver, capabilityBroker, getRelevantMemories, taskContinuations, durableTaskRunState, auditLogger, notificationEngine, modelErrorResult } = deps;

  if (pathname.startsWith('/api/v1/tasks/') && pathname.endsWith('/run') && method === 'POST') {
    const taskId = pathname.slice('/api/v1/tasks/'.length, pathname.length - '/run'.length);
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_task_run_${crypto.randomUUID()}`;
    // Task Isolation Correction — security-critical: without this check a
    // caller from another tenant/owner could trigger execution (real
    // Gmail/Calendar dispatch, approval creation, notifications) of a
    // Task they do not own. Ownership mismatch is indistinguishable from
    // a nonexistent task.
    const runTenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
    const runPrincipalId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
    const task = taskStore.get(taskId, runTenantId, runPrincipalId);
    if (!task) return { status: 404, data: { error: { code: 'TASK_NOT_FOUND', category: 'NOT_FOUND', message: `Task ${taskId} was not found.`, request_id: requestId } } };
    // Mirrors the `calendarService` DI pattern elsewhere: the shared
    // taskScheduler singleton (built on the real aiService) is used unless
    // a test injects a different `service`, in which case a throwaway
    // scheduler wraps that same injected model so a real network call is
    // never made from a test.
    const scheduler = service === aiService ? taskScheduler : new TaskScheduler(
      taskStore,
      taskRunStore,
      new CompositeTaskRunner(
        new PlanPreviewTaskRunner(service, planResolver, (tenantId, principalId, prompt) => getRelevantMemories(tenantId, principalId, prompt)),
        new ConditionalWatchTaskRunner(capabilityBroker, service),
        new BackgroundTaskRunner(taskStore, service, planResolver, (tenantId, principalId, prompt) => getRelevantMemories(tenantId, principalId, prompt)),
        new ExecutingTaskRunner(service, planResolver, capabilityBroker, (tenantId, principalId, prompt) => getRelevantMemories(tenantId, principalId, prompt), taskContinuations, durableTaskRunState),
      ),
      auditLogger,
    );
    const run = await scheduler.runOne(task);
    return { status: 200, data: run };
  }

  // V01a — test-only, env-gated deterministic plan injection. Exists
  // solely so a LIVE E2E harness (scripts/nagex-task-e2e-live.sh) can
  // drive a real Task run through ExecutingTaskRunner's real step-
  // execution/durable-state/approval path without depending on the real
  // planning LLM's variable output shape. This route does not exist
  // (falls through to the ordinary 404, indistinguishable from any other
  // unmatched path) unless BOTH independent gates pass — re-checked on
  // every request, never cached, and never distinguished from each other
  // in the response:
  //   1. NAGEX_ENABLE_TEST_PLAN_INJECTION === '1'
  //   2. X-NAgex-Test-Token exactly matches NAGEX_TEST_PLAN_INJECTION_TOKEN
  //      (timing-safe comparison; see timingSafeTokenMatch above)
  // It only ever substitutes the planning LLM call: PlanResolver.resolve()
  // and everything downstream (step execution, durable state, approval
  // continuation, finalization) is the real, unmodified production path,
  // writing to the same real stores a normal run would.
  if (
    pathname.startsWith('/api/v1/tasks/') && pathname.endsWith('/run-with-fixed-plan') && method === 'POST' &&
    process.env.NAGEX_ENABLE_TEST_PLAN_INJECTION === '1' &&
    timingSafeTokenMatch(process.env.NAGEX_TEST_PLAN_INJECTION_TOKEN ?? '', getHeaderValue(headers, 'x-nagex-test-token'))
  ) {
    const taskId = pathname.slice('/api/v1/tasks/'.length, pathname.length - '/run-with-fixed-plan'.length);
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_task_fixedplan_${crypto.randomUUID()}`;
    const fixedPlanTenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
    const fixedPlanPrincipalId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
    const task = taskStore.get(taskId, fixedPlanTenantId, fixedPlanPrincipalId);
    if (!task) return { status: 404, data: { error: { code: 'TASK_NOT_FOUND', category: 'NOT_FOUND', message: `Task ${taskId} was not found.`, request_id: requestId } } };
    const steps = Array.isArray(body?.steps) ? body.steps : [];
    if (steps.length === 0) {
      return { status: 400, data: { error: { code: 'FIXED_PLAN_STEPS_REQUIRED', category: 'VALIDATION', message: 'A non-empty steps array is required.', request_id: requestId } } };
    }
    let resolved;
    try {
      resolved = planResolver.resolve({ goal: task.objective, summary: 'V01a test-only fixed-plan injection.', reasoningSummary: 'V01a test-only fixed-plan injection.', suggestions: [], steps } as unknown as PlanPreview);
    } catch (error) {
      return modelErrorResult(error);
    }
    // A throwaway ExecutingTaskRunner wired to the exact same real
    // capabilityBroker/taskContinuations/durableTaskRunState the
    // production taskRunner uses — the instance is ephemeral, but every
    // store it writes to is the real one, so restart-recovery inspection
    // sees genuine data.
    const fixedPlanRunner = new ExecutingTaskRunner(aiService, planResolver, capabilityBroker, (tenantId, principalId, prompt) => getRelevantMemories(tenantId, principalId, prompt), taskContinuations, durableTaskRunState);
    const scheduler = new TaskScheduler(
      taskStore,
      taskRunStore,
      { run: (t: TaskRecord, reqId: string, runId: string) => fixedPlanRunner.runWithResolvedPlan(t, reqId, runId, resolved) },
      auditLogger,
      undefined,
      notificationEngine,
    );
    const run = await scheduler.runOne(task);
    return { status: 200, data: run };
  }

  return undefined;
};
