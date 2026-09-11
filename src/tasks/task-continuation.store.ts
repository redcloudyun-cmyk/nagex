import { generateResourceId, getCurrentISOString } from '../common/utils.js';
import { FileRecordStore, resolveNagexDataDir } from '../governance/file-record.store.js';
import type { ResolvedPlanStep } from '../planning/plan-resolver.js';

// P02 — Approval-aware Task Continuation.
//
// One authoritative persisted snapshot of exactly what's needed to resume
// a Task run that paused at a consequential step: the frozen capability
// call (never re-derived, never re-planned), which already-resolved plan
// step to resume from, and what ran before the pause. This is the resume
// source of truth — the coordinator never re-calls AiService.plan() or
// PlanResolver.resolve() to reconstruct it.
export interface StepExecutionResult {
  step: number;
  capabilityId: string;
  status: 'EXECUTED';
  result: unknown;
}

export type TaskContinuationStatus = 'WAITING' | 'RESUMED';

export interface TaskContinuationRecord {
  // Keyed by approvalId (see get/set below) — an approval can only ever
  // have one associated continuation by construction, so no separate
  // index is needed for the real lookup path (approval grant -> resume).
  approvalId: string;
  continuationId: string;
  taskId: string;
  runId: string;
  tenantId: string;
  ownerId: string;
  // The run's own requestId, needed to keep deriving further per-step
  // request identities the exact same way the original run did.
  runRequestId: string;
  // The already-resolved plan this run is executing — a frozen snapshot,
  // never re-resolved on resume.
  resolvedSteps: ResolvedPlanStep[];
  // Index into resolvedSteps of the step this continuation resumes.
  stepIndex: number;
  // Steps that already executed before this pause, so the final result
  // can report the whole run's steps, not just the resumed tail.
  executedSoFar: StepExecutionResult[];
  // The exact capability + payload that was approval-bound — frozen,
  // reused byte-for-byte on resume, never regenerated or mutated.
  capabilityId: string;
  payload: unknown;
  // Deterministic, distinct from the approval-phase request identity that
  // created the approval (see P02a) — precomputed here so the coordinator
  // never has to guess it.
  executionRequestId: string;
  status: TaskContinuationStatus;
  createdAt: string;
  updatedAt: string;
}

export function isTaskContinuationRecord(value: unknown): value is TaskContinuationRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.approvalId === 'string' &&
    typeof v.continuationId === 'string' &&
    typeof v.taskId === 'string' &&
    typeof v.runId === 'string' &&
    typeof v.tenantId === 'string' &&
    typeof v.ownerId === 'string' &&
    typeof v.runRequestId === 'string' &&
    Array.isArray(v.resolvedSteps) &&
    typeof v.stepIndex === 'number' &&
    Array.isArray(v.executedSoFar) &&
    typeof v.capabilityId === 'string' &&
    typeof v.executionRequestId === 'string' &&
    typeof v.status === 'string' &&
    typeof v.createdAt === 'string'
  );
}

export interface TaskContinuationStoreOptions {
  dir?: string;
  env?: NodeJS.ProcessEnv;
}

export interface CreateTaskContinuationInput {
  taskId: string;
  runId: string;
  tenantId: string;
  ownerId: string;
  runRequestId: string;
  resolvedSteps: ResolvedPlanStep[];
  stepIndex: number;
  executedSoFar: StepExecutionResult[];
  capabilityId: string;
  payload: unknown;
  approvalId: string;
  executionRequestId: string;
}

export class TaskContinuationStore {
  private readonly fileStore: FileRecordStore<TaskContinuationRecord>;

  constructor(options: TaskContinuationStoreOptions = {}) {
    const env = options.env ?? process.env;
    const dir = options.dir ?? resolveNagexDataDir('task-continuations', 'NAGEX_TASK_CONTINUATIONS_DIR', env);
    this.fileStore = new FileRecordStore<TaskContinuationRecord>(dir, isTaskContinuationRecord);
  }

  public create(input: CreateTaskContinuationInput): TaskContinuationRecord {
    const now = getCurrentISOString();
    const record: TaskContinuationRecord = {
      ...input,
      continuationId: generateResourceId('cont'),
      status: 'WAITING',
      createdAt: now,
      updatedAt: now,
    };
    this.fileStore.write(record.approvalId, record);
    return record;
  }

  // The real resume lookup path: approval grant -> find its continuation.
  // Returns undefined if this approvalId has no associated Task
  // continuation (e.g. a UI-originated approval unrelated to any Task) —
  // callers must treat that as a legitimate no-op, never an error.
  public getByApprovalId(approvalId: string): TaskContinuationRecord | undefined {
    return this.fileStore.read(approvalId) ?? undefined;
  }

  // Marks a continuation RESUMED so a duplicate resume trigger (e.g. the
  // approval route firing twice) never processes the same continuation
  // twice — the real replay protection still lives in
  // ActionApprovalStore.consume(), this is defense in depth at the
  // Task-continuation layer specifically.
  public markResumed(approvalId: string): void {
    const existing = this.fileStore.read(approvalId);
    if (!existing) return;
    this.fileStore.write(approvalId, { ...existing, status: 'RESUMED', updatedAt: getCurrentISOString() });
  }

  public listForTask(taskId: string): TaskContinuationRecord[] {
    return this.fileStore.readAll().filter((r) => r.taskId === taskId);
  }
}
