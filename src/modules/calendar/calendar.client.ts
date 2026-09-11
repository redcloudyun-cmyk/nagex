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
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
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

export interface UpdateCalendarEventPayload {
  calendarId: string;
  eventId: string;
  summary?: string;
  description?: string;
  start?: string;
  end?: string;
  timezone?: string;
  attendees?: string[];
}

export async function updateCalendarEvent(
  accessToken: string,
  payload: UpdateCalendarEventPayload,
  fetchFn: FetchFn,
  requestId: string,
): Promise<CreatedCalendarEvent> {
  const calendarId = encodeURIComponent(payload.calendarId || 'primary');
  const eventId = encodeURIComponent(payload.eventId);
  const body: Record<string, unknown> = {};
  if (payload.summary !== undefined) body.summary = payload.summary;
  if (payload.description !== undefined) body.description = payload.description;
  if (payload.start !== undefined) body.start = { dateTime: payload.start, timeZone: payload.timezone };
  if (payload.end !== undefined) body.end = { dateTime: payload.end, timeZone: payload.timezone };
  if (payload.attendees !== undefined) body.attendees = payload.attendees.map((email) => ({ email }));

  const url = `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${eventId}`;
  const result = await googleApiRequest(url, 'PATCH', accessToken, body, fetchFn, requestId);

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

export async function cancelCalendarEvent(
  accessToken: string,
  params: { calendarId: string; eventId: string },
  fetchFn: FetchFn,
  requestId: string,
): Promise<CreatedCalendarEvent> {
  const calendarId = encodeURIComponent(params.calendarId || 'primary');
  const eventId = encodeURIComponent(params.eventId);
  const url = `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${eventId}`;
  // A successful cancel/delete returns HTTP 204 with no body — there is
  // nothing to parse for an id/link, so the URL is reconstructed from the
  // known eventId rather than taken from the (empty) response.
  await googleApiRequest(url, 'DELETE', accessToken, null, fetchFn, requestId);
  return { externalId: params.eventId, externalUrl: `https://calendar.google.com/calendar/u/0/r/eventedit/${eventId}` };
}

export type CalendarRsvpResponseStatus = 'accepted' | 'declined' | 'tentative';

export interface RespondToCalendarEventPayload {
  calendarId: string;
  eventId: string;
  responseStatus: CalendarRsvpResponseStatus;
}

export async function respondToCalendarEvent(
  accessToken: string,
  payload: RespondToCalendarEventPayload,
  fetchFn: FetchFn,
  requestId: string,
): Promise<CreatedCalendarEvent> {
  const calendarId = encodeURIComponent(payload.calendarId || 'primary');
  const eventId = encodeURIComponent(payload.eventId);
  const eventUrl = `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${eventId}`;

  // The Calendar API models "my RSVP" as one entry within the event's own
  // attendees array (the one Google flags `self: true`), not a separate
  // endpoint — so responding requires reading the current attendees first,
  // then PATCHing back the same array with only that one entry changed.
  const existing = await googleApiRequest(eventUrl, 'GET', accessToken, null, fetchFn, requestId);
  const attendees = Array.isArray(existing.attendees) ? (existing.attendees as Array<Record<string, unknown>>) : [];
  if (!attendees.some((attendee) => attendee.self === true)) {
    throw new NagexError({
      code: 'GOOGLE_CALENDAR_NOT_AN_ATTENDEE',
      category: 'VALIDATION',
      message: 'The connected account is not an attendee on this event, so there is no RSVP to change.',
      request_id: requestId,
    });
  }
  const updatedAttendees = attendees.map((attendee) => (attendee.self === true ? { ...attendee, responseStatus: payload.responseStatus } : attendee));

  const result = await googleApiRequest(eventUrl, 'PATCH', accessToken, { attendees: updatedAttendees }, fetchFn, requestId);
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
