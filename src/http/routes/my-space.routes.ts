// R10.2-D Increment 5 — My Space read-only aggregation route (P08),
// extracted verbatim from server_web.ts's handleAsyncApiRequest. Thin,
// read-only composition of already-frozen, already tenant/owner-scoped
// sources — no new store, no new persistence, no provider bypass. Each
// section is independently fault-tolerant: a failure in one (most
// commonly Calendar, when Google isn't connected) never fails the whole
// response.
import crypto from 'node:crypto';
import { NagexError } from '../../common/errors.js';
import { DEFAULT_GOOGLE_TENANT_ID } from '../../integrations/google/token.store.js';
import type { ActivityStore } from '../../governance/activity.store.js';
import type { MemoryEngine } from '../../context/memory.engine.js';
import type { TaskStore } from '../../tasks/task.store.js';
import type { TaskRunStore } from '../../tasks/task-run.store.js';
import type { WorkflowDefinitionService } from '../../workflows/workflow-definition.service.js';
import type { GoogleCalendarService } from '../../modules/calendar/index.js';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';

function getHeaderValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export interface MySpaceRouteDeps {
  activityStore: ActivityStore;
  memoryEngine: MemoryEngine;
  taskStore: TaskStore;
  taskRunStore: TaskRunStore;
  workflowDefinitionService: WorkflowDefinitionService;
  calendarService: GoogleCalendarService;
}

export const handleMySpaceRoutes: AsyncRouteRegistrar<MySpaceRouteDeps> = async (method, pathname, _body, headers, _query, deps): Promise<ApiResult | undefined> => {
  const { activityStore, memoryEngine, taskStore, taskRunStore, workflowDefinitionService, calendarService } = deps;

  if (pathname === '/api/v1/my-space' && method === 'GET') {
    const ownerId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_myspace_${crypto.randomUUID()}`;

    let activity: ReturnType<typeof activityStore.list> = [];
    try {
      activity = activityStore.list(tenantId, ownerId, 10);
    } catch {
      activity = [];
    }

    let memory: ReturnType<typeof memoryEngine.getActiveMemories> = [];
    try {
      const scopes: Array<'USER' | 'SESSION' | 'AGENT' | 'TENANT'> = ['USER', 'SESSION', 'AGENT', 'TENANT'];
      memory = scopes
        .flatMap((scope) => memoryEngine.getActiveMemories(scope, tenantId, ownerId))
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .slice(0, 10);
    } catch {
      memory = [];
    }

    let tasks: ReturnType<typeof taskStore.list> = [];
    try {
      tasks = taskStore.list(tenantId, ownerId);
    } catch {
      tasks = [];
    }

    let workflows: Array<{ id: string; name: string; enabled: boolean; createdAt: string; updatedAt: string; lastRunStatus: 'SUCCEEDED' | 'FAILED' | null; lastRunAt: string | null }> = [];
    try {
      const workflowDefs = workflowDefinitionService.list(tenantId, ownerId);
      workflows = workflowDefs.map((wf) => {
        // Recent run state is composed, never stored: the most-recently-
        // updated owned Task instantiated from this workflow already
        // carries its own last-run outcome (P07's own traceability-only
        // field) — no new WorkflowRun store.
        const linkedTasks = tasks
          .filter((t) => t.workflowDefinitionId === wf.workflowId)
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        const latest = linkedTasks[0];
        return {
          id: wf.workflowId,
          name: wf.name,
          enabled: wf.enabled,
          createdAt: wf.createdAt,
          updatedAt: wf.updatedAt,
          lastRunStatus: latest?.lastRunStatus ?? null,
          lastRunAt: latest?.lastRunAt ?? null,
        };
      });
    } catch {
      workflows = [];
    }

    // Calendar — DISCONNECTED is a normal, expected state (not every user
    // has connected Google Calendar), reported distinctly from a real
    // ERROR so the frontend can show "Connect Calendar" rather than a
    // generic failure; either way `calendar` itself stays a safe [].
    let calendar: Awaited<ReturnType<typeof calendarService.listUpcomingEvents>> = [];
    let calendarStatus: 'CONNECTED' | 'DISCONNECTED' | 'ERROR' = 'CONNECTED';
    try {
      const now = new Date();
      const in7Days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      calendar = await calendarService.listUpcomingEvents({
        tenantId,
        timeMin: now.toISOString(),
        timeMax: in7Days.toISOString(),
        maxResults: 5,
        requestId,
      });
    } catch (error) {
      calendar = [];
      calendarStatus = error instanceof NagexError && error.code === 'GOOGLE_CALENDAR_DISCONNECTED' ? 'DISCONNECTED' : 'ERROR';
    }

    // History = Activity + owned TaskRun ONLY (approved P08 definition —
    // never the legacy server_web `executionHistory` array, never the
    // unwired governance ExecutionStore, never runtime.engine's private
    // in-memory map). Owner isolation is structural, not a filter: only
    // taskIds already returned by the tenant+owner-scoped taskStore.list()
    // above are ever looked up — never "all TaskRuns, then filter".
    let history: Array<{ kind: 'ACTIVITY' | 'TASK_RUN'; id: string; title: string; status: string; timestamp: string }> = [];
    try {
      const activityEntries = activity.map((a) => ({ kind: 'ACTIVITY' as const, id: a.activityId, title: a.title, status: a.status, timestamp: a.occurredAt }));
      const taskRunEntries = tasks.flatMap((task) =>
        taskRunStore.listForTask(task.taskId).map((run) => ({
          kind: 'TASK_RUN' as const,
          id: run.runId,
          title: task.name,
          status: run.status,
          timestamp: run.completedAt || run.startedAt,
        })),
      );
      history = [...activityEntries, ...taskRunEntries]
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
        .slice(0, 15);
    } catch {
      history = [];
    }

    return {
      status: 200,
      data: { activity, memory, tasks, workflows, calendar, calendarStatus, history },
    };
  }

  return undefined;
};
