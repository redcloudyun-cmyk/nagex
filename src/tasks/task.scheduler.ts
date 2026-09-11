import { generateResourceId, getCurrentISOString } from '../common/utils.js';
import type { AuditLogger } from '../governance/audit.logger.js';
import type { NotificationEngine } from '../notifications/notification.engine.js';
import { TaskStore, type TaskRecord, type TaskTrigger } from './task.store.js';
import { TaskRunStore, type TaskRunRecord } from './task-run.store.js';
import { finalizeTaskRun } from './task-run-finalizer.js';

// ── Cron (5-field: minute hour day-of-month month day-of-week) ─────────────
// A deliberately small evaluator, not a full croniter port: supports `*`,
// an exact number, a comma-separated list, and a `*/step`. Range syntax
// ("1-5") is not supported yet — this is an honest, documented limitation,
// not a silent bug, and covers every example in MASTER.md Section 14
// ("0 8 * * *" daily-at-8am and similar).
function parseCronField(field: string, min: number, max: number): Set<number> | null {
  const values = new Set<number>();
  for (const part of field.split(',')) {
    const stepMatch = /^\*\/(\d+)$/.exec(part);
    if (part === '*') {
      for (let v = min; v <= max; v++) values.add(v);
    } else if (stepMatch) {
      const step = Number(stepMatch[1]);
      if (!Number.isInteger(step) || step <= 0) return null;
      for (let v = min; v <= max; v += step) values.add(v);
    } else if (/^\d+$/.test(part)) {
      const v = Number(part);
      if (v < min || v > max) return null;
      values.add(v);
    } else {
      return null;
    }
  }
  return values.size > 0 ? values : null;
}

export interface ParsedCron {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
}

export function parseCronExpression(expression: string): ParsedCron | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  const parsed = {
    minute: parseCronField(minute, 0, 59),
    hour: parseCronField(hour, 0, 23),
    dayOfMonth: parseCronField(dayOfMonth, 1, 31),
    month: parseCronField(month, 1, 12),
    dayOfWeek: parseCronField(dayOfWeek, 0, 6),
  };
  if (!parsed.minute || !parsed.hour || !parsed.dayOfMonth || !parsed.month || !parsed.dayOfWeek) return null;
  return parsed as ParsedCron;
}

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function getZonedParts(date: Date, formatter: Intl.DateTimeFormat): { minute: number; hour: number; day: number; month: number; weekday: number } {
  const map: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) map[part.type] = part.value;
  const hour = map.hour === '24' ? 0 : Number(map.hour);
  return { minute: Number(map.minute), hour, day: Number(map.day), month: Number(map.month), weekday: WEEKDAY_INDEX[map.weekday] ?? 0 };
}

const MAX_SCAN_MINUTES = 366 * 24 * 60; // ~1 year safety cap for an unmatchable expression (e.g. day 30 in a cron pinned to February)

// Scans forward minute-by-minute (evaluated in `timezone`'s wall-clock time)
// for the next minute matching every cron field, starting strictly after
// `fromDate`. Returns null if the expression is malformed or matches
// nothing within the safety cap.
export function computeNextScheduleRun(cronExpression: string, timezone: string, fromDate: Date): Date | null {
  const parsed = parseCronExpression(cronExpression);
  if (!parsed) return null;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour12: false,
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    });
  } catch {
    return null; // invalid IANA timezone
  }

  const cursor = new Date(fromDate.getTime() - (fromDate.getTime() % 60000) + 60000); // next whole minute after fromDate
  for (let i = 0; i < MAX_SCAN_MINUTES; i++) {
    const parts = getZonedParts(cursor, formatter);
    if (
      parsed.minute.has(parts.minute) &&
      parsed.hour.has(parts.hour) &&
      parsed.dayOfMonth.has(parts.day) &&
      parsed.month.has(parts.month) &&
      parsed.dayOfWeek.has(parts.weekday)
    ) {
      return cursor;
    }
    cursor.setTime(cursor.getTime() + 60000);
  }
  return null;
}

export function computeNextRunAt(trigger: TaskTrigger, fromDate: Date): Date | null {
  if (trigger.type === 'SCHEDULE' && trigger.schedule) {
    return computeNextScheduleRun(trigger.schedule, trigger.timezone || 'UTC', fromDate);
  }
  if (trigger.type === 'INTERVAL' && typeof trigger.intervalMinutes === 'number' && trigger.intervalMinutes > 0) {
    return new Date(fromDate.getTime() + trigger.intervalMinutes * 60000);
  }
  // A CONDITION trigger with a real watchUrl is heartbeat-driven at
  // checkIntervalMinutes — this is what lets ConditionalWatchTaskRunner
  // actually get invoked periodically (see task.store.ts's listDue).
  if (trigger.type === 'CONDITION' && trigger.watchUrl && typeof trigger.checkIntervalMinutes === 'number' && trigger.checkIntervalMinutes > 0) {
    return new Date(fromDate.getTime() + trigger.checkIntervalMinutes * 60000);
  }
  // WEBHOOK / MANUAL / EMAIL_EVENT / CALENDAR_EVENT / FILE_EVENT /
  // SYSTEM_EVENT / AGENT_EVENT (and a CONDITION trigger with no watchUrl)
  // are not time-scheduler-driven.
  return null;
}

// ── Runner + scheduler orchestration ────────────────────────────────────

export interface TaskRunOutcome {
  // P02 — WAITING_APPROVAL: a real ActionApprovalRecord now exists for a
  // consequential step; the run is paused (not terminal) until a human
  // grants or rejects it. See task-continuation.store.ts/.coordinator.ts.
  status: 'WAITING_APPROVAL' | 'SUCCEEDED' | 'FAILED';
  result?: unknown;
  errorCode?: string;
  // CONDITIONAL tasks only — whether ConditionalWatchTaskRunner determined
  // the watched condition is now true. Ignored for every other task type.
  conditionMet?: boolean;
}

export interface TaskRunner {
  // P02 — runId is the same identity TaskRunStore already tracks this run
  // under (TaskScheduler generates and passes its own runId here); only
  // ExecutingTaskRunner uses it (to bind a persisted continuation record
  // to the correct TaskRunRecord) — every other runner accepts and
  // ignores it.
  run(task: TaskRecord, requestId: string, runId: string): Promise<TaskRunOutcome>;
}

// Phase 09 — finalizeTaskRun()/TaskRunFinalizationDeps moved to
// task-run-finalizer.ts: by P03 it had a second real caller outside the
// scheduler (DurableTaskRuntime's recovery path, alongside
// TaskContinuationCoordinator's resume path), so it is shared Task Runtime
// finalization infrastructure, not scheduler-triggering logic. TaskScheduler
// (below) only triggers; import finalizeTaskRun from task-run-finalizer.js
// directly, not from here.

// Finds ACTIVE tasks whose nextRunAt has arrived, runs each exactly once
// through the injected TaskRunner (never bypassing it — see MASTER.md
// AC-07/AC-10), records a TaskRun, reschedules RECURRING tasks, and
// completes ONE_TIME tasks. Does not itself guard against overlapping
// ticks — the caller (a single setInterval in server_web.ts) must not
// invoke tick() concurrently with itself.
export class TaskScheduler {
  constructor(
    private readonly tasks: TaskStore,
    private readonly runs: TaskRunStore,
    private readonly runner: TaskRunner,
    private readonly audit: AuditLogger,
    private readonly now: () => Date = () => new Date(),
    private readonly notificationEngine?: NotificationEngine,
  ) {}

  public async tick(): Promise<TaskRunRecord[]> {
    const due = this.tasks.listDue(this.now());
    const results: TaskRunRecord[] = [];
    for (const task of due) {
      results.push(await this.runOne(task));
    }
    return results;
  }

  public async runOne(task: TaskRecord): Promise<TaskRunRecord> {
    const requestId = `req_task_${generateResourceId('exe')}`;
    const runId = generateResourceId('exe');
    const startedAt = getCurrentISOString();

    this.tasks.markRunning(task.taskId, requestId);
    this.audit.logEvent({
      actor: { type: 'system', id: 'task-scheduler' },
      tenant_id: task.tenantId,
      action: 'task.triggered',
      resource: { type: 'Task', id: task.taskId },
      result: 'SUCCESS',
      request_id: requestId,
    });
    this.runs.start({ runId, taskId: task.taskId, tenantId: task.tenantId, startedAt });
    this.audit.logEvent({
      actor: { type: 'system', id: 'task-scheduler' },
      tenant_id: task.tenantId,
      action: 'execution.started',
      resource: { type: 'TaskRun', id: runId },
      result: 'SUCCESS',
      request_id: requestId,
    });

    let outcome: TaskRunOutcome;
    try {
      outcome = await this.runner.run(task, requestId, runId);
    } catch (error) {
      outcome = { status: 'FAILED', errorCode: error instanceof Error ? error.message : 'TASK_RUN_FAILED' };
    }

    return finalizeTaskRun(
      { tasks: this.tasks, runs: this.runs, audit: this.audit, now: this.now, notificationEngine: this.notificationEngine },
      task,
      runId,
      requestId,
      outcome,
    );
  }
}
