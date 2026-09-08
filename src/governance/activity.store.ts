import crypto from 'node:crypto';
import { getCurrentISOString } from '../common/utils.js';
import { FileRecordStore, resolveNagexDataDir } from './file-record.store.js';

// Phase 1 STEP 8 — the Activity Projection layer.
//
// AuditLogger records technical facts (candidate.action.succeeded,
// tool.execution.started, ...); this store records the human-understandable
// projection of those facts a consumer sees on Home/Inbox/the Activity tab.
// The two are deliberately separate: AuditLogger stays the technical trail,
// this store is the only thing consumer surfaces are allowed to read.
export type ActivityStatus = 'RUNNING' | 'COMPLETED' | 'FAILED' | 'NEEDS_ATTENTION';

export interface ActivitySource {
  captureId?: string;
  candidateId?: string;
  taskId?: string;
  approvalId?: string;
  executionId?: string;
}

export interface ActivityItem {
  activityId: string;
  tenantId: string;
  principalId: string;
  type: string;
  title: string;
  description?: string;
  status: ActivityStatus;
  occurredAt: string;
  source?: ActivitySource;
}

function isActivityStatus(value: unknown): value is ActivityStatus {
  return value === 'RUNNING' || value === 'COMPLETED' || value === 'FAILED' || value === 'NEEDS_ATTENTION';
}

// Fail-closed validator for FileRecordStore — a corrupted activity file is
// treated as absent rather than trusted.
export function isActivityItem(value: unknown): value is ActivityItem {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.activityId === 'string' &&
    typeof v.tenantId === 'string' &&
    typeof v.principalId === 'string' &&
    typeof v.type === 'string' &&
    typeof v.title === 'string' &&
    isActivityStatus(v.status) &&
    typeof v.occurredAt === 'string'
  );
}

export interface RecordActivityInput {
  tenantId: string;
  principalId: string;
  type: string;
  title: string;
  description?: string;
  status: ActivityStatus;
  source?: ActivitySource;
  // Phase 1 STEP 8, item J: a stable identity derived from real lifecycle
  // identity (e.g. `candidateId:SUCCEEDED`, `captureId:understood`) — NEVER
  // a timestamp. Recording the same logical event twice (retry, replayed
  // hydration, duplicate call) overwrites the same record rather than
  // appending a duplicate.
  dedupeKey: string;
}

export interface ActivityStoreOptions {
  dir?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => string;
}

// One JSON file per activity item, tenant-isolated at query time the same
// way every other canonical store in this codebase isolates tenants
// (CandidateStore, TaskStore, ...) — never a second UI-only database
// (item B).
export class ActivityStore {
  private readonly fileStore: FileRecordStore<ActivityItem>;
  private readonly now: () => string;

  constructor(options: ActivityStoreOptions = {}) {
    const env = options.env ?? process.env;
    const dir = options.dir ?? resolveNagexDataDir('activity', 'NAGEX_ACTIVITY_DIR', env);
    this.fileStore = new FileRecordStore<ActivityItem>(dir, isActivityItem);
    this.now = options.now ?? (() => getCurrentISOString());
  }

  private deriveId(tenantId: string, principalId: string, dedupeKey: string): string {
    return `act_${crypto.createHash('sha256').update(`${tenantId}::${principalId}::${dedupeKey}`).digest('hex').slice(0, 24)}`;
  }

  public record(input: RecordActivityInput): ActivityItem {
    const activityId = this.deriveId(input.tenantId, input.principalId, input.dedupeKey);
    const item: ActivityItem = {
      activityId,
      tenantId: input.tenantId,
      principalId: input.principalId,
      type: input.type,
      title: input.title,
      description: input.description,
      status: input.status,
      occurredAt: this.now(),
      source: input.source,
    };
    this.fileStore.write(activityId, item);
    return item;
  }

  public list(tenantId: string, principalId: string, limit = 50): ActivityItem[] {
    return this.fileStore.readAll()
      .filter((a) => a.tenantId === tenantId && a.principalId === principalId)
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
      .slice(0, Math.max(0, limit));
  }
}
