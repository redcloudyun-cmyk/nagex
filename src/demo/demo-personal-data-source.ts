// R23.2D — Demo Canonicalization.
//
// Same interface CurrentPersonalContextService already accepts
// (CalendarEventsSource/GmailSearchSource) — never a parallel Calendar/
// Gmail concept of its own. Computed fresh on every call, purely from the
// canonical demo persona fixture + "today" — no external API, no
// persisted mutable state (mirrors how the pre-existing
// DemoScenarioService already computed these deterministically per
// request; the only thing that changed is that this now flows through the
// exact same real aggregation/ranking pipeline every other tenant uses,
// instead of a second hardcoded response shape).
import fs from 'node:fs';
import path from 'node:path';
import type { UpcomingCalendarEvent } from '../modules/calendar/index.js';
import type { CalendarEventsSource, GmailSearchSource } from '../personal/current-personal-context.service.js';

interface PersonaFixture {
  events: Array<{ id: string; time: string; title: string; attendees: string[] }>;
  email: { id: string; from: string; subject: string; summary: string };
}

function loadFixture(fixturePath: string): PersonaFixture {
  return JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as PersonaFixture;
}

// Relative-to-"now" offsets, keyed by the canonical fixture's stable event
// ids — deterministic on every call regardless of real wall-clock time
// (DEMO reset must stay deterministic — R23.2D success criterion #6). A
// fixed-clock-hour design (e.g. always "3:00 PM") would make the client
// meeting silently vanish from the real pipeline late in the day, since
// CurrentPersonalContextService correctly excludes ended events — that is
// honest behavior for real data, but it would make demo reliability depend
// on what time someone happens to run it. The client meeting is always
// placed in progress right now instead, which both keeps the demo always
// presentable and reliably makes RightNowIntelligenceService's real,
// unmodified priority rules select it as primary (P0 always outranks the
// seeded P2 approval) — never a special case in the ranking logic itself.
const DEFAULT_EVENT_DURATION_MIN = 30;
const DEMO_EVENT_OFFSETS_MIN: Record<string, { startOffsetMin: number; durationMin: number }> = {
  demo_evt_client: { startOffsetMin: -5, durationMin: 30 }, // in progress now
  demo_evt_research: { startOffsetMin: 90, durationMin: 30 }, // later today
  demo_evt_q3: { startOffsetMin: 180, durationMin: 30 }, // later today
};

export class DemoCalendarSource implements CalendarEventsSource {
  private readonly fixture: PersonaFixture;

  constructor(fixturePath = path.join(process.cwd(), 'demo', 'seed', 'canonical-persona.json')) {
    this.fixture = loadFixture(fixturePath);
  }

  public async listUpcomingEvents(_input: {
    tenantId: string;
    calendarId?: string;
    timeMin: string;
    timeMax: string;
    maxResults?: number;
    requestId: string;
  }): Promise<UpcomingCalendarEvent[]> {
    const now = Date.now();
    return this.fixture.events.map((event) => {
      const offset = DEMO_EVENT_OFFSETS_MIN[event.id] ?? { startOffsetMin: 60, durationMin: DEFAULT_EVENT_DURATION_MIN };
      const start = new Date(now + offset.startOffsetMin * 60000).toISOString();
      const end = new Date(now + (offset.startOffsetMin + offset.durationMin) * 60000).toISOString();
      return {
        id: event.id,
        title: event.title,
        start,
        end,
        status: 'confirmed',
        updated: null,
        source: 'DEMO_SEED',
        attendees: event.attendees,
      };
    });
  }
}

export class DemoGmailSource implements GmailSearchSource {
  private readonly fixture: PersonaFixture;

  constructor(fixturePath = path.join(process.cwd(), 'demo', 'seed', 'canonical-persona.json')) {
    this.fixture = loadFixture(fixturePath);
  }

  public async search(_input: { tenantId: string; query: string; requestId: string }): Promise<{
    threads: Array<{ threadId: string; snippet: string; historyId: string | null }>;
  }> {
    return { threads: [{ threadId: this.fixture.email.id, snippet: this.fixture.email.summary, historyId: null }] };
  }
}

// Tenant-branching decorators: the ONLY place "which data source" is
// decided. CurrentPersonalContextService's own logic never branches on
// tenant — it just calls whatever CalendarEventsSource/GmailSearchSource
// it was constructed with (DEMO_PARALLEL_INTELLIGENCE_PIPELINE=0).
export class TenantBranchingCalendarSource implements CalendarEventsSource {
  constructor(
    private readonly real: CalendarEventsSource,
    private readonly demo: CalendarEventsSource,
    private readonly demoTenantId: string,
  ) {}

  public listUpcomingEvents(input: Parameters<CalendarEventsSource['listUpcomingEvents']>[0]): ReturnType<CalendarEventsSource['listUpcomingEvents']> {
    return (input.tenantId === this.demoTenantId ? this.demo : this.real).listUpcomingEvents(input);
  }
}

export class TenantBranchingGmailSource implements GmailSearchSource {
  constructor(
    private readonly real: GmailSearchSource,
    private readonly demo: GmailSearchSource,
    private readonly demoTenantId: string,
  ) {}

  public search(input: Parameters<GmailSearchSource['search']>[0]): ReturnType<GmailSearchSource['search']> {
    return (input.tenantId === this.demoTenantId ? this.demo : this.real).search(input);
  }
}
