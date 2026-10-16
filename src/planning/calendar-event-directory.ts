// The events "방금 만든 회의" can refer to: what NAgex itself created for this person lately (from its own execution records - the event id and what was approved), refreshed with what the person's
// calendar shows now, plus the person's calendar window. Owner- and tenant-scoped: another person's executions and approvals are never read. Read-only.
import type { ActionApprovalStore } from '../governance/action-approval.store.js';
import type { ExecutionStore, ExecutionRecord } from '../governance/execution.store.js';
import { instantOf } from '../modules/calendar/index.js';
import type { CalendarWindowReader } from './calendar-context.js';
import type { KnownCalendarEvent } from './calendar-reschedule.js';
import type { ScheduleClock } from './schedule-grounding.js';

const CREATE = 'google_calendar.create_event';
const UPDATE = 'google_calendar.update_event';
const CANCEL = 'google_calendar.cancel_event';
const CREATED_LOOKBACK_MS = 24 * 3600_000;
const WINDOW_BEFORE_MS = 3600_000;
const WINDOW_AFTER_MS = 14 * 24 * 3600_000;

export interface CalendarEventDirectoryDeps {
  executions: Pick<ExecutionStore, 'list'>;
  approvals: Pick<ActionApprovalStore, 'get'>;
  readCalendarWindow?: CalendarWindowReader;
}

export interface DirectoryResult {
  events: KnownCalendarEvent[];
  /** the connection state of the calendar read; UNAVAILABLE when it could not be attempted */
  calendarState: string;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

export class CalendarEventDirectory {
  constructor(private readonly deps: CalendarEventDirectoryDeps) {}

  /** Events NAgex created (and since moved, or cancelled) for this person in the last day. */
  private createdByNagex(tenantId: string, principalId: string, clock: ScheduleClock): KnownCalendarEvent[] {
    const mine = this.deps.executions.list().filter((r: ExecutionRecord) => r.tenantId === tenantId && r.principalId === principalId && r.status === 'SUCCEEDED' && r.externalId && r.completedAt);
    const at = (r: ExecutionRecord) => Date.parse(r.completedAt as string);
    const payloadOf = (r: ExecutionRecord): Record<string, unknown> | null => (r.approvalId ? this.deps.approvals.get(r.approvalId, tenantId, principalId)?.canonicalPayload ?? null : null);
    const cancelled = new Set(mine.filter((r) => r.toolId === CANCEL).map((r) => r.externalId as string));
    const events = new Map<string, KnownCalendarEvent>();
    for (const r of mine.filter((x) => x.toolId === CREATE && clock.nowMs - at(x) <= CREATED_LOOKBACK_MS).sort((a, b) => at(a) - at(b))) {
      const p = payloadOf(r);
      const summary = str(p?.summary);
      const timezone = str(p?.timezone) ?? clock.timezone;
      const startMs = str(p?.start) ? instantOf(String(p?.start), timezone) : null;
      const endMs = str(p?.end) ? instantOf(String(p?.end), timezone) : null;
      if (!p || !summary || startMs === null || endMs === null || cancelled.has(r.externalId as string)) continue;
      events.set(r.externalId as string, { calendarId: str(p.calendarId) ?? 'primary', eventId: r.externalId as string, summary, startMs, endMs, timezone, source: 'NAGEX_CREATED', createdAtMs: at(r) });
    }
    // a time change NAgex already made is applied, so "a little later still" starts from where the event is now
    for (const r of mine.filter((x) => x.toolId === UPDATE).sort((a, b) => at(a) - at(b))) {
      const event = events.get(r.externalId as string);
      const p = payloadOf(r);
      if (!event || !p) continue;
      const timezone = str(p.timezone) ?? event.timezone;
      const startMs = str(p.start) ? instantOf(String(p.start), timezone) : null;
      const endMs = str(p.end) ? instantOf(String(p.end), timezone) : null;
      if (startMs !== null && endMs !== null) { event.startMs = startMs; event.endMs = endMs; event.timezone = timezone; }
      if (str(p.summary)) event.summary = String(p.summary);
    }
    return [...events.values()];
  }

  public async candidates(input: { tenantId: string; principalId: string; clock: ScheduleClock; requestId: string }): Promise<DirectoryResult> {
    const known = new Map(this.createdByNagex(input.tenantId, input.principalId, input.clock).map((e) => [e.eventId, e]));
    let calendarState = 'UNAVAILABLE';
    if (this.deps.readCalendarWindow) {
      try {
        const read = await this.deps.readCalendarWindow({
          tenantId: input.tenantId,
          principalId: input.principalId,
          timeMin: new Date(input.clock.nowMs - WINDOW_BEFORE_MS).toISOString(),
          timeMax: new Date(input.clock.nowMs + WINDOW_AFTER_MS).toISOString(),
          requestId: input.requestId,
        });
        calendarState = read.state;
        if (read.state === 'CONNECTED') {
          for (const item of read.events) {
            // all-day events have a date, not a time: they are not moved by hours
            if (item.status === 'cancelled' || !/T/.test(item.start) || !/T/.test(item.end)) continue;
            const startMs = Date.parse(item.start);
            const endMs = Date.parse(item.end);
            if (Number.isNaN(startMs) || Number.isNaN(endMs)) continue;
            const mine = known.get(item.id);
            if (mine) { mine.startMs = startMs; mine.endMs = endMs; mine.summary = item.title || mine.summary; continue; } // the calendar is the truth about where it is now
            known.set(item.id, { calendarId: 'primary', eventId: item.id, summary: item.title, startMs, endMs, timezone: input.clock.timezone, source: 'CALENDAR' });
          }
        }
      } catch {
        calendarState = 'UNAVAILABLE';
      }
    }
    return { events: [...known.values()], calendarState };
  }
}
