// NAgex Calendar Approval View — pure presentation logic for the approval-gated
// Google Calendar execution card. No DOM access here: this module only turns
// an ActionApprovalRecord (from POST/GET /api/v1/approvals...) and execution
// results into plain view-model data, so it can run unmodified in the browser
// and under Node tests (see public/plan-resolution-view.js for the same
// pattern already used for plan resolution).
(function () {
  'use strict';

  var STATUS_LABEL = {
    PENDING: 'Pending approval',
    APPROVED: 'Approved',
    REJECTED: 'Rejected',
    EXPIRED: 'Approval expired',
    CONSUMED: 'Calendar event created',
  };

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  // Payload start/end are local wall-clock strings like "2026-09-07T14:00:00"
  // (see CalendarEventPayload) — split without re-parsing as a Date so the
  // displayed date/time never drifts from the exact canonicalPayload.
  function splitDateTime(value) {
    var match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(String(value || ''));
    if (!match) return { date: String(value || ''), time: '' };
    return { date: match[1], time: match[2] };
  }

  // Renders the exact frozen fields a human approver needs to see: title,
  // description, date, start time, end time, timezone, calendar, attendees.
  // Takes the canonicalPayload as returned by the approval API — never a
  // locally-reconstructed payload — so what is displayed is what will execute.
  function buildPayloadFields(canonicalPayload) {
    var payload = canonicalPayload || {};
    var start = splitDateTime(payload.start);
    var end = splitDateTime(payload.end);
    return {
      title: payload.summary || '',
      description: payload.description || '',
      date: start.date,
      startTime: start.time,
      endTime: end.time,
      timezone: payload.timezone || '',
      calendar: payload.calendarId || '',
      attendees: Array.isArray(payload.attendees) ? payload.attendees.slice() : [],
    };
  }

  function isExpired(expiresAt, nowMs) {
    var now = typeof nowMs === 'number' ? nowMs : Date.now();
    return new Date(expiresAt).getTime() <= now;
  }

  function formatCountdown(msRemaining) {
    if (msRemaining <= 0) return 'Expired';
    var totalSeconds = Math.floor(msRemaining / 1000);
    var minutes = Math.floor(totalSeconds / 60);
    var seconds = totalSeconds % 60;
    return minutes + ':' + pad(seconds) + ' remaining';
  }

  // Approval status as reported by the server can lag a client-side clock by
  // up to one poll interval, so a PENDING approval past its expiresAt is
  // treated as EXPIRED here even before the server confirms it — buttons must
  // fail closed on the client the instant the deadline passes, not only after
  // a round trip.
  function effectiveStatus(approval, nowMs) {
    if (approval.status === 'PENDING' && isExpired(approval.expiresAt, nowMs)) return 'EXPIRED';
    return approval.status;
  }

  function buildCardViewModel(approval, nowMs) {
    var status = effectiveStatus(approval, nowMs);
    var isPending = status === 'PENDING';
    return {
      fields: buildPayloadFields(approval.canonicalPayload),
      status: status,
      statusLabel: STATUS_LABEL[status] || status,
      approveDisabled: !isPending,
      rejectDisabled: !isPending,
      countdownLabel: isPending ? formatCountdown(new Date(approval.expiresAt).getTime() - (typeof nowMs === 'number' ? nowMs : Date.now())) : null,
    };
  }

  function buildSuccessViewModel(canonicalPayload, executionResult) {
    var fields = buildPayloadFields(canonicalPayload);
    return {
      title: fields.title,
      date: fields.date,
      startTime: fields.startTime,
      endTime: fields.endTime,
      timezone: fields.timezone,
      executionId: executionResult.executionId,
      externalUrl: executionResult.externalUrl,
    };
  }

  // Maps a known NagexError code from the approve/execute endpoints to the
  // exact user-facing message required for that failure mode. Returns null
  // for anything else so the caller can fall back to the server's own
  // message rather than inventing text for an unrecognized code.
  function describeExecutionError(errorCode) {
    if (errorCode === 'APPROVAL_ALREADY_CONSUMED') return 'This approval has already been used.';
    if (errorCode === 'APPROVAL_EXPIRED') return 'Approval expired';
    if (errorCode === 'APPROVAL_NOT_GRANTED') return 'This action has not been approved yet.';
    if (errorCode === 'APPROVAL_NOT_PENDING') return 'This approval can no longer be acted on.';
    if (errorCode === 'APPROVAL_PAYLOAD_MISMATCH') return 'The event details changed after approval. Please request approval again.';
    return null;
  }

  var api = {
    STATUS_LABEL: STATUS_LABEL,
    buildPayloadFields: buildPayloadFields,
    isExpired: isExpired,
    formatCountdown: formatCountdown,
    buildCardViewModel: buildCardViewModel,
    buildSuccessViewModel: buildSuccessViewModel,
    describeExecutionError: describeExecutionError,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.NAGEX_CALENDAR_APPROVAL_VIEW = api;
  }
})();
