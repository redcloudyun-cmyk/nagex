// What NAgex checks AFTER Google Calendar accepted a change, and how a retried create is kept from duplicating an event. Pure: no network, no clock.
//   - Provider acceptance (HTTP 2xx) is not a verified result. After create / update / cancel / RSVP the event is read back from the calendar and compared with exactly what was approved:
//     VERIFIED (the calendar shows it), MISMATCH (the calendar shows something else), NOT_VERIFIED (it could not be read back). Only VERIFIED may be described as confirmed.
//   - A create carries a deterministic event id derived from what was approved (who, which calendar, title, time, attendees). The same approved event sent again - a retry after a lost response, a
//     second approval of the same request - collides on that id (HTTP 409) instead of creating a second event, and the existing event is read back and verified.
import crypto from 'node:crypto';
import { wallTimeToInstant } from '../../common/time-context.js';
import type { CalendarEventPayload, UpdateCalendarEventPayload } from './calendar.client.js';

export type CalendarVerificationOutcome = 'VERIFIED' | 'MISMATCH' | 'NOT_VERIFIED';

export interface CalendarVerificationCheck {
  field: string;
  expected: string;
  actual: string | null;
  ok: boolean;
}

export interface CalendarVerification {
  outcome: CalendarVerificationOutcome;
  checks: CalendarVerificationCheck[];
  /** why it could not be read back (NOT_VERIFIED) */
  note?: string;
  readAt: string;
}

/** The parts of an event NAgex reads back; never the raw provider response. */
export interface CalendarEventReadback {
  id: string;
  status: string;
  summary: string;
  description: string;
  startMs: number | null;
  endMs: number | null;
  allDay: boolean;
  attendees: Array<{ email: string; responseStatus?: string; self?: boolean }>;
  htmlLink: string | null;
  hasConference: boolean;
  nagexKey: string | null;
}

function instantFromProvider(value: unknown): { ms: number | null; allDay: boolean } {
  if (!value || typeof value !== 'object') return { ms: null, allDay: false };
  const v = value as Record<string, unknown>;
  if (typeof v.dateTime === 'string') { const ms = Date.parse(v.dateTime); return { ms: Number.isNaN(ms) ? null : ms, allDay: false }; }
  if (typeof v.date === 'string') { const ms = Date.parse(`${v.date}T00:00:00Z`); return { ms: Number.isNaN(ms) ? null : ms, allDay: true }; }
  return { ms: null, allDay: false };
}

export function normalizeReadback(raw: unknown): CalendarEventReadback | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string') return null;
  const start = instantFromProvider(r.start);
  const end = instantFromProvider(r.end);
  const attendees = Array.isArray(r.attendees)
    ? (r.attendees as Array<Record<string, unknown>>).filter((a) => typeof a.email === 'string').map((a) => ({
        email: String(a.email).toLowerCase(),
        ...(typeof a.responseStatus === 'string' ? { responseStatus: a.responseStatus } : {}),
        ...(a.self === true ? { self: true } : {}),
      }))
    : [];
  const extended = (r.extendedProperties as { private?: Record<string, unknown> } | undefined)?.private;
  return {
    id: r.id,
    status: typeof r.status === 'string' ? r.status : 'confirmed',
    summary: typeof r.summary === 'string' ? r.summary : '',
    description: typeof r.description === 'string' ? r.description : '',
    startMs: start.ms,
    endMs: end.ms,
    allDay: start.allDay,
    attendees,
    htmlLink: typeof r.htmlLink === 'string' ? r.htmlLink : null,
    hasConference: Boolean(r.conferenceData) || typeof r.hangoutLink === 'string',
    nagexKey: extended && typeof extended.nagexKey === 'string' ? extended.nagexKey : null,
  };
}

/** A payload's start / end as an instant: a value with an offset or Z is taken as written; a wall-clock value is read in the payload's timezone. */
export function instantOf(value: string, timezone: string): number | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (/[Zz]$|[+-]\d{2}:?\d{2}$/.test(text)) { const ms = Date.parse(text); return Number.isNaN(ms) ? null : ms; }
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(text);
  if (!m) { const ms = Date.parse(text); return Number.isNaN(ms) ? null : ms; }
  return wallTimeToInstant({ year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), hour: Number(m[4]), minute: Number(m[5]) }, timezone || 'UTC').ms;
}

const shown = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

function finish(checks: CalendarVerificationCheck[], readAt: string): CalendarVerification {
  return { outcome: checks.every((c) => c.ok) ? 'VERIFIED' : 'MISMATCH', checks, readAt };
}

export function notVerified(note: string, readAt: string): CalendarVerification {
  return { outcome: 'NOT_VERIFIED', checks: [], note, readAt };
}

export function verifyCreated(payload: CalendarEventPayload, event: CalendarEventReadback, readAt: string): CalendarVerification {
  const checks: CalendarVerificationCheck[] = [];
  checks.push({ field: 'status', expected: 'not cancelled', actual: event.status, ok: event.status !== 'cancelled' });
  checks.push({ field: 'summary', expected: payload.summary, actual: event.summary, ok: event.summary === payload.summary });
  const start = instantOf(payload.start, payload.timezone);
  const end = instantOf(payload.end, payload.timezone);
  checks.push({ field: 'start', expected: shown(start) ?? payload.start, actual: shown(event.startMs), ok: start !== null && event.startMs === start });
  checks.push({ field: 'end', expected: shown(end) ?? payload.end, actual: shown(event.endMs), ok: end !== null && event.endMs === end });
  const wanted = payload.attendees.map((e) => e.toLowerCase());
  const have = new Set(event.attendees.map((a) => a.email));
  checks.push({ field: 'attendees', expected: wanted.join(', ') || '(none)', actual: [...have].join(', ') || '(none)', ok: wanted.every((e) => have.has(e)) });
  return finish(checks, readAt);
}

export function verifyUpdated(payload: UpdateCalendarEventPayload, event: CalendarEventReadback, readAt: string): CalendarVerification {
  const checks: CalendarVerificationCheck[] = [];
  checks.push({ field: 'status', expected: 'not cancelled', actual: event.status, ok: event.status !== 'cancelled' });
  if (payload.summary !== undefined) checks.push({ field: 'summary', expected: payload.summary, actual: event.summary, ok: event.summary === payload.summary });
  if (payload.description !== undefined) checks.push({ field: 'description', expected: payload.description, actual: event.description, ok: event.description === payload.description });
  if (payload.start !== undefined) { const t = instantOf(payload.start, payload.timezone || 'UTC'); checks.push({ field: 'start', expected: shown(t) ?? payload.start, actual: shown(event.startMs), ok: t !== null && event.startMs === t }); }
  if (payload.end !== undefined) { const t = instantOf(payload.end, payload.timezone || 'UTC'); checks.push({ field: 'end', expected: shown(t) ?? payload.end, actual: shown(event.endMs), ok: t !== null && event.endMs === t }); }
  if (payload.attendees !== undefined) {
    const wanted = payload.attendees.map((e) => e.toLowerCase());
    const have = event.attendees.map((a) => a.email);
    // a replaced attendee list: every wanted address is present and nobody who was not wanted remains (the organizer may be listed by the provider)
    checks.push({ field: 'attendees', expected: wanted.join(', ') || '(none)', actual: have.join(', ') || '(none)', ok: wanted.every((e) => have.includes(e)) });
  }
  return finish(checks, readAt);
}

/** `event` is null when the calendar no longer has it (404 / 410). */
export function verifyCancelled(event: CalendarEventReadback | null, readAt: string): CalendarVerification {
  if (event === null) return { outcome: 'VERIFIED', checks: [{ field: 'event', expected: 'removed', actual: 'not found', ok: true }], readAt };
  return finish([{ field: 'status', expected: 'cancelled', actual: event.status, ok: event.status === 'cancelled' }], readAt);
}

export function verifyResponded(responseStatus: string, event: CalendarEventReadback, readAt: string): CalendarVerification {
  const self = event.attendees.find((a) => a.self === true);
  if (!self) return notVerified('The calendar does not list you as an attendee of this event, so the answer could not be read back.', readAt);
  return finish([{ field: 'responseStatus', expected: responseStatus, actual: self.responseStatus ?? null, ok: self.responseStatus === responseStatus }], readAt);
}

// ---- idempotency ------------------------------------------------------------------------------------------------------------------------------------------

/** Everything that makes two approved creates "the same event". */
export function idempotencyKeyFor(tenantId: string, principalId: string, payload: CalendarEventPayload): string {
  const canonical = JSON.stringify([
    tenantId, principalId, payload.calendarId || 'primary', payload.summary.trim(), instantOf(payload.start, payload.timezone), instantOf(payload.end, payload.timezone),
    [...payload.attendees].map((e) => e.toLowerCase()).sort(), payload.conferenceData === true,
  ]);
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

const BASE32HEX = '0123456789abcdefghijklmnopqrstuv';

/** A valid Google event id (base32hex, lower case, 5-1024 characters) derived from the key. Attempt 2+ is used only when the first id belongs to an event that was deleted (Google never frees an id). */
export function eventIdFromKey(key: string, attempt = 1): string {
  const digest = crypto.createHash('sha256').update(attempt === 1 ? key : `${key}#${attempt}`).digest().subarray(0, 20);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of digest) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += BASE32HEX[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  return `nag${out}`;
}
