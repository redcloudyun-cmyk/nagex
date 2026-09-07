// NAgex Gmail Approval View — pure presentation logic for the approval-gated
// Gmail execution card (send/reply/create_draft). No DOM access here: this
// module only turns an ActionApprovalRecord (from POST/GET /api/v1/approvals)
// and execution results into plain view-model data, so it can run unmodified
// in the browser and under Node tests — mirrors calendar-approval-view.js,
// the same pattern already proven for Google Calendar.
//
// Wiring this view model into the ambient composer (a Gmail equivalent of
// calendar-intent-extraction.js + the calendar compose form) is not part of
// this module and is not yet implemented — see MASTER.md Section 8: a
// partial integration must never be presented as done.
(function () {
  'use strict';

  var STATUS_LABEL = {
    PENDING: 'Pending approval',
    APPROVED: 'Approved',
    REJECTED: 'Rejected',
    EXPIRED: 'Approval expired',
    CONSUMED: 'Email sent',
  };

  var CONSUMED_LABEL_BY_TOOL = {
    'gmail.send_email': 'Email sent',
    'gmail.reply': 'Reply sent',
    'gmail.create_draft': 'Draft created',
  };

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  // Renders the exact frozen fields a human approver needs to see: from, to,
  // cc, bcc, subject, body, attachments metadata, and reply context. Takes
  // the canonicalPayload as returned by the approval API — never a
  // locally-reconstructed payload — so what is displayed is what will send.
  function buildPayloadFields(canonicalPayload) {
    var payload = canonicalPayload || {};
    return {
      from: payload.from || '',
      to: Array.isArray(payload.to) ? payload.to.slice() : [],
      cc: Array.isArray(payload.cc) ? payload.cc.slice() : [],
      bcc: Array.isArray(payload.bcc) ? payload.bcc.slice() : [],
      subject: payload.subject || '',
      body: payload.body || '',
      attachments: Array.isArray(payload.attachments) ? payload.attachments.slice() : [],
      threadId: payload.threadId || null,
      replyToMessageId: payload.replyToMessageId || null,
      isReply: Boolean(payload.threadId && payload.replyToMessageId),
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

  function statusLabelFor(approval, status) {
    if (status === 'CONSUMED') return CONSUMED_LABEL_BY_TOOL[approval.toolId] || STATUS_LABEL.CONSUMED;
    return STATUS_LABEL[status] || status;
  }

  function actionLabelFor(toolId) {
    if (toolId === 'gmail.create_draft') return 'Approve & Save Draft';
    if (toolId === 'gmail.reply') return 'Approve & Send Reply';
    return 'Approve & Send';
  }

  function buildCardViewModel(approval, nowMs) {
    var status = effectiveStatus(approval, nowMs);
    var isPending = status === 'PENDING';
    return {
      fields: buildPayloadFields(approval.canonicalPayload),
      status: status,
      statusLabel: statusLabelFor(approval, status),
      approveActionLabel: actionLabelFor(approval.toolId),
      approveDisabled: !isPending,
      rejectDisabled: !isPending,
      countdownLabel: isPending ? formatCountdown(new Date(approval.expiresAt).getTime() - (typeof nowMs === 'number' ? nowMs : Date.now())) : null,
    };
  }

  function buildSuccessViewModel(toolId, canonicalPayload, executionResult) {
    var fields = buildPayloadFields(canonicalPayload);
    return {
      toolId: toolId,
      to: fields.to,
      subject: fields.subject,
      executionId: executionResult.executionId,
      messageId: executionResult.externalId,
      threadId: executionResult.threadId || null,
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
    if (errorCode === 'APPROVAL_PAYLOAD_MISMATCH') return 'The email details changed after approval. Please request approval again.';
    if (errorCode === 'APPROVAL_TOOL_MISMATCH') return 'This approval does not match this action.';
    if (errorCode === 'GMAIL_DISCONNECTED') return 'Gmail is not connected.';
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
    window.NAGEX_GMAIL_APPROVAL_VIEW = api;
  }
})();
