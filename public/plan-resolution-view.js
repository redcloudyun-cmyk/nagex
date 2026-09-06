// NAgex Plan Resolution View — pure presentation logic for the resolved plan UI.
// No DOM access here: this module only turns a ResolvedPlan (from POST /api/v1/plans/resolve)
// into plain view-model data, so it can run unmodified in the browser and under Node tests.
(function () {
  'use strict';

  var STATUS_META = {
    EXECUTION_READY: { label: 'Ready to Run', cssClass: 'plan-status-ready', actionLabel: 'Ready to Run' },
    APPROVAL_REQUIRED: { label: 'Review & Approve', cssClass: 'plan-status-approval', actionLabel: 'Review & Approve' },
    BLOCKED: { label: 'Cannot Execute', cssClass: 'plan-status-blocked', actionLabel: null },
  };

  function describeStatus(status) {
    return STATUS_META[status] || { label: status || 'Unknown', cssClass: 'plan-status-unknown', actionLabel: null };
  }

  function shouldShowRunButton(status) {
    return status === 'EXECUTION_READY' || status === 'APPROVAL_REQUIRED';
  }

  function collectWarnings(resolvedPlan) {
    // resolvedPlan.warnings is a deduplicated rollup of every step's own warnings
    // (see PlanResolver), so listing both would double-report the same message.
    // Per-step warnings carry the step title as context, so they are the ones we show.
    if (!resolvedPlan) return [];
    var warnings = [];
    (resolvedPlan.steps || []).forEach(function (step) {
      (step.warnings || []).forEach(function (message) {
        warnings.push({ stepTitle: step.title || null, message: message });
      });
    });
    return warnings;
  }

  function summarizeStep(step) {
    var meta = describeStatus(step.executionReadiness);
    return {
      title: step.title,
      resolvedSkillId: step.resolvedSkillId,
      resolvedToolId: step.resolvedToolId,
      toolAvailability: step.toolAvailability,
      approvalRequired: !!step.approvalRequired,
      executionReadiness: step.executionReadiness,
      statusLabel: meta.label,
      statusCssClass: meta.cssClass,
      warnings: step.warnings || [],
    };
  }

  function buildResolutionViewModel(resolvedPlan) {
    var meta = describeStatus(resolvedPlan ? resolvedPlan.status : null);
    return {
      status: resolvedPlan ? resolvedPlan.status : null,
      statusLabel: meta.label,
      statusCssClass: meta.cssClass,
      actionLabel: meta.actionLabel,
      showRunButton: shouldShowRunButton(resolvedPlan ? resolvedPlan.status : null),
      steps: (resolvedPlan && resolvedPlan.steps ? resolvedPlan.steps : []).map(summarizeStep),
      warnings: collectWarnings(resolvedPlan),
    };
  }

  var api = {
    STATUS_META: STATUS_META,
    describeStatus: describeStatus,
    shouldShowRunButton: shouldShowRunButton,
    collectWarnings: collectWarnings,
    summarizeStep: summarizeStep,
    buildResolutionViewModel: buildResolutionViewModel,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.NAGEX_PLAN_VIEW = api;
  }
})();
