import { generateResourceId, getCurrentISOString } from '../common/utils.js';
import { NagexError } from '../common/errors.js';
import { FileRecordStore, resolveNagexDataDir } from '../governance/file-record.store.js';

// P07 — Reusable Workflow Definition Foundation.
//
// A WorkflowDefinition is a reusable, static description of a multi-step
// workflow — never an execution engine. Instantiating one (POST
// /api/v1/workflows/:id/run) converts its steps into a PlanPreview, resolves
// it through the existing PlanResolver, and hands the result to the existing
// ExecutingTaskRunner/TaskScheduler/Capability Broker/Approval/Durable Task
// Runtime path unchanged (see workflow-definition.service.ts). This store
// owns only the reusable definition record — it has no knowledge of runs,
// steps executing, or approvals.
export interface WorkflowStepDefinition {
  title: string;
  skill: string;
  tool: string | null;
  // Static input values only — never a previous-step output reference, a
  // template/interpolation string, or an expression. PlanResolver already
  // treats a present `parameters` as an opaque, capability-owned object; this
  // mirrors that contract exactly.
  parameters?: Record<string, unknown>;
}

export interface WorkflowDefinition {
  workflowId: string;
  tenantId: string;
  ownerPrincipalId: string;
  name: string;
  description: string;
  enabled: boolean;
  steps: WorkflowStepDefinition[];
  createdAt: string;
  updatedAt: string;
}

function isWorkflowStepDefinition(value: unknown): value is WorkflowStepDefinition {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.title === 'string' &&
    typeof v.skill === 'string' &&
    (v.tool === null || typeof v.tool === 'string') &&
    (v.parameters === undefined || (typeof v.parameters === 'object' && v.parameters !== null && !Array.isArray(v.parameters)))
  );
}

export function isWorkflowDefinition(value: unknown): value is WorkflowDefinition {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.workflowId === 'string' &&
    typeof v.tenantId === 'string' &&
    typeof v.ownerPrincipalId === 'string' &&
    typeof v.name === 'string' &&
    typeof v.description === 'string' &&
    typeof v.enabled === 'boolean' &&
    Array.isArray(v.steps) &&
    v.steps.every(isWorkflowStepDefinition) &&
    typeof v.createdAt === 'string' &&
    typeof v.updatedAt === 'string'
  );
}

export interface CreateWorkflowDefinitionInput {
  tenantId: string;
  ownerPrincipalId: string;
  name: string;
  description: string;
  enabled?: boolean;
  steps: WorkflowStepDefinition[];
}

export interface UpdateWorkflowDefinitionPatch {
  name?: string;
  description?: string;
  enabled?: boolean;
  steps?: WorkflowStepDefinition[];
}

export interface WorkflowDefinitionStoreOptions {
  dir?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => string;
}

export class WorkflowDefinitionStore {
  private readonly records = new Map<string, WorkflowDefinition>();
  private readonly fileStore: FileRecordStore<WorkflowDefinition>;
  private readonly now: () => string;

  constructor(options: WorkflowDefinitionStoreOptions = {}) {
    const env = options.env ?? process.env;
    const dir = options.dir ?? resolveNagexDataDir('workflows', 'NAGEX_WORKFLOW_DEFINITIONS_DIR', env);
    this.fileStore = new FileRecordStore<WorkflowDefinition>(dir, isWorkflowDefinition);
    this.now = options.now ?? (() => getCurrentISOString());
    for (const record of this.fileStore.readAll()) this.records.set(record.workflowId, record);
  }

  private static validateSteps(steps: unknown, requestId: string): WorkflowStepDefinition[] {
    if (!Array.isArray(steps) || steps.length === 0) {
      throw new NagexError({ code: 'WORKFLOW_STEPS_REQUIRED', category: 'VALIDATION', message: 'At least one workflow step is required.', request_id: requestId });
    }
    if (!steps.every(isWorkflowStepDefinition)) {
      throw new NagexError({ code: 'INVALID_WORKFLOW_STEP', category: 'VALIDATION', message: 'Every workflow step must have title/skill/tool, and parameters (if present) must be a plain object.', request_id: requestId });
    }
    return steps as WorkflowStepDefinition[];
  }

  // Durable write BEFORE in-memory mutation, only then does the caller see
  // success — matches the newer FileRecordStore.writeOrThrow() pattern
  // (module-state.store.ts, memory.engine.ts), never TaskStore/
  // NotificationStore's older best-effort write().
  public create(input: CreateWorkflowDefinitionInput, requestId = 'workflow_create'): WorkflowDefinition {
    if (!input.name.trim()) {
      throw new NagexError({ code: 'WORKFLOW_NAME_REQUIRED', category: 'VALIDATION', message: 'A workflow name is required.', request_id: requestId });
    }
    const steps = WorkflowDefinitionStore.validateSteps(input.steps, requestId);
    const timestamp = this.now();
    const record: WorkflowDefinition = {
      workflowId: generateResourceId('wfl'),
      tenantId: input.tenantId,
      ownerPrincipalId: input.ownerPrincipalId,
      name: input.name.trim(),
      description: input.description?.trim() ?? '',
      enabled: input.enabled ?? true,
      steps,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.fileStore.writeOrThrow(record.workflowId, record);
    this.records.set(record.workflowId, record);
    return record;
  }

  // Ownership-enforcing lookup. A tenant/owner mismatch returns undefined,
  // the exact same response as a genuinely nonexistent workflowId — never a
  // distinguishing result, so a caller probing for another tenant's
  // workflow ids learns nothing.
  public get(workflowId: string, tenantId: string, ownerPrincipalId: string): WorkflowDefinition | undefined {
    const record = this.records.get(workflowId);
    if (!record || record.tenantId !== tenantId || record.ownerPrincipalId !== ownerPrincipalId) return undefined;
    return record;
  }

  public list(tenantId: string, ownerPrincipalId: string): WorkflowDefinition[] {
    return [...this.records.values()]
      .filter((r) => r.tenantId === tenantId && r.ownerPrincipalId === ownerPrincipalId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private requireOwned(workflowId: string, tenantId: string, ownerPrincipalId: string, requestId: string): WorkflowDefinition {
    const record = this.records.get(workflowId);
    if (!record || record.tenantId !== tenantId || record.ownerPrincipalId !== ownerPrincipalId) {
      throw new NagexError({ code: 'WORKFLOW_NOT_FOUND', category: 'NOT_FOUND', message: `Workflow ${workflowId} was not found.`, request_id: requestId });
    }
    return record;
  }

  public update(workflowId: string, tenantId: string, ownerPrincipalId: string, patch: UpdateWorkflowDefinitionPatch, requestId = 'workflow_update'): WorkflowDefinition {
    const existing = this.requireOwned(workflowId, tenantId, ownerPrincipalId, requestId);
    const steps = patch.steps !== undefined ? WorkflowDefinitionStore.validateSteps(patch.steps, requestId) : existing.steps;
    const updated: WorkflowDefinition = {
      ...existing,
      name: patch.name !== undefined ? patch.name.trim() : existing.name,
      description: patch.description !== undefined ? patch.description.trim() : existing.description,
      enabled: patch.enabled !== undefined ? patch.enabled : existing.enabled,
      steps,
      updatedAt: this.now(),
    };
    if (!updated.name) {
      throw new NagexError({ code: 'WORKFLOW_NAME_REQUIRED', category: 'VALIDATION', message: 'A workflow name is required.', request_id: requestId });
    }
    this.fileStore.writeOrThrow(workflowId, updated);
    this.records.set(workflowId, updated);
    return updated;
  }

  // Durable removal BEFORE in-memory removal — a crash between the two
  // must never leave the record deleted in memory but still present (and
  // therefore restorable) on disk.
  public delete(workflowId: string, tenantId: string, ownerPrincipalId: string, requestId = 'workflow_delete'): void {
    this.requireOwned(workflowId, tenantId, ownerPrincipalId, requestId);
    this.fileStore.removeOrThrow(workflowId);
    this.records.delete(workflowId);
  }
}
