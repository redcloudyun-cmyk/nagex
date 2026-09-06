// NAgex Calendar Intent Extraction — deterministic, non-LLM parsing of simple
// natural-language scheduling requests ("Schedule a meeting tomorrow at 2 PM
// for 30 minutes titled X") into a CalendarEventPayload-shaped object.
//
// This is intentionally NOT delegated to the planning model: exact date/time
// arithmetic is easy to get subtly wrong from an LLM and hard to test
// deterministically. Extraction only ever succeeds when the prompt clearly
// states a day, a time, and a title; otherwise it returns null so the caller
// falls back to asking the user directly (see renderCalendarComposeForm in
// app.js). Attendees are only ever taken from an email address literally
// present in the prompt — this module never invents attendees.
(function () {
  'use strict';

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  function extractTitle(prompt) {
    var quoted = /titled\s+['"]([^'"]+)['"]/i.exec(prompt);
    if (quoted) return quoted[1].trim();
    var bare = /titled\s+(.+?)[.!?]*$/i.exec(prompt);
    if (bare) return bare[1].trim();
    return null;
  }

  function extractDurationMinutes(prompt) {
    var match = /for\s+(\d+)\s*(hour|hr|minute|min)s?\b/i.exec(prompt);
    if (!match) return null;
    var amount = Number(match[1]);
    var unit = match[2].toLowerCase();
    return unit.charAt(0) === 'h' ? amount * 60 : amount;
  }

  function extractTimeOfDay(prompt) {
    var meridiem = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(prompt);
    if (meridiem) {
      var hour = Number(meridiem[1]) % 12;
      var minute = meridiem[2] ? Number(meridiem[2]) : 0;
      if (meridiem[3].toLowerCase() === 'pm') hour += 12;
      return { hour: hour, minute: minute };
    }
    var twentyFour = /\b([01]?\d|2[0-3]):([0-5]\d)\b/.exec(prompt);
    if (twentyFour) return { hour: Number(twentyFour[1]), minute: Number(twentyFour[2]) };
    return null;
  }

  function extractDayOffset(prompt) {
    if (/\btomorrow\b/i.test(prompt)) return 1;
    if (/\btoday\b/i.test(prompt)) return 0;
    return null;
  }

  // Only ever returns email addresses that literally appear in the prompt —
  // never a guessed or inferred attendee.
  function extractAttendees(prompt) {
    var matches = prompt.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
    return matches ? Array.from(new Set(matches)) : [];
  }

  function formatLocal(date) {
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + 'T' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':00';
  }

  // Returns a CalendarEventPayload-shaped object, or null when the prompt
  // does not unambiguously specify a day, a time, and a title. `referenceDate`
  // is the "now" the day offset ("today"/"tomorrow") is computed against;
  // `timezone` should be the user's configured/resolved IANA timezone.
  function extractCalendarIntent(prompt, referenceDate, timezone) {
    var text = String(prompt || '');
    var dayOffset = extractDayOffset(text);
    var time = extractTimeOfDay(text);
    var title = extractTitle(text);
    if (dayOffset === null || !time || !title) return null;

    var durationMinutes = extractDurationMinutes(text) || 30;
    var start = new Date(referenceDate.getTime());
    start.setDate(start.getDate() + dayOffset);
    start.setHours(time.hour, time.minute, 0, 0);
    var end = new Date(start.getTime() + durationMinutes * 60000);

    return {
      calendarId: 'primary',
      summary: title,
      description: '',
      start: formatLocal(start),
      end: formatLocal(end),
      timezone: timezone,
      attendees: extractAttendees(text),
      conferenceData: false,
    };
  }

  var api = {
    extractCalendarIntent: extractCalendarIntent,
    extractTitle: extractTitle,
    extractDurationMinutes: extractDurationMinutes,
    extractTimeOfDay: extractTimeOfDay,
    extractDayOffset: extractDayOffset,
    extractAttendees: extractAttendees,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.NAGEX_CALENDAR_INTENT = api;
  }
})();
