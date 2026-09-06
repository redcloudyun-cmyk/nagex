// NAgex Timeline Dedupe — a tiny, DOM-independent guard so the same activity
// timeline lifecycle event is never logged twice for the same plan/approval/
// execution identity, while every legitimately distinct event (a different
// label, or the same label for a different id) still gets through
// untouched. Kept free of DOM access so it is directly unit testable, the
// same rationale as public/modal-behavior.js.
//
// Callers pass a single, fully-formed canonical lifecycle key — never a
// timestamp — built as "<kind>:<id>:<stage>", e.g.:
//   plan:{planId}:created
//   plan:{planId}:resolved
//   approval:{approvalId}:requested
//   approval:{approvalId}:approved
//   execution:{executionId}:started
//   execution:{executionId}:succeeded
// This makes the identity being deduped against explicit and greppable at
// every call site, rather than reconstructed internally from separate
// label/id arguments.
(function () {
  'use strict';

  function createDeduper() {
    var seen = new Set();
    return {
      // Returns true the first time this lifecycle key is seen, and false
      // on every later call with the same key — the caller should only
      // append/log an entry when this returns true. A falsy key always
      // returns true (there is nothing to dedupe against), so a caller
      // with no stable identity available never silently loses an event.
      shouldLog: function (lifecycleKey) {
        if (!lifecycleKey) return true;
        if (seen.has(lifecycleKey)) return false;
        seen.add(lifecycleKey);
        return true;
      },
      reset: function () {
        seen = new Set();
      },
    };
  }

  var api = { createDeduper: createDeduper };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.NAGEX_TIMELINE_DEDUPE = api;
  }
})();
