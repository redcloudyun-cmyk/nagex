import { generateResourceId, getCurrentISOString } from '../common/utils.js';
import { NagexError } from '../common/errors.js';
import { FileRecordStore, resolveNagexDataDir } from '../governance/file-record.store.js';

// MASTER.md Section 14.4 — Tasks Center. A Task is a standing object that
// actually runs, recurs, waits, watches a condition, or is background-
// tracked (as opposed to a Plan, which is how a single run should execute).
export type TaskType = 'ONE_TIME' | 'RECURRING' | 'CONDITIONAL' | 'BACKGROUND' | 'WAITING' | 'STANDING_INTENT';
export type TaskStatus = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'WAITING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'EXPIRED';
export type TaskTriggerType = 'SCHEDULE' | 'INTERVAL' | 'CONDITION' | 'WEBHOOK' | 'EMAIL_EVENT' | 'CALENDAR_EVENT' | 'FILE_EVENT' | 'MANUAL' | 'SYSTEM_EVENT' | 'AGENT_EVENT';
export type TaskApprovalPolicy = 'READ_ONLY_AUTO' | 'ALWAYS_APPROVE';

export interface TaskTrigger {
  type: TaskTriggerType;
  // SCHEDULE: a 5-field cron expression ("m h dom mon dow"), evaluated in `timezone`.
  schedule?: string;
  timezone?: string;
  // INTERVAL: fire every N minutes from the last run.
  intervalMinutes?: number;
  // CONDITION: a free-text description of what is being watched for,
  // evaluated by ConditionalWatchTaskRunner (src/tasks/conditional-watch.runner.ts)
  // against the real, live content of `watchUrl` — fetched read-only via
  // the Browser Agent (MASTER.md Section 14.5 item 07) on every
  // `checkIntervalMinutes` heartbeat. Never notifies while unmet (AC-11):
  // an unmet or failed check simply stays WAITING and retries at the next
  // interval; only a genuinely met condition ever completes the task.
  condition?: string;
  watchUrl?: string;
  checkIntervalMinutes?: number;
}

export interface TaskProgress {
  percent: number;
  currentStep: string;
  totalSteps: number;
  completedSteps: number;
  statusMessage: string;
  logs: string[];
}

export interface TaskRecord {
  taskId: string;
  tenantId: string;
  ownerId: string;
  name: string;
  // The natural-language instruction the task runs each time it fires.
  objective: string;
  type: TaskType;
  status: TaskStatus;
  sourceSessionId: string | null;
  trigger: TaskTrigger;
  approvalPolicy: TaskApprovalPolicy;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: 'SUCCEEDED' | 'FAILED' | null;
  progress?: TaskProgress | null;
  createdAt: string;
  updatedAt: string;
}

export function isTaskRecord(value: unknown): value is TaskRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.taskId === 'string' &&
    typeof v.tenantId === 'string' &&
    typeof v.ownerId === 'string' &&
    typeof v.name === 'string' &&
    typeof v.objective === 'string' &&
    typeof v.type === 'string' &&
    typeof v.status === 'string' &&
    !!v.trigger && typeof v.trigger === 'object' &&
    typeof v.approvalPolicy === 'string' &&
    typeof v.createdAt === 'string' &&
    typeof v.updatedAt === 'string'
  );
}

export interface CreateTaskInput {
  tenantId: string;
  ownerId: string;
  name: string;
  objective: string;
  type: TaskType;
  sourceSessionId?: string | null;
  trigger: TaskTrigger;
  approvalPolicy?: TaskApprovalPolicy;
  nextRunAt?: string | null;
}

export interface TaskStoreOptions {
  dir?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => string;
}

// Persistent Task CRUD + lifecycle transitions. Deliberately does not know
// how to actually run a task (that is TaskRunner/TaskScheduler's job) — this
// store only owns the record and its status/schedule bookkeeping, so a Task
// can never bypass the same Tool Registry / Approval Policy path anything
// else in NAgex uses to execute (MASTER.md AC-07/AC-10).
export class TaskStore {
  private readonly records = new Map<string, TaskRecord>();
  private readonly fileStore: FileRecordStore<TaskRecord>;
  private readonly now: () => string;

  constructor(options: TaskStoreOptions = {}) {
    const env = options.env ?? process.env;
    const dir = options.dir ?? resolveNagexDataDir('tasks', 'NAGEX_TASKS_DIR', env);
    this.fileStore = new FileRecordStore<TaskRecord>(dir, isTaskRecord);
    this.now = options.now ?? (() => getCurrentISOString());
    for (const record of this.fileStore.readAll()) this.records.set(record.taskId, record);
  }

  private persist(record: TaskRecord): TaskRecord {
    record.updatedAt = this.now();
    this.records.set(record.taskId, record);
    this.fileStore.write(record.taskId, record);
    return record;
  }

  public create(input: CreateTaskInput): TaskRecord {
    if (!input.name.trim()) {
      throw new NagexError({ code: 'TASK_NAME_REQUIRED', category: 'VALIDATION', message: 'A task name is required.', request_id: 'task_create' });
    }
    if (!input.objective.trim()) {
      throw new NagexError({ code: 'TASK_OBJECTIVE_REQUIRED', category: 'VALIDATION', message: 'A task objective is required.', request_id: 'task_create' });
    }
    const timestamp = this.now();
    const record: TaskRecord = {
      taskId: generateResourceId('tsk'),
      tenantId: input.tenantId,
      ownerId: input.ownerId,
      name: input.name.trim(),
      objective: input.objective.trim(),
      type: input.type,
      // A CONDITIONAL task starts (and, per recordRunOutcome below, stays)
      // WAITING until its condition is actually met — it is never ACTIVE
      // the way a RECURRING/ONE_TIME task's next-run countdown is.
      status: input.type === 'CONDITIONAL' ? 'WAITING' : 'ACTIVE',
      sourceSessionId: input.sourceSessionId ?? null,
      trigger: input.trigger,
      approvalPolicy: input.approvalPolicy ?? 'ALWAYS_APPROVE',
      nextRunAt: input.nextRunAt ?? null,
      lastRunAt: null,
      lastRunStatus: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    return this.persist(record);
  }

  public get(taskId: string): TaskRecord | undefined {
    return this.records.get(taskId);
  }

  private require(taskId: string, requestId: string): TaskRecord {
    const record = this.records.get(taskId);
    if (!record) {
      throw new NagexError({ code: 'TASK_NOT_FOUND', category: 'NOT_FOUND', message: `Task ${taskId} was not found.`, request_id: requestId });
    }
    return record;
  }

  public list(ownerId: string): TaskRecord[] {
    return [...this.records.values()]
      .filter((t) => t.ownerId === ownerId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  // Tasks whose nextRunAt has arrived: ACTIVE (SCHEDULE/INTERVAL) tasks, and
  // WAITING CONDITIONAL tasks whose next heartbeat check is due. WEBHOOK/
  // MANUAL/EMAIL_EVENT/... triggered tasks are never returned here — they
  // have no nextRunAt to arrive in the first place.
  public listDue(asOf: Date): TaskRecord[] {
    const nowMs = asOf.getTime();
    return [...this.records.values()].filter(
      (t) =>
        (t.status === 'ACTIVE' || (t.status === 'WAITING' && t.type === 'CONDITIONAL')) &&
        t.nextRunAt !== null &&
        new Date(t.nextRunAt).getTime() <= nowMs,
    );
  }

  public update(taskId: string, patch: Partial<Pick<TaskRecord, 'name' | 'objective' | 'trigger' | 'approvalPolicy' | 'nextRunAt'>>, requestId = 'task_update'): TaskRecord {
    const record = this.require(taskId, requestId);
    if (patch.name !== undefined) record.name = patch.name;
    if (patch.objective !== undefined) record.objective = patch.objective;
    if (patch.trigger !== undefined) record.trigger = patch.trigger;
    if (patch.approvalPolicy !== undefined) record.approvalPolicy = patch.approvalPolicy;
    if (patch.nextRunAt !== undefined) record.nextRunAt = patch.nextRunAt;
    return this.persist(record);
  }

  public updateProgress(taskId: string, progress: TaskProgress, requestId = 'task_update_progress'): TaskRecord {
    const record = this.require(taskId, requestId);
    record.progress = progress;
    return this.persist(record);
  }

  public pause(taskId: string, requestId = 'task_pause'): TaskRecord {
    const record = this.require(taskId, requestId);
    if (record.status !== 'ACTIVE' && record.status !== 'WAITING') {
      throw new NagexError({ code: 'TASK_NOT_PAUSABLE', category: 'CONFLICT', message: `Task ${taskId} is ${record.status}, not active.`, request_id: requestId });
    }
    record.status = 'PAUSED';
    return this.persist(record);
  }

  public resume(taskId: string, requestId = 'task_resume'): TaskRecord {
    const record = this.require(taskId, requestId);
    if (record.status !== 'PAUSED') {
      throw new NagexError({ code: 'TASK_NOT_RESUMABLE', category: 'CONFLICT', message: `Task ${taskId} is ${record.status}, not paused.`, request_id: requestId });
    }
    record.status = record.type === 'CONDITIONAL' || record.type === 'WAITING' ? 'WAITING' : 'ACTIVE';
    return this.persist(record);
  }

  public cancel(taskId: string, requestId = 'task_cancel'): TaskRecord {
    const record = this.require(taskId, requestId);
    record.status = 'CANCELLED';
    return this.persist(record);
  }

  public delete(taskId: string, requestId = 'task_delete'): void {
    this.require(taskId, requestId);
    this.records.delete(taskId);
    this.fileStore.remove(taskId);
  }

  public markRunning(taskId: string, requestId = 'task_run'): TaskRecord {
    const record = this.require(taskId, requestId);
    record.status = 'RUNNING';
    return this.persist(record);
  }

  // Called once a run finishes: records the outcome, and either reschedules
  // (RECURRING with a computed next run) or completes (ONE_TIME) the task.
  // `nextRunAt` is computed by the caller (TaskScheduler) — this store does
  // not know cron/interval semantics.
  public recordRunOutcome(
    taskId: string,
    outcome: { status: 'SUCCEEDED' | 'FAILED'; completedAt: string; nextRunAt: string | null; conditionMet?: boolean },
    requestId = 'task_run_outcome',
  ): TaskRecord {
    const record = this.require(taskId, requestId);
    record.lastRunAt = outcome.completedAt;
    record.lastRunStatus = outcome.status;
    if (record.type === 'RECURRING' && outcome.nextRunAt) {
      record.status = 'ACTIVE';
      record.nextRunAt = outcome.nextRunAt;
    } else if (record.type === 'ONE_TIME') {
      record.status = outcome.status === 'SUCCEEDED' ? 'COMPLETED' : 'FAILED';
      record.nextRunAt = null;
    } else if (record.type === 'CONDITIONAL') {
      // AC-11: never notify while unmet. A check that errored (page
      // unreachable, CAPTCHA, ambiguous judgment) and a check that
      // completed but found the condition still unmet are treated exactly
      // the same way here — silently stay WAITING and retry at the next
      // heartbeat. Only outcome.conditionMet === true ever completes it.
      if (outcome.status === 'SUCCEEDED' && outcome.conditionMet) {
        record.status = 'COMPLETED';
        record.nextRunAt = null;
      } else {
        record.status = 'WAITING';
        record.nextRunAt = outcome.nextRunAt;
      }
    } else {
      record.status = outcome.status === 'SUCCEEDED' ? 'ACTIVE' : 'FAILED';
      record.nextRunAt = outcome.nextRunAt;
    }
    return this.persist(record);
  }
}
