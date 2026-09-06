import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';

// public/calendar-payload-validation.js is a dependency-free browser script
// (IIFE), loaded the same way the other pure frontend modules are in this
// suite: run its real source in a vm sandbox so we exercise the actual
// validation logic the calendar compose form runs before allowing
// "Preview & Request Approval" (item 8).
function loadValidation(): {
  isValidTimezone: (tz: string) => boolean;
  parseAttendees: (raw: string) => string[];
  validateCalendarComposeForm: (fields: {
    title?: string;
    start?: string;
    durationMinutes?: number;
    timezone?: string;
    attendeesRaw?: string;
  }) => { valid: boolean; errors: Record<string, string>; attendees: string[]; startDate: Date | null };
} {
  const source = fs.readFileSync(path.join(process.cwd(), 'public', 'calendar-payload-validation.js'), 'utf8');
  const sandbox: Record<string, unknown> = {};
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'calendar-payload-validation.js' });
  return (sandbox.window as Record<string, unknown>).NAGEX_CALENDAR_VALIDATION as ReturnType<typeof loadValidation>;
}

const validation = loadValidation();

function validFields(overrides: Record<string, unknown> = {}) {
  return {
    title: 'NAgex UI Calendar Test',
    start: '2026-09-07T14:00',
    durationMinutes: 30,
    timezone: 'America/Los_Angeles',
    attendeesRaw: '',
    ...overrides,
  };
}

test('a fully valid form passes with no errors', () => {
  const result = validation.validateCalendarComposeForm(validFields());
  assert.equal(result.valid, true);
  // Spread into a host-realm object literal before comparing — the vm
  // sandbox's own {} has a different realm's Object.prototype, so a raw
  // deepEqual against a host-realm {} would spuriously fail on identity,
  // not content (see the note in tests/plan_resolution_ui.test.ts).
  assert.deepEqual({ ...result.errors }, {});
});

test('title is required', () => {
  const result = validation.validateCalendarComposeForm(validFields({ title: '  ' }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.title);
});

test('a valid start date/time is required', () => {
  const missing = validation.validateCalendarComposeForm(validFields({ start: '' }));
  assert.equal(missing.valid, false);
  assert.ok(missing.errors.start);

  const malformed = validation.validateCalendarComposeForm(validFields({ start: 'not-a-date' }));
  assert.equal(malformed.valid, false);
  assert.ok(malformed.errors.start);
});

test('duration must be greater than 0', () => {
  for (const durationMinutes of [0, -5, NaN]) {
    const result = validation.validateCalendarComposeForm(validFields({ durationMinutes }));
    assert.equal(result.valid, false, `expected duration ${durationMinutes} to be invalid`);
    assert.ok(result.errors.duration);
  }
});

test('timezone must be a recognized IANA zone', () => {
  const result = validation.validateCalendarComposeForm(validFields({ timezone: 'Not/AZone' }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.timezone);
});

test('attendees must be syntactically valid emails when present', () => {
  const invalid = validation.validateCalendarComposeForm(validFields({ attendeesRaw: 'not-an-email' }));
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.attendees);

  const valid = validation.validateCalendarComposeForm(validFields({ attendeesRaw: 'a@example.com, b@example.com' }));
  assert.equal(valid.valid, true);
  assert.deepEqual(Array.from(valid.attendees), ['a@example.com', 'b@example.com']);
});

test('attendees are optional — an empty field is valid', () => {
  const result = validation.validateCalendarComposeForm(validFields({ attendeesRaw: '' }));
  assert.equal(result.valid, true);
  assert.deepEqual(Array.from(result.attendees), []);
});

test('startDate is returned as a real Date for a valid start, and null when invalid', () => {
  const ok = validation.validateCalendarComposeForm(validFields());
  // ok.startDate is a Date constructed in the vm sandbox's own realm, so
  // `instanceof Date` against this file's (host-realm) Date would fail on
  // prototype identity, not content — duck-type it instead.
  assert.equal(typeof ok.startDate?.getTime, 'function');
  assert.equal(ok.startDate!.getHours(), 14);

  const bad = validation.validateCalendarComposeForm(validFields({ start: '' }));
  assert.equal(bad.startDate, null);
});

test('isValidTimezone / parseAttendees are exposed and consistent with the form validator', () => {
  assert.equal(validation.isValidTimezone('America/Los_Angeles'), true);
  assert.equal(validation.isValidTimezone('Not/AZone'), false);
  assert.deepEqual(Array.from(validation.parseAttendees(' a@example.com ,b@example.com,, ')), ['a@example.com', 'b@example.com']);
});
