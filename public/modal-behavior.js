// NAgex Modal Dismiss Behavior — pure, DOM-independent helpers backing the
// Ambient Assistant / Plan Preview modal's close semantics. Kept free of any
// DOM access (no `document`/`window` reads) so the logic can be unit tested
// directly, the same rationale as public/plan-resolution-view.js.
(function () {
  'use strict';

  // Given the modal's focusable elements (in DOM order), the currently
  // focused element, and whether Shift is held, returns which element a Tab
  // keypress should move focus to in order to trap focus inside the modal —
  // or null when the browser's default Tab behavior already keeps focus
  // inside (no wrap-around needed).
  function computeFocusTrapTarget(focusableElements, activeElement, shiftKey) {
    if (!focusableElements || focusableElements.length === 0) return null;
    var first = focusableElements[0];
    var last = focusableElements[focusableElements.length - 1];
    if (shiftKey && activeElement === first) return last;
    if (!shiftKey && activeElement === last) return first;
    return null;
  }

  // A tiny state machine for "lock body scroll while the modal is open,
  // always restore the exact prior value on close" — safe to call lock()
  // or unlock() redundantly, since the modal can be closed from more than
  // one path (X button, Escape, backdrop click, footer Close button) and
  // must still restore scrolling exactly once, with the original value.
  function createScrollLock() {
    var priorValue = null;
    var locked = false;
    return {
      lock: function (currentValue) {
        if (locked) return;
        priorValue = currentValue;
        locked = true;
      },
      // Returns the value the caller should restore the locked property to,
      // or null when there was nothing to restore (already unlocked, or
      // never locked) — callers must treat a null return as "do nothing".
      unlock: function () {
        if (!locked) return null;
        locked = false;
        var restore = priorValue;
        priorValue = null;
        return restore;
      },
      isLocked: function () {
        return locked;
      },
    };
  }

  // True only for a click whose target is exactly the backdrop element
  // itself — a click that started or landed on anything inside the modal
  // (which is a descendant of the backdrop) must never close it.
  function isBackdropSelfClick(eventTarget, backdropElement) {
    return eventTarget === backdropElement;
  }

  var api = {
    computeFocusTrapTarget: computeFocusTrapTarget,
    createScrollLock: createScrollLock,
    isBackdropSelfClick: isBackdropSelfClick,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.NAGEX_MODAL_BEHAVIOR = api;
  }
})();
