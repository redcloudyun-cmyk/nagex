// NAgex Calendar Payload Validation — pure, DOM-independent checks the
// calendar compose form runs before allowing "Preview & Request Approval".
// This is a fast client-side pre-check so the user sees a mistake
// immediately; it deliberately mirrors (but does not replace) the server's
// own assertValidPayload in google-calendar.service.ts, which remains the
// authoritative, fail-closed check.
(function () {
  'use strict';

  var EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function isValidTimezone(timezone) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone });
      return true;
    } catch (e) {
      return false;
    }
  }

  function parseAttendees(raw) {
    return String(raw || '')
      .split(',')
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length > 0; });
  }

  // fields: { title, start (a datetime-local-style string, e.g.
  // "2026-09-07T14:00"), durationMinutes, timezone, attendeesRaw }.
  // Returns { valid, errors, attendees, startDate } — errors is a map of
  // field name to a human-readable message; the caller must not submit
  // while any error is present. Never mutates or invents a value: a field
  // left blank produces a "required" error rather than a fallback value.
  function validateCalendarComposeForm(fields) {
    fields = fields || {};
    var errors = {};

    var title = String(fields.title || '').trim();
    if (!title) errors.title = 'A title is required.';

    var startRaw = String(fields.start || '').trim();
    var startDate = startRaw ? new Date(startRaw) : null;
    if (!startRaw || !startDate || Number.isNaN(startDate.getTime())) {
      errors.start = 'A valid start date and time is required.';
      startDate = null;
    }

    var duration = Number(fields.durationMinutes);
    if (!Number.isFinite(duration) || duration <= 0) {
      errors.duration = 'Duration must be greater than 0 minutes.';
    }

    if (!fields.timezone || !isValidTimezone(fields.timezone)) {
      errors.timezone = 'A valid timezone is required.';
    }

    var attendees = parseAttendees(fields.attendeesRaw);
    var invalidAttendees = attendees.filter(function (email) { return !EMAIL_PATTERN.test(email); });
    if (invalidAttendees.length > 0) {
      errors.attendees = 'Invalid attendee email' + (invalidAttendees.length > 1 ? 's' : '') + ': ' + invalidAttendees.join(', ');
    }

    return {
      valid: Object.keys(errors).length === 0,
      errors: errors,
      attendees: attendees,
      startDate: startDate,
    };
  }

  var api = {
    isValidTimezone: isValidTimezone,
    parseAttendees: parseAttendees,
    validateCalendarComposeForm: validateCalendarComposeForm,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.NAGEX_CALENDAR_VALIDATION = api;
  }
})();
