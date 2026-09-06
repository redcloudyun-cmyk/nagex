// NAgex Timeline Dedupe — a tiny, DOM-independent guard so the same activity
// timeline lifecycle event (e.g. "Plan created") is never logged twice for
// the same plan/approval identity, while every legitimately distinct event
// (a different label, or the same label for a different id) still gets
// through untouched. Kept free of DOM access so it is directly unit
// testable, the same rationale as public/modal-behavior.js.
(function () {
  'use strict';

  function createDeduper() {
    var seen = new Set();
    return {
      // Returns true the first time this (label, id) pair is seen, and
      // false on every later call with the same pair — the caller should
      // only append/log an entry when this returns true. A falsy id always
      // returns true (there is nothing to dedupe against), so a caller with
      // no stable identity available never silently loses an event.
      shouldLog: function (label, id) {
        if (!id) return true;
        var key = String(label) + '::' + String(id);
        if (seen.has(key)) return false;
        seen.add(key);
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
