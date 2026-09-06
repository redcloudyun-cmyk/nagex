import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';

// public/calendar-intent-extraction.js is a dependency-free browser script
// (IIFE), loaded the same way tests/plan_resolution_ui.test.ts loads
// plan-resolution-view.js: run its real source in a vm sandbox so we exercise
// the actual extraction logic the Ambient Assistant UI uses to auto-populate
// the calendar approval payload (item 9), not a re-implementation of it.
function loadCalendarIntentExtraction(): {
  extractCalendarIntent: (prompt: string, referenceDate: Date, timezone: string) => {
    calendarId: string;
    summary: string;
    description: string;
    start: string;
    end: string;
    timezone: string;
    attendees: string[];
    conferenceData: boolean;
  } | null;
  extractTitle: (prompt: string) => string | null;
  extractDurationMinutes: (prompt: string) => number | null;
  extractTimeOfDay: (prompt: string) => { hour: number; minute: number } | null;
  extractDayOffset: (prompt: string) => number | null;
  extractAttendees: (prompt: string) => string[];
} {
  const source = fs.readFileSync(path.join(process.cwd(), 'public', 'calendar-intent-extraction.js'), 'utf8');
  const sandbox: Record<string, unknown> = {};
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'calendar-intent-extraction.js' });
  return (sandbox.window as Record<string, unknown>).NAGEX_CALENDAR_INTENT as ReturnType<typeof loadCalendarIntentExtraction>;
}

const extraction = loadCalendarIntentExtraction();

test('item 9 regression: the exact live prompt extracts the exact required calendar payload', () => {
  const prompt = 'Schedule a meeting tomorrow at 2 PM for 30 minutes titled "NAgex UI Calendar Test".';
  const referenceDate = new Date(2026, 8, 6, 9, 0, 0); // 2026-09-06 09:00 local (a Sunday)
  const payload = extraction.extractCalendarIntent(prompt, referenceDate, 'America/Los_Angeles');

  assert.ok(payload, 'expected a fully-extracted payload for an unambiguous prompt');
  assert.equal(payload!.calendarId, 'primary');
  assert.equal(payload!.summary, 'NAgex UI Calendar Test');
  assert.equal(payload!.start, '2026-09-07T14:00:00');
  assert.equal(payload!.end, '2026-09-07T14:30:00');
  assert.equal(payload!.timezone, 'America/Los_Angeles');
  // Array.from() re-materializes the vm sandbox's own realm array as a
  // host-realm array — see the note on realm boundaries in
  // tests/plan_resolution_ui.test.ts; deepEqual on the raw vm-realm array
  // would spuriously fail on prototype identity, not content.
  assert.deepEqual(Array.from(payload!.attendees), []);
  assert.equal(payload!.conferenceData, false);
});

test('extraction never invents attendees when none are named in the prompt', () => {
  const attendees = extraction.extractAttendees('Schedule a meeting tomorrow at 2 PM for 30 minutes titled "Sync".');
  assert.deepEqual(Array.from(attendees), []);
});

test('extraction picks up an attendee only when an email address literally appears in the prompt', () => {
  const attendees = extraction.extractAttendees('Schedule it tomorrow at 2 PM and invite john@example.com.');
  assert.deepEqual(Array.from(attendees), ['john@example.com']);
});

test('extraction supports single-quoted titles too', () => {
  const title = extraction.extractTitle("Schedule a meeting tomorrow at 2 PM for 30 minutes titled 'NAgex UI Calendar Test'.");
  assert.equal(title, 'NAgex UI Calendar Test');
});

test('extraction defaults to a 30 minute duration when none is stated', () => {
  const prompt = 'Schedule a meeting tomorrow at 2 PM titled "Quick Sync".';
  const referenceDate = new Date(2026, 8, 6, 9, 0, 0);
  const payload = extraction.extractCalendarIntent(prompt, referenceDate, 'UTC');
  assert.ok(payload);
  assert.equal(payload!.start, '2026-09-07T14:00:00');
  assert.equal(payload!.end, '2026-09-07T14:30:00');
});

test('extraction understands an hour-based duration', () => {
  const minutes = extraction.extractDurationMinutes('for 1 hour');
  assert.equal(minutes, 60);
});

test('extraction returns null (never a guess) when the day is not stated', () => {
  const payload = extraction.extractCalendarIntent('Schedule a meeting at 2 PM for 30 minutes titled "Sync".', new Date(), 'UTC');
  assert.equal(payload, null);
});

test('extraction returns null when the time is not stated', () => {
  const payload = extraction.extractCalendarIntent('Schedule a meeting tomorrow titled "Sync".', new Date(), 'UTC');
  assert.equal(payload, null);
});

test('extraction returns null when there is no title', () => {
  const payload = extraction.extractCalendarIntent('Schedule a meeting tomorrow at 2 PM for 30 minutes.', new Date(), 'UTC');
  assert.equal(payload, null);
});

test('extraction handles a 24-hour time format', () => {
  const time = extraction.extractTimeOfDay('Schedule it tomorrow at 14:00 for 30 minutes.');
  // Spread into a host-realm object literal before comparing — see the note
  // above on vm sandbox realm boundaries.
  assert.deepEqual({ ...time }, { hour: 14, minute: 0 });
});

test('12-hour noon and midnight edge cases resolve correctly', () => {
  assert.deepEqual({ ...extraction.extractTimeOfDay('at 12 PM') }, { hour: 12, minute: 0 });
  assert.deepEqual({ ...extraction.extractTimeOfDay('at 12 AM') }, { hour: 0, minute: 0 });
});
