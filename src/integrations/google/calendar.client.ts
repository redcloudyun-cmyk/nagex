import { NagexError } from '../../common/errors.js';

type FetchFn = typeof fetch;

export interface CalendarEventPayload {
  calendarId: string; // e.g. "primary"
  summary: string; // event title
  description: string;
  start: string; // ISO 8601
  end: string; // ISO 8601
  timezone: string; // IANA timezone, e.g. "America/Los_Angeles"
  attendees: string[]; // emails
  conferenceData?: boolean; // true = attach a Google Meet link; omitted/false = none
}

export interface CreatedCalendarEvent {
  externalId: string;
  externalUrl: string;
}

async function googleApiRequest(
  url: string,
  method: 'GET' | 'POST',
  accessToken: string,
  body: unknown,
  fetchFn: FetchFn,
  requestId: string,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchFn(url, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new NagexError({
      code: 'GOOGLE_CALENDAR_NETWORK_ERROR',
      category: 'PROVIDER',
      message: 'Could not reach the Google Calendar API.',
      request_id: requestId,
    });
  }

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;

  if (!response.ok) {
    const category = response.status === 401 || response.status === 403 ? 'AUTHENTICATION' : 'PROVIDER';
    const message =
      (payload?.error as { message?: string } | undefined)?.message || `Google Calendar API request failed with HTTP ${response.status}.`;
    throw new NagexError({
      code: `GOOGLE_CALENDAR_HTTP_${response.status}`,
      category,
      message,
      request_id: requestId,
    });
  }

  return payload;
}

export async function createCalendarEvent(
  accessToken: string,
  payload: CalendarEventPayload,
  fetchFn: FetchFn,
  requestId: string,
): Promise<CreatedCalendarEvent> {
  const calendarId = encodeURIComponent(payload.calendarId || 'primary');
  const wantsConference = payload.conferenceData === true;
  const body: Record<string, unknown> = {
    summary: payload.summary,
    description: payload.description || undefined,
    start: { dateTime: payload.start, timeZone: payload.timezone },
    end: { dateTime: payload.end, timeZone: payload.timezone },
    attendees: payload.attendees.map((email) => ({ email })),
  };
  if (wantsConference) {
    body.conferenceData = {
      createRequest: { requestId: `nagex_${requestId}`, conferenceSolutionKey: { type: 'hangoutsMeet' } },
    };
  }

  const url = `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events${wantsConference ? '?conferenceDataVersion=1' : ''}`;
  const result = await googleApiRequest(url, 'POST', accessToken, body, fetchFn, requestId);

  const externalId = typeof result.id === 'string' ? result.id : null;
  const externalUrl = typeof result.htmlLink === 'string' ? result.htmlLink : null;
  if (!externalId || !externalUrl) {
    throw new NagexError({
      code: 'GOOGLE_CALENDAR_MALFORMED_RESPONSE',
      category: 'PROVIDER',
      message: 'Google Calendar did not return an event ID or link.',
      request_id: requestId,
    });
  }
  return { externalId, externalUrl };
}

export interface FreeBusyInterval {
  start: string;
  end: string;
}

export async function queryFreeBusy(
  accessToken: string,
  params: { calendarId: string; timeMin: string; timeMax: string },
  fetchFn: FetchFn,
  requestId: string,
): Promise<FreeBusyInterval[]> {
  const result = await googleApiRequest(
    'https://www.googleapis.com/calendar/v3/freeBusy',
    'POST',
    accessToken,
    { timeMin: params.timeMin, timeMax: params.timeMax, items: [{ id: params.calendarId || 'primary' }] },
    fetchFn,
    requestId,
  );
  const calendars = (result.calendars ?? {}) as Record<string, { busy?: FreeBusyInterval[] }>;
  const entry = calendars[params.calendarId || 'primary'];
  return entry?.busy ?? [];
}

// Pure helper: derive open gaps of at least `minDurationMinutes` within
// [timeMin, timeMax] that do not overlap any interval in `busy`.
export function computeFreeSlots(
  busy: FreeBusyInterval[],
  timeMin: string,
  timeMax: string,
  minDurationMinutes = 30,
): FreeBusyInterval[] {
  const rangeStart = new Date(timeMin).getTime();
  const rangeEnd = new Date(timeMax).getTime();
  const sortedBusy = [...busy]
    .map((interval) => ({ start: new Date(interval.start).getTime(), end: new Date(interval.end).getTime() }))
    .sort((a, b) => a.start - b.start);

  const minMs = minDurationMinutes * 60 * 1000;
  const slots: FreeBusyInterval[] = [];
  let cursor = rangeStart;

  for (const interval of sortedBusy) {
    const busyStart = Math.max(interval.start, rangeStart);
    const busyEnd = Math.min(interval.end, rangeEnd);
    if (busyStart > cursor && busyStart - cursor >= minMs) {
      slots.push({ start: new Date(cursor).toISOString(), end: new Date(busyStart).toISOString() });
    }
    cursor = Math.max(cursor, busyEnd);
  }
  if (rangeEnd - cursor >= minMs) {
    slots.push({ start: new Date(cursor).toISOString(), end: new Date(rangeEnd).toISOString() });
  }
  return slots;
}
