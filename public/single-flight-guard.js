// NAgex Single-Flight Guard — a tiny, DOM-independent re-entrancy guard.
// Root cause of the duplicate "Plan created" activity timeline event: two
// separate calls into the plan-generation pipeline (e.g. the composer's
// Enter/Send and the ambient overlay's own demo "Run" affordance, or any
// other trigger) each legitimately mint their own requestId, so the
// timeline's per-plan dedupe (see timeline-dedupe.js) correctly does NOT
// merge them — they really are two different plan generations. The actual
// fix is to stop a second generation from starting at all while one is
// still in flight, regardless of which UI control tried to start it.
(function () {
  'use strict';

  function createSingleFlightGuard() {
    var busy = false;
    return {
      // Returns true and marks the guard busy if nothing was already in
      // flight; returns false (and leaves state untouched) if something
      // was already running — the caller must not proceed in that case.
      tryEnter: function () {
        if (busy) return false;
        busy = true;
        return true;
      },
      exit: function () {
        busy = false;
      },
      isBusy: function () {
        return busy;
      },
    };
  }

  var api = { createSingleFlightGuard: createSingleFlightGuard };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.NAGEX_SINGLE_FLIGHT = api;
  }
})();
