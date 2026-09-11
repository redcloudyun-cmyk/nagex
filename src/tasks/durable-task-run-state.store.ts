import { getCurrentISOString } from '../common/utils.js';
import { FileRecordStore, resolveNagexDataDir } from '../governance/file-record.store.js';
import type { ResolvedPlanStep } from '../planning/plan-resolver.js';

// P03 — Durable Multi-step Workflow Runtime.
//
// The single authoritative persisted snapshot of a run's step-execution
// progress, keyed by runId. Before this store existed, ExecutingTaskRunner
// only ever persisted intermediate progress at the moment it paused for
// approval (see task-continuation.store.ts) — a purely read-only multi-step
// run, or a write-approval run crashing between two read-only steps, left
// nothing durable at all: a process restart mid-run orphaned the
// TaskRunRecord at status RUNNING forever, with no code anywhere ever
// revisiting it. This store closes that gap generally, for every step of
// every ExecutingTaskRunner run, not only the approval-pause case.
//
// Single-source-of-truth note (governs task-continuation.store.ts too): the
// frozen resolvedSteps/stepIndex/executedSoFar snapshot for a paused run now
// lives here ONLY, addressed by runId. TaskContinuationRecord (approvalId-
// keyed) no longer duplicates it — it keeps just the small denormalized
// capabilityId/payload fields needed to describe what a given approval is
// for, and points at this store's runId for the actual resumable state.
export type StepExecutionStatus = 'EXECUTED';

export interface StepExecutionResult {
  step: number;
  capabilityId: string;
  status: StepExecutionStatus;
  result: unknown;
}

// RUNNING: steps are executing (or a step's approval-request call is
// in flight) — nothing is waiting on a human. WAITING_APPROVAL: paused,
// mirrors TaskContinuationStore's own WAITING state for the same run.
// SUCCEEDED/FAILED: terminal — a startup recovery scan must never touch
// these.
export type DurableTaskRunStatus = 'RUNNING' | 'WAITING_APPROVAL' | 'SUCCEEDED' | 'FAILED';

export interface DurableTaskRunStateRecord {
  runId: string;
  taskId: string;
  tenantId: string;
  ownerId: string;
  runRequestId: string;
  // Frozen once, at run creation — never re-derived, never re-planned, even
  // across a pause/resume or a crash/recovery cycle (freeze-the-plan-once).
  resolvedSteps: ResolvedPlanStep[];
  // Index into resolvedSteps of the next step to execute.
  stepIndex: number;
  executedSoFar: StepExecutionResult[];
  status: DurableTaskRunStatus;
  waitingApprovalId: string | null;
  createdAt: string;
  updatedAt: string;
}

export function isDurableTaskRunStateRecord(value: unknown): value is DurableTaskRunStateRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.runId === 'string' &&
    typeof v.taskId === 'string' &&
    typeof v.tenantId === 'string' &&
    typeof v.ownerId === 'string' &&
    typeof v.runRequestId === 'string' &&
    Array.isArray(v.resolvedSteps) &&
    typeof v.stepIndex === 'number' &&
    Array.isArray(v.executedSoFar) &&
    typeof v.status === 'string' &&
    typeof v.createdAt === 'string'
  );
}

export interface DurableTaskRunStateStoreOptions {
  dir?: string;
  env?: NodeJS.ProcessEnv;
}

export interface CreateDurableTaskRunStateInput {
  runId: string;
  taskId: string;
  tenantId: string;
  ownerId: string;
  runRequestId: string;
  resolvedSteps: ResolvedPlanStep[];
}

export class DurableTaskRunStateStore {
  private readonly fileStore: FileRecordStore<DurableTaskRunStateRecord>;

  constructor(options: DurableTaskRunStateStoreOptions = {}) {
    const env = options.env ?? process.env;
    const dir = options.dir ?? resolveNagexDataDir('durable-task-runs', 'NAGEX_DURABLE_TASK_RUNS_DIR', env);
    this.fileStore = new FileRecordStore<DurableTaskRunStateRecord>(dir, isDurableTaskRunStateRecord);
  }

  // Called once, at the very start of a fresh run (ExecutingTaskRunner.run,
  // before the first step executes) — the plan is frozen into this record
  // here and never rewritten afterward.
  public create(input: CreateDurableTaskRunStateInput): DurableTaskRunStateRecord {
    const now = getCurrentISOString();
    const record: DurableTaskRunStateRecord = {
      ...input,
      stepIndex: 0,
      executedSoFar: [],
      status: 'RUNNING',
      waitingApprovalId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.fileStore.write(record.runId, record);
    return record;
  }

  // Called immediately after a step's real broker dispatch returns EXECUTED
  // — the crash-recovery persistence point. Writing this only after the
  // real side effect (if any) already happened, and reusing the exact same
  // deterministic per-step requestId on any later retry, is what lets a
  // recovery re-dispatch of the same step land on the Broker's own
  // idempotency cache instead of a second real execution (see
  // durable-task-runtime.ts for the full crash-window analysis).
  public recordStepExecuted(runId: string, step: StepExecutionResult, nextStepIndex: number): void {
    const existing = this.fileStore.read(runId);
    if (!existing) return;
    this.fileStore.write(runId, {
      ...existing,
      executedSoFar: [...existing.executedSoFar, step],
      stepIndex: nextStepIndex,
      updatedAt: getCurrentISOString(),
    });
  }

  public markWaitingApproval(runId: string, approvalId: string): void {
    const existing = this.fileStore.read(runId);
    if (!existing) return;
    this.fileStore.write(runId, { ...existing, status: 'WAITING_APPROVAL', waitingApprovalId: approvalId, updatedAt: getCurrentISOString() });
  }

  // Called at the start of resuming a paused run (human granted the
  // approval) — transitions back to RUNNING. Safe to call redundantly: the
  // real replay protection for "was this approval already resumed" is
  // TaskContinuationStore.markResumed()'s claim(), invoked upstream of this.
  public markResuming(runId: string): void {
    const existing = this.fileStore.read(runId);
    if (!existing) return;
    this.fileStore.write(runId, { ...existing, status: 'RUNNING', waitingApprovalId: null, updatedAt: getCurrentISOString() });
  }

  public markTerminal(runId: string, status: 'SUCCEEDED' | 'FAILED'): void {
    const existing = this.fileStore.read(runId);
    if (!existing) return;
    this.fileStore.write(runId, { ...existing, status, updatedAt: getCurrentISOString() });
  }

  public get(runId: string): DurableTaskRunStateRecord | null {
    return this.fileStore.read(runId);
  }

  // The startup-recovery source: every run genuinely still mid-flight when
  // the process last stopped — a WAITING_APPROVAL run is deliberately
  // excluded (it already has its own event-triggered resume path, unchanged
  // from P02) and a terminal run is excluded (nothing to recover).
  public listRunning(): DurableTaskRunStateRecord[] {
    return this.fileStore.readAll().filter((r) => r.status === 'RUNNING');
  }

  public listForTask(taskId: string): DurableTaskRunStateRecord[] {
    return this.fileStore.readAll().filter((r) => r.taskId === taskId);
  }
}
