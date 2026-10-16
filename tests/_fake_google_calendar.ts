// TEST-ONLY (not a test file): a faithful stand-in for the Google Calendar v3 REST API, as a `fetch` function, so the REAL token store, approval store, execution pipeline and calendar service can be
// driven end to end without a network, a Google account or a credential. It is a FAKE: a pass here proves NAgex's own behaviour (approval gating, idempotent creates, read-back verification), never that
// Google answered - the opt-in live run is tests/google_calendar_live.test.ts and needs a real authorized account.
//
// It models what the behaviour under test depends on:
//   - events.insert with a client-chosen id: a duplicate id is HTTP 409 - also for an id whose event was deleted (Google never frees an id); a bad id is 400;
//   - events.get: 404 unknown, 410 for a deleted event; events.patch merges; events.delete is 204;
//   - a naive dateTime plus timeZone is stored with the real UTC offset; attendees get a responseStatus and the organizer is listed as `self`;
//   - events.list (timeMin / timeMax overlap, q, privateExtendedProperty, orderBy startTime);
//   - faults: a lost response after the event was created, a change that is accepted but not applied, a read-back that fails, a slow provider.
import { wallTimeToInstant, zonedParts } from '../src/common/time-context.js';

export interface FakeCalendarEvent {
  id: string;
  status: 'confirmed' | 'cancelled';
  summary?: string;
  description?: string;
  start: { dateTime: string; timeZone?: string };
  end: { dateTime: string; timeZone?: string };
  attendees?: Array<{ email: string; responseStatus: string; self?: boolean; organizer?: boolean }>;
  htmlLink: string;
  etag: string;
  extendedProperties?: { private?: Record<string, string> };
  conferenceData?: unknown;
  created: string;
  updated: string;
}

export interface FakeCalendarCall { method: string; path: string; query: string; body: any }

export interface FakeSeedEvent {
  id: string;
  summary: string;
  /** a wall-clock time (read in timeZone) or a time with an offset */
  start: string;
  end: string;
  timeZone?: string;
  description?: string;
  attendees?: FakeCalendarEvent['attendees'];
  extendedProperties?: FakeCalendarEvent['extendedProperties'];
}

export interface FakeGoogleCalendar {
  fetch: typeof fetch;
  calls: FakeCalendarCall[];
  events: () => FakeCalendarEvent[];
  seed: (event: FakeSeedEvent) => FakeCalendarEvent;
  /** the person deletes the event in the Google Calendar app (the id stays reserved) */
  deleteBehindNagex: (id: string) => void;
  faults: {
    /** the next insert creates the event and then the response never arrives */
    loseNextInsertResponse: boolean;
    /** patches are answered 200 but nothing is applied */
    ignorePatches: boolean;
    /** deletes are answered 204 but the event stays */
    ignoreDeletes: boolean;
    /** GET of a single event fails with this status */
    failGetWith: number | null;
    /** every call takes this long */
    latencyMs: number;
  };
}

const json = (data: unknown, status = 200): Response => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const apiError = (status: number, message: string, reason: string): Response => json({ error: { code: status, message, errors: [{ reason, message }], status: reason.toUpperCase() } }, status);

function offsetString(ms: number, timeZone: string): string {
  const minutes = zonedParts(ms, timeZone).offsetMinutes;
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/** A naive wall-clock dateTime is read in its timeZone and stored with the real offset; a dateTime with an offset is kept. */
function normalizeTime(input: { dateTime?: string; timeZone?: string } | undefined): { dateTime: string; timeZone?: string } | null {
  if (!input?.dateTime) return null;
  const text = input.dateTime;
  if (/[Zz]$|[+-]\d{2}:?\d{2}$/.test(text)) return { dateTime: text, ...(input.timeZone ? { timeZone: input.timeZone } : {}) };
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(text);
  if (!m) return null;
  const zone = input.timeZone || 'UTC';
  const instant = wallTimeToInstant({ year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), hour: Number(m[4]), minute: Number(m[5]) }, zone).ms;
  return { dateTime: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? '00'}${offsetString(instant, zone)}`, timeZone: zone };
}

const VALID_ID = /^[a-v0-9]{5,1024}$/;

export function createFakeGoogleCalendar(options: { organizerEmail?: string; now?: () => number } = {}): FakeGoogleCalendar {
  const organizer = options.organizerEmail ?? 'me@example.com';
  const now = options.now ?? Date.now;
  const store = new Map<string, FakeCalendarEvent>();
  const deleted = new Set<string>();
  const calls: FakeCalendarCall[] = [];
  let counter = 0;
  const faults: FakeGoogleCalendar['faults'] = { loseNextInsertResponse: false, ignorePatches: false, ignoreDeletes: false, failGetWith: null, latencyMs: 0 };
  const stamp = () => new Date(now()).toISOString();

  const attendeesFrom = (list: unknown): FakeCalendarEvent['attendees'] | undefined => {
    if (!Array.isArray(list) || list.length === 0) return undefined;
    const people = (list as Array<{ email?: string }>).filter((a) => typeof a.email === 'string').map((a) => ({ email: String(a.email).toLowerCase(), responseStatus: 'needsAction' }));
    return [{ email: organizer, responseStatus: 'accepted', self: true, organizer: true }, ...people.filter((p) => p.email !== organizer)];
  };

  const insert = (body: any): Response => {
    const id: string = typeof body?.id === 'string' ? body.id : `gen${(counter += 1).toString(36).padStart(8, '0')}${Math.floor(now() % 1000).toString(36)}`;
    if (typeof body?.id === 'string' && !VALID_ID.test(id)) return apiError(400, 'Invalid resource id value.', 'invalid');
    if (store.has(id) || deleted.has(id)) return apiError(409, 'The requested identifier already exists.', 'duplicate');
    const start = normalizeTime(body?.start);
    const end = normalizeTime(body?.end);
    if (!start || !end) return apiError(400, 'Missing or invalid start / end.', 'required');
    const event: FakeCalendarEvent = {
      id, status: 'confirmed', summary: body.summary, description: body.description, start, end, attendees: attendeesFrom(body.attendees),
      htmlLink: `https://www.google.com/calendar/event?eid=${id}`, etag: `"${(counter += 1)}"`, extendedProperties: body.extendedProperties, created: stamp(), updated: stamp(),
      ...(body.conferenceData ? { conferenceData: { conferenceId: `meet-${id}` } } : {}),
    };
    store.set(id, event);
    return json(event);
  };

  const fetchFn = (async (input: any, init?: any): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : String(input?.url ?? input));
    const method = String(init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname, query: url.search, body });
    if (faults.latencyMs) await new Promise((r) => setTimeout(r, faults.latencyMs));
    if (!/^Bearer \S+$/.test(String((init?.headers as Record<string, string> | undefined)?.Authorization ?? ''))) return apiError(401, 'Invalid Credentials', 'authError');

    const free = /^\/calendar\/v3\/freeBusy$/.exec(url.pathname);
    if (free && method === 'POST') {
      const busy = [...store.values()].filter((e) => e.status === 'confirmed').map((e) => ({ start: e.start.dateTime, end: e.end.dateTime }));
      return json({ calendars: { [body?.items?.[0]?.id ?? 'primary']: { busy } } });
    }

    const match = /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(url.pathname);
    if (!match) return apiError(404, 'Not Found', 'notFound');
    const eventId = match[2] ? decodeURIComponent(match[2]) : null;

    if (!eventId && method === 'POST') {
      const created = insert(body);
      if (created.status === 200 && faults.loseNextInsertResponse) {
        faults.loseNextInsertResponse = false;
        throw new TypeError('fetch failed'); // the event exists on the calendar; the answer never arrived
      }
      return created;
    }

    if (!eventId && method === 'GET') {
      const timeMin = url.searchParams.get('timeMin');
      const timeMax = url.searchParams.get('timeMax');
      const q = url.searchParams.get('q')?.toLowerCase();
      const privateProp = url.searchParams.get('privateExtendedProperty');
      let items = [...store.values()].filter((e) => e.status === 'confirmed');
      if (timeMin) items = items.filter((e) => Date.parse(e.end.dateTime) > Date.parse(timeMin));
      if (timeMax) items = items.filter((e) => Date.parse(e.start.dateTime) < Date.parse(timeMax));
      if (q) items = items.filter((e) => `${e.summary ?? ''} ${e.description ?? ''}`.toLowerCase().includes(q));
      if (privateProp) { const [k, v] = privateProp.split('='); items = items.filter((e) => e.extendedProperties?.private?.[k] === v); }
      items.sort((a, b) => Date.parse(a.start.dateTime) - Date.parse(b.start.dateTime));
      return json({ kind: 'calendar#events', items: items.slice(0, Number(url.searchParams.get('maxResults') ?? 250)) });
    }

    if (!eventId) return apiError(405, 'Method Not Allowed', 'methodNotAllowed');

    if (method === 'GET') {
      if (faults.failGetWith) return apiError(faults.failGetWith, 'Backend Error', 'backendError');
      if (deleted.has(eventId)) return apiError(410, 'Resource has been deleted', 'deleted');
      const event = store.get(eventId);
      return event ? json(event) : apiError(404, 'Not Found', 'notFound');
    }
    if (method === 'PATCH') {
      if (deleted.has(eventId)) return apiError(410, 'Resource has been deleted', 'deleted');
      const event = store.get(eventId);
      if (!event) return apiError(404, 'Not Found', 'notFound');
      if (faults.ignorePatches) return json(event);
      if (body?.summary !== undefined) event.summary = body.summary;
      if (body?.description !== undefined) event.description = body.description;
      if (body?.start) { const s = normalizeTime(body.start); if (s) event.start = s; }
      if (body?.end) { const e = normalizeTime(body.end); if (e) event.end = e; }
      if (body?.attendees !== undefined) {
        // an RSVP patch carries the full attendee objects (with self); a plain replacement carries emails
        event.attendees = (body.attendees as Array<Record<string, unknown>>).some((a) => 'self' in a || 'responseStatus' in a)
          ? (body.attendees as FakeCalendarEvent['attendees'])
          : attendeesFrom(body.attendees);
      }
      event.etag = `"${(counter += 1)}"`;
      event.updated = stamp();
      return json(event);
    }
    if (method === 'DELETE') {
      if (deleted.has(eventId)) return apiError(410, 'Resource has been deleted', 'deleted');
      if (!store.has(eventId)) return apiError(404, 'Not Found', 'notFound');
      if (!faults.ignoreDeletes) { store.delete(eventId); deleted.add(eventId); }
      return new Response(null, { status: 204 });
    }
    return apiError(405, 'Method Not Allowed', 'methodNotAllowed');
  }) as typeof fetch;

  return {
    fetch: fetchFn,
    calls,
    events: () => [...store.values()],
    seed: (e) => {
      const start = normalizeTime({ dateTime: e.start, timeZone: e.timeZone })!;
      const end = normalizeTime({ dateTime: e.end, timeZone: e.timeZone })!;
      const event: FakeCalendarEvent = {
        id: e.id, status: 'confirmed', summary: e.summary, description: e.description, start, end, attendees: e.attendees, htmlLink: `https://www.google.com/calendar/event?eid=${e.id}`,
        etag: `"${(counter += 1)}"`, extendedProperties: e.extendedProperties, created: stamp(), updated: stamp(),
      };
      store.set(event.id, event);
      return event;
    },
    deleteBehindNagex: (id) => { store.delete(id); deleted.add(id); },
    faults,
  };
}
