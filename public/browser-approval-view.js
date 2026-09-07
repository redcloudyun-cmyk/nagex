// NAgex Browser Approval View — pure presentation logic for the
// approval-gated consequential browser click (browser.click when the
// resolved target is Submit/Buy/Pay/Delete/Publish/Confirm/...). No DOM
// access here — mirrors gmail-approval-view.js / calendar-approval-view.js's
// exact pattern: turn an ActionApprovalRecord + execution result into plain
// view-model data, runnable unmodified in the browser and under Node tests.
//
// Full ambient-composer wiring for this view (an interactive "here is what
// NAgex found on the page, here is the action it wants to take" flow) is
// not part of this module and is not yet built — a browser action is
// fundamentally multi-turn (navigate -> read the live page -> decide what
// to click), unlike Calendar/Gmail's single-shot compose-and-send forms,
// and building that multi-turn UI is explicitly out of this MVP's scope
// (see MASTER.md Section 14.5 item 06, "Do not overbuild yet"). This module
// exists so the pattern is proven and ready for that later, focused turn —
// see MASTER.md Section 8: a partial integration must never be presented as
// done.
(function () {
  'use strict';

  var STATUS_LABEL = {
    PENDING: 'Pending approval',
    APPROVED: 'Approved',
    REJECTED: 'Rejected',
    EXPIRED: 'Approval expired',
    CONSUMED: 'Action completed',
  };

  function buildPayloadFields(canonicalPayload) {
    var payload = canonicalPayload || {};
    return {
      targetText: payload.targetText || '',
      selector: payload.selector || '',
      url: payload.url || '',
      browserSessionId: payload.browserSessionId || '',
    };
  }

  function isExpired(expiresAt, nowMs) {
    var now = typeof nowMs === 'number' ? nowMs : Date.now();
    return new Date(expiresAt).getTime() <= now;
  }

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  function formatCountdown(msRemaining) {
    if (msRemaining <= 0) return 'Expired';
    var totalSeconds = Math.floor(msRemaining / 1000);
    var minutes = Math.floor(totalSeconds / 60);
    var seconds = totalSeconds % 60;
    return minutes + ':' + pad(seconds) + ' remaining';
  }

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
      targetText: fields.targetText,
      url: executionResult.url,
      title: executionResult.title,
      executionId: executionResult.executionId,
    };
  }

  function describeExecutionError(errorCode) {
    if (errorCode === 'APPROVAL_ALREADY_CONSUMED') return 'This approval has already been used.';
    if (errorCode === 'APPROVAL_EXPIRED') return 'Approval expired';
    if (errorCode === 'APPROVAL_NOT_GRANTED') return 'This action has not been approved yet.';
    if (errorCode === 'APPROVAL_NOT_PENDING') return 'This approval can no longer be acted on.';
    if (errorCode === 'APPROVAL_PAYLOAD_MISMATCH') return 'The page changed after approval. Please request approval again.';
    if (errorCode === 'BROWSER_SELECTOR_NOT_FOUND') return 'That element is no longer on the page.';
    if (errorCode === 'BROWSER_SELECTOR_AMBIGUOUS') return 'That target is no longer uniquely identifiable on the page.';
    if (errorCode === 'BROWSER_HUMAN_VERIFICATION_REQUIRED') return 'This page requires human verification (CAPTCHA/MFA). NAgex will not attempt to bypass it.';
    if (errorCode === 'BROWSER_UNAVAILABLE') return 'The browser runtime is not available.';
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
    window.NAGEX_BROWSER_APPROVAL_VIEW = api;
  }
})();
