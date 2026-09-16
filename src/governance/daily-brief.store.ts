import crypto from 'node:crypto';
import { FileRecordStore, resolveNagexDataDir } from './file-record.store.js';
import { getCurrentISOString } from '../common/utils.js';

// R9 — durable Daily Brief records. One JSON file per (tenantId,
// principalId, date) triple, exactly like ActivityStore/
// PersistentActionApprovalStore's own real file-per-record pattern — no
// new persistence mechanism invented. Never stores an OAuth token, API
// key, or raw email body: `emails` here is the same snippet-only shape
// server_web.ts's daily-brief route already builds (real Gmail API
// snippets, already minimal — nothing extra is added here).
export type DailyBriefStatus = 'OK' | 'PARTIAL' | 'UNAVAILABLE';

export interface DailyBriefScheduleItem {
  sourceType: 'CALENDAR';
  sourceId: string;
  title: string;
  start: string;
  end: string;
  capability: string;
  timestamp: string;
  // R10.1 — real Google Calendar metadata (never derived/guessed), kept
  // only so a later generation can diff against this one for meaningful
  // change detection (moved/cancelled) without a second Calendar call or a
  // full-event diff. Absent on records persisted before R10.1.
  status?: string | null;
  updated?: string | null;
}

export interface DailyBriefEmailItem {
  sourceType: 'GMAIL';
  sourceId: string;
  snippet: string;
  capability: string;
  timestamp: string | null;
  // R10.1 — real Gmail thread metadata, same change-detection purpose as
  // DailyBriefScheduleItem.status/updated above.
  historyId?: string | null;
}

export interface DailyBriefActionItem {
  title: string;
  reasoning: string;
  priority: 'LOW' | 'MEDIUM' | 'HIGH';
}

export interface DailyBriefRecord {
  briefId: string;
  tenantId: string;
  principalId: string;
  date: string; // YYYY-MM-DD (UTC), the day this brief covers — immutable identity together with tenantId/principalId
  generatedAt: string;
  status: DailyBriefStatus;
  provider: string | null;
  model: string | null;
  latencyMs: number | null;
  fallbackOccurred: boolean;
  calendarStatus: 'CONNECTED' | 'DISCONNECTED' | 'ERROR';
  gmailStatus: 'CONNECTED' | 'DISCONNECTED' | 'ERROR';
  schedule: DailyBriefScheduleItem[];
  emails: DailyBriefEmailItem[];
  summary: string | null;
  actionItems: DailyBriefActionItem[];
  requestId: string;
  // R10.1 — which entry point actually produced this record: the scheduled
  // Proactive Assistant automation, or a real user action (initial GET/
  // manual Refresh click). Home's proactive-state line (§3) needs this to
  // truthfully say "Generated automatically at HH:MM" only when that is
  // actually true. Optional so records persisted before R10.1 still load.
  source?: 'SCHEDULED' | 'MANUAL';
}

export function isDailyBriefRecord(value: unknown): value is DailyBriefRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.briefId === 'string' &&
    typeof v.tenantId === 'string' &&
    typeof v.principalId === 'string' &&
    typeof v.date === 'string' &&
    typeof v.generatedAt === 'string' &&
    typeof v.status === 'string' &&
    Array.isArray(v.schedule) &&
    Array.isArray(v.emails) &&
    Array.isArray(v.actionItems)
  );
}

// UTC calendar date, deliberately not the server's local timezone — keeps
// "today" deterministic across environments/tests rather than depending on
// process.env.TZ.
export function dailyBriefDateKey(now: () => string = getCurrentISOString): string {
  return now().slice(0, 10);
}

export interface DailyBriefStoreOptions {
  dir?: string;
  env?: NodeJS.ProcessEnv;
}

export class DailyBriefStore {
  private readonly fileStore: FileRecordStore<DailyBriefRecord>;

  constructor(options: DailyBriefStoreOptions = {}) {
    const env = options.env ?? process.env;
    const dir = options.dir ?? resolveNagexDataDir('daily-briefs', 'NAGEX_DAILY_BRIEFS_DIR', env);
    this.fileStore = new FileRecordStore<DailyBriefRecord>(dir, isDailyBriefRecord);
  }

  private deriveId(tenantId: string, principalId: string, date: string): string {
    return `db_${crypto.createHash('sha256').update(`${tenantId}::${principalId}::${date}`).digest('hex').slice(0, 24)}`;
  }

  // Save is keyed by (tenantId, principalId, date) — saving again for the
  // SAME date overwrites that date's own record (today can be refreshed
  // freely), but can never touch a different date's file, so a refresh run
  // today structurally cannot mutate yesterday's stored brief (§4).
  public save(record: Omit<DailyBriefRecord, 'briefId'>): DailyBriefRecord {
    const briefId = this.deriveId(record.tenantId, record.principalId, record.date);
    const full: DailyBriefRecord = { ...record, briefId };
    this.fileStore.write(briefId, full);
    return full;
  }

  public getForDate(tenantId: string, principalId: string, date: string): DailyBriefRecord | null {
    const record = this.fileStore.read(this.deriveId(tenantId, principalId, date));
    if (!record || record.tenantId !== tenantId || record.principalId !== principalId) return null;
    return record;
  }

  // Real tenant/owner isolation: readAll() then filter, exactly like
  // ActivityStore.list()/ActionApprovalStore.listPending() — never a
  // cross-tenant read.
  public listHistory(tenantId: string, principalId: string, limit = 7): DailyBriefRecord[] {
    return this.fileStore.readAll()
      .filter((r) => r.tenantId === tenantId && r.principalId === principalId)
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, Math.max(0, limit));
  }
}
