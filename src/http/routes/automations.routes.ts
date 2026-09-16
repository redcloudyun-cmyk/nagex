// R10.2-D Increment 3 — Automation (WorkflowDefinition) routes, extracted
// verbatim from server_web.ts. Two registrars, matching the two real
// dispatch entry points the original inline blocks lived in:
//   - handleAutomationsRoutes (sync)      — CRUD, originally inline in
//     handleApiRequest. A WorkflowDefinition is a reusable
//     description/template only — never an execution engine.
//   - handleAutomationsRunRoutes (async)  — POST /:id/run, originally
//     inline in handleAsyncApiRequest, since it must await the real
//     instantiate/run bridge.
// Risk classification (R10.2-D Increment 3 §4): GET is READ_ONLY;
// create/update/delete are LOCAL_MUTATION (WorkflowDefinitionStore only);
// /run is SCHEDULER_MUTATION — it instantiates and runs a real Task from
// a frozen, resolved plan snapshot (a later edit/delete of the
// WorkflowDefinition can never affect an already-running instance).
import type { PrincipalReference } from '../../common/types.js';
import type { WorkflowDefinitionService } from '../../workflows/workflow-definition.service.js';
import type { AiService } from '../../model-gateway/ai-service.js';
import type { PlanResolver } from '../../planning/plan-resolver.js';
import type { CapabilityBroker } from '../../capabilities/index.js';
import type { NotificationEngine } from '../../notifications/notification.engine.js';
import type { AuditLogger } from '../../governance/audit.logger.js';
import type { TaskRecord } from '../../tasks/task.store.js';
import { TaskStore } from '../../tasks/task.store.js';
import { TaskRunStore } from '../../tasks/task-run.store.js';
import { TaskScheduler } from '../../tasks/task.scheduler.js';
import { ExecutingTaskRunner } from '../../tasks/task.runner.js';
import type { TaskContinuationStore } from '../../tasks/task-continuation.store.js';
import type { DurableTaskRunStateStore } from '../../tasks/durable-task-run-state.store.js';
import type { MemoryRecord } from '../../context/memory.engine.js';
import { DEFAULT_GOOGLE_TENANT_ID } from '../../integrations/google/token.store.js';
import type { ApiResult, SyncRouteRegistrar, AsyncRouteRegistrar } from '../http-types.js';

function getHeaderValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export interface AutomationsRouteDeps {
  workflowDefinitionService: WorkflowDefinitionService;
  tenantId: string;
  principal: PrincipalReference;
  modelErrorResult: (error: unknown) => ApiResult;
}

export const handleAutomationsRoutes: SyncRouteRegistrar<AutomationsRouteDeps> = (method, pathname, body, _headers, _query, deps): ApiResult | undefined => {
  const { workflowDefinitionService, tenantId, principal, modelErrorResult } = deps;

  if (pathname === '/api/v1/workflows' && method === 'POST') {
    const requestId = `req_workflow_${Date.now()}`;
    try {
      const steps = Array.isArray(body?.steps) ? body.steps : [];
      const workflow = workflowDefinitionService.create(tenantId, principal.id, {
        tenantId,
        ownerPrincipalId: principal.id,
        name: typeof body?.name === 'string' ? body.name : '',
        description: typeof body?.description === 'string' ? body.description : '',
        enabled: typeof body?.enabled === 'boolean' ? body.enabled : true,
        steps,
      }, requestId);
      return { status: 201, data: workflow };
    } catch (error) {
      return modelErrorResult(error);
    }
  }

  if (pathname === '/api/v1/workflows' && method === 'GET') {
    const workflows = workflowDefinitionService.list(tenantId, principal.id);
    return { status: 200, data: { workflows, total: workflows.length } };
  }

  if (pathname.startsWith('/api/v1/workflows/') && method === 'PATCH') {
    const workflowId = pathname.slice('/api/v1/workflows/'.length);
    const requestId = `req_workflow_${Date.now()}`;
    try {
      const patch: Record<string, unknown> = {};
      if (typeof body?.name === 'string') patch.name = body.name;
      if (typeof body?.description === 'string') patch.description = body.description;
      if (typeof body?.enabled === 'boolean') patch.enabled = body.enabled;
      if (Array.isArray(body?.steps)) patch.steps = body.steps;
      const workflow = workflowDefinitionService.update(workflowId, tenantId, principal.id, patch, requestId);
      return { status: 200, data: workflow };
    } catch (error) {
      return modelErrorResult(error);
    }
  }

  if (pathname.startsWith('/api/v1/workflows/') && method === 'DELETE') {
    const workflowId = pathname.slice('/api/v1/workflows/'.length);
    const requestId = `req_workflow_${Date.now()}`;
    try {
      workflowDefinitionService.delete(workflowId, tenantId, principal.id, requestId);
      return { status: 200, data: { success: true, deleted_id: workflowId } };
    } catch (error) {
      return modelErrorResult(error);
    }
  }

  if (pathname.startsWith('/api/v1/workflows/') && method === 'GET') {
    const workflowId = pathname.slice('/api/v1/workflows/'.length);
    const workflow = workflowDefinitionService.get(workflowId, tenantId, principal.id);
    if (!workflow) return { status: 404, data: { error: { code: 'WORKFLOW_NOT_FOUND', category: 'NOT_FOUND', message: `Workflow ${workflowId} was not found.`, request_id: `req_workflow_${Date.now()}` } } };
    return { status: 200, data: workflow };
  }

  return undefined;
};

export interface AutomationsRunRouteDeps {
  workflowDefinitionService: WorkflowDefinitionService;
  taskStore: TaskStore;
  taskRunStore: TaskRunStore;
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

// P07 — Reusable Workflow Definition Foundation: instantiate bridge. Mirrors
// the Tasks /run-with-fixed-plan bridge exactly (same ephemeral
// ExecutingTaskRunner + throwaway TaskScheduler pattern, wired to the real
// capabilityBroker/taskContinuations/durableTaskRunState/notificationEngine
// singletons). WorkflowDefinitionService.prepareRun() only builds the
// ResolvedPlan and creates the Task; it never touches execution. Once
// resolved here, the plan is frozen into DurableTaskRunStateStore before
// step 1 runs — a later edit or delete of the WorkflowDefinition can never
// affect this run.
export const handleAutomationsRunRoutes: AsyncRouteRegistrar<AutomationsRunRouteDeps> = async (method, pathname, _body, headers, _query, deps): Promise<ApiResult | undefined> => {
  const { workflowDefinitionService, taskStore, taskRunStore, aiService, planResolver, capabilityBroker, getRelevantMemories, taskContinuations, durableTaskRunState, auditLogger, notificationEngine, modelErrorResult } = deps;

  if (pathname.startsWith('/api/v1/workflows/') && pathname.endsWith('/run') && method === 'POST') {
    const workflowId = pathname.slice('/api/v1/workflows/'.length, pathname.length - '/run'.length);
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_workflow_run_${Date.now()}`;
    const workflowTenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
    const workflowPrincipalId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';

    let prepared;
    try {
      prepared = workflowDefinitionService.prepareRun(workflowId, workflowTenantId, workflowPrincipalId, requestId);
    } catch (error) {
      return modelErrorResult(error);
    }
    const { resolved, task } = prepared;

    const workflowRunner = new ExecutingTaskRunner(aiService, planResolver, capabilityBroker, (tenantId, principalId, prompt) => getRelevantMemories(tenantId, principalId, prompt), taskContinuations, durableTaskRunState);
    const workflowScheduler = new TaskScheduler(
      taskStore,
      taskRunStore,
      { run: (t: TaskRecord, reqId: string, runId: string) => workflowRunner.runWithResolvedPlan(t, reqId, runId, resolved) },
      auditLogger,
      undefined,
      notificationEngine,
    );
    const run = await workflowScheduler.runOne(task);
    return { status: 200, data: run };
  }

  return undefined;
};
