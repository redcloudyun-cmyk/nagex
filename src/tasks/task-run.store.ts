import { FileRecordStore, resolveNagexDataDir } from '../governance/file-record.store.js';

export type TaskRunStatus = 'RUNNING' | 'SUCCEEDED' | 'FAILED';

// A TaskRun is the execution record for one firing of a Task — the Tasks
// analogue of governance/execution.store.ts's ExecutionRecord, so a Task's
// history shows up in the same "Executions" shape the rest of NAgex already
// uses (MASTER.md AC-08).
export interface TaskRunRecord {
  runId: string;
  taskId: string;
  tenantId: string;
  status: TaskRunStatus;
  startedAt: string;
  completedAt: string | null;
  // Sprint A scope: the real, resolved Plan Preview the task's objective
  // produced (see tasks/task.runner.ts) — never a fabricated result.
  // Automatic tool execution for READ_ONLY_AUTO tasks is Planned, not yet
  // implemented (MASTER.md Section 14.6/14.7).
  result: unknown;
  errorCode: string | null;
}

export function isTaskRunRecord(value: unknown): value is TaskRunRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.runId === 'string' &&
    typeof v.taskId === 'string' &&
    typeof v.tenantId === 'string' &&
    typeof v.status === 'string' &&
    typeof v.startedAt === 'string'
  );
}

export interface TaskRunStoreOptions {
  dir?: string;
  env?: NodeJS.ProcessEnv;
}

export class TaskRunStore {
  private readonly fileStore: FileRecordStore<TaskRunRecord>;

  constructor(options: TaskRunStoreOptions = {}) {
    const env = options.env ?? process.env;
    const dir = options.dir ?? resolveNagexDataDir('task-runs', 'NAGEX_TASK_RUNS_DIR', env);
    this.fileStore = new FileRecordStore<TaskRunRecord>(dir, isTaskRunRecord);
  }

  public start(record: Omit<TaskRunRecord, 'status' | 'completedAt' | 'result' | 'errorCode'>): TaskRunRecord {
    const full: TaskRunRecord = { ...record, status: 'RUNNING', completedAt: null, result: null, errorCode: null };
    this.fileStore.write(full.runId, full);
    return full;
  }

  public succeed(runId: string, outcome: { result: unknown; completedAt: string }): void {
    const existing = this.fileStore.read(runId);
    if (!existing) return;
    this.fileStore.write(runId, { ...existing, status: 'SUCCEEDED', ...outcome });
  }

  public fail(runId: string, outcome: { errorCode: string; completedAt: string }): void {
    const existing = this.fileStore.read(runId);
    if (!existing) return;
    this.fileStore.write(runId, { ...existing, status: 'FAILED', ...outcome });
  }

  public get(runId: string): TaskRunRecord | null {
    return this.fileStore.read(runId);
  }

  public listForTask(taskId: string): TaskRunRecord[] {
    return this.fileStore.readAll()
      .filter((r) => r.taskId === taskId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
}
