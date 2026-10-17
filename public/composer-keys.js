// NAgex composer keys - the ONE definition of "this Enter sends" and "this Enter only confirms an IME composition", shared by every reachable message box (Main, the ambient bar, Canvas Ask,
// Quick Wake). Before this, only Main knew about IME composition; the others sent on the Enter that merely confirms a Korean/Japanese/Chinese syllable, i.e. a truncated message.
//
// An Enter is "confirming a composition" when ANY of these says so (browsers disagree about which they report):
//   - event.isComposing                     (Chrome, Firefox: the confirming keydown carries it)
//   - the element is between compositionstart and compositionend (the flag below)
//   - event.keyCode === 229                 (the IME-processing code; Safari reports it on the keydown that FOLLOWS compositionend)
//   - compositionend fired a moment ago     (Safari order: compositionend first, then the confirming Enter)
// The flag cannot get stuck: it is also cleared when the element loses focus and when a non-composing input event arrives (a composition whose end was never reported).
(function () {
  'use strict';

  var JUST_ENDED_MS = 80;

  function watchComposition(element, now) {
    var clock = typeof now === 'function' ? now : Date.now;
    var active = false;
    var endedAt = -Infinity;
    if (element && typeof element.addEventListener === 'function') {
      element.addEventListener('compositionstart', function () { active = true; });
      element.addEventListener('compositionend', function () { active = false; endedAt = clock(); });
      element.addEventListener('blur', function () { active = false; });
      element.addEventListener('input', function (event) {
        if (event && event.isComposing === false) active = false;
      });
    }
    return {
      isActive: function () { return active; },
      endedWithin: function (ms) { return clock() - endedAt < ms; },
    };
  }

  /** True when this keydown is the key that confirms (or is part of) an IME composition - it must never send. */
  function confirmsComposition(event, watcher) {
    if (!event) return false;
    if (event.isComposing === true || event.keyCode === 229) return true;
    return !!watcher && (watcher.isActive() || watcher.endedWithin(JUST_ENDED_MS));
  }

  /** A plain Enter (Ctrl/Cmd+Enter included) that is not an IME confirmation. Shift/Alt+Enter is a new line (or nothing, in a one-line field). */
  function isSubmitEnter(event, watcher) {
    if (!event || event.key !== 'Enter') return false;
    if (event.shiftKey || event.altKey) return false;
    return !confirmsComposition(event, watcher);
  }

  /** Grows a multi-line box to fit its lines, up to maxPx (default 160); past that the text scrolls inside the box (the stylesheet sets overflow-y:auto and box-sizing:border-box). */
  function autoGrow(element, maxPx) {
    if (!element || !element.style) return;
    var limit = typeof maxPx === 'number' && maxPx > 0 ? maxPx : 160;
    element.style.height = 'auto';
    element.style.height = Math.min(element.scrollHeight, limit) + 'px';
  }

  var api = { watchComposition: watchComposition, confirmsComposition: confirmsComposition, isSubmitEnter: isSubmitEnter, autoGrow: autoGrow, JUST_ENDED_MS: JUST_ENDED_MS };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.NAGEX_COMPOSER_KEYS = api;
  }
})();
