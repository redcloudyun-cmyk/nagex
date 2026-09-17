// R12.1 Increment 1 — NAgex Intent Interaction State: the canonical,
// reusable PRESENTATION state contract for "Request -> Clarification? ->
// Working -> Review/Approval? -> Done", shared by any surface that drives
// the universal intent composer (Home, Ambient overlay, and any future
// Inbox/Activity entry point).
//
// This module owns none of the truth it renders. It maps backend-owned
// signals (plan status, approval status, execution outcome) into ONE of
// eight small presentation states — it never invents, stores, or mutates
// canonical Task/Plan/Approval state itself. No DOM access here, mirroring
// plan-resolution-view.js / the *-approval-view.js files, so it runs
// unmodified in the browser and under Node tests.
(function () {
  'use strict';

  // §17 — presentation states only. Internal concepts (Planner, Critic,
  // Router, Tool Selection, Capability Broker, Model Router) never become
  // states here; they may only ever appear as progressive-disclosure detail.
  var INTENT_STATE = {
    IDLE: 'IDLE',
    SUBMITTING: 'SUBMITTING',
    CLARIFICATION_REQUIRED: 'CLARIFICATION_REQUIRED',
    WORKING: 'WORKING',
    REVIEW_REQUIRED: 'REVIEW_REQUIRED',
    APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
    COMPLETED: 'COMPLETED',
    FAILED: 'FAILED',
  };

  // §3 — intent certainty model. Internal/debug-detail concept only; never
  // shown to ordinary users as a raw label.
  var INTENT_CERTAINTY = {
    CONFIRMED: 'CONFIRMED',
    INFERRED: 'INFERRED',
    ASSUMED: 'ASSUMED',
    UNKNOWN: 'UNKNOWN',
  };

  // §9 — each state has exactly one primary next action (an i18n key, not
  // literal text — the caller resolves it through the real t() function).
  // A state with no primary action (WORKING, COMPLETED, FAILED) maps to
  // null, never a fabricated "Continue"/"OK" button.
  var PRIMARY_ACTION_KEY = {
    IDLE: null,
    SUBMITTING: null,
    CLARIFICATION_REQUIRED: 'intent.action.answer',
    WORKING: null,
    REVIEW_REQUIRED: 'intent.action.reviewPlan',
    APPROVAL_REQUIRED: null, // consequence-specific — resolved by the caller (§7), never generic
    COMPLETED: 'intent.action.openResult',
    FAILED: 'intent.action.retry',
  };

  function primaryActionKey(state) {
    return Object.prototype.hasOwnProperty.call(PRIMARY_ACTION_KEY, state) ? PRIMARY_ACTION_KEY[state] : null;
  }

  // States in which no canonical mutation may ever occur. Used as a
  // structural invariant, not just documentation — §5 "no mutation occurs
  // during clarification", §7 "plan acceptance != action approval".
  var NON_MUTATING_STATES = [
    INTENT_STATE.IDLE,
    INTENT_STATE.SUBMITTING,
    INTENT_STATE.CLARIFICATION_REQUIRED,
    INTENT_STATE.WORKING,
    INTENT_STATE.REVIEW_REQUIRED,
  ];

  function isMutationAuthorized(state) {
    // Only an explicit, granted APPROVAL_REQUIRED->consumed transition (a
    // canonical backend fact, never this module's own state) authorizes a
    // provider mutation. REVIEW_REQUIRED (plan review) never does, even
    // though it sits directly before APPROVAL_REQUIRED in the flow.
    return NON_MUTATING_STATES.indexOf(state) === -1 && state !== INTENT_STATE.COMPLETED && state !== INTENT_STATE.FAILED;
  }

  // Pure mapper: backend truth -> one presentation state. Every input flag
  // is something the real backend already tells the caller (a pending
  // clarification question, a submitting flag the caller itself is
  // tracking, a resolved plan's status, an approval's status, a real
  // execution result/error) — this function never fabricates a signal.
  //
  //   input.isSubmitting        boolean — a request is in flight, no
  //                              server response received yet
  //   input.clarificationQuestion string|null — a real pending question
  //                              from the backend (never invented client-
  //                              side; R12.1 Increment 1 does not add new
  //                              backend clarification logic, so this is
  //                              normally null today — see module header)
  //   input.planStatus          'EXECUTION_READY'|'APPROVAL_REQUIRED'|
  //                              'BLOCKED'|null — from resolvePlanIntoUi's
  //                              real ResolvedPlan
  //   input.approvalStatus      'PENDING'|'APPROVED'|'REJECTED'|'EXPIRED'|
  //                              'CONSUMED'|null — from a real
  //                              ActionApprovalRecord
  //   input.executionSucceeded  boolean|null — true only after a real,
  //                              canonical execution response confirms
  //                              success; never inferred
  //   input.hasError            boolean — a real, surfaced error occurred
  function deriveInteractionState(input) {
    var i = input || {};
    if (i.hasError) return INTENT_STATE.FAILED;
    if (i.executionSucceeded === true) return INTENT_STATE.COMPLETED;
    if (i.approvalStatus === 'PENDING') return INTENT_STATE.APPROVAL_REQUIRED;
    if (i.clarificationQuestion) return INTENT_STATE.CLARIFICATION_REQUIRED;
    if (i.planStatus === 'EXECUTION_READY' || i.planStatus === 'APPROVAL_REQUIRED' || i.planStatus === 'BLOCKED') return INTENT_STATE.REVIEW_REQUIRED;
    if (i.isSubmitting) return INTENT_STATE.SUBMITTING;
    return INTENT_STATE.IDLE;
  }

  var api = {
    INTENT_STATE: INTENT_STATE,
    INTENT_CERTAINTY: INTENT_CERTAINTY,
    PRIMARY_ACTION_KEY: PRIMARY_ACTION_KEY,
    primaryActionKey: primaryActionKey,
    isMutationAuthorized: isMutationAuthorized,
    deriveInteractionState: deriveInteractionState,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.NAGEX_INTENT_STATE = api;
  }
})();
