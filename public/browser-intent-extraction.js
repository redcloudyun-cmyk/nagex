// NAgex Browser Intent Extraction — deterministic, non-LLM parsing of a
// literal URL out of a browser-shaped request, mirroring calendar-intent-
// extraction.js / gmail-intent-extraction.js's approach and limits exactly:
// never invents a destination. "Open the airline website" has no real URL
// in it at all, so this returns null rather than guessing one — the ambient
// UI then has to ask, exactly like a blank required Calendar/Gmail field.
(function () {
  'use strict';

  function detectsBrowserIntent(text) {
    return /\b(open|navigate|browse|check)\b.*\b(website|site|page|url|reservation|status)\b|https?:\/\//i.test(text);
  }

  // Only a literal http(s) URL already present in the prompt — never a
  // bare site name ("the airline website") resolved to a guessed domain.
  function extractUrl(text) {
    const match = /https?:\/\/[^\s'"<>]+/.exec(String(text || ''));
    return match ? match[0].replace(/[.,)]+$/, '') : null;
  }

  function extractBrowserIntent(prompt) {
    const text = String(prompt || '');
    if (!detectsBrowserIntent(text)) return null;
    return { url: extractUrl(text) };
  }

  var api = {
    detectsBrowserIntent: detectsBrowserIntent,
    extractUrl: extractUrl,
    extractBrowserIntent: extractBrowserIntent,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.NAGEX_BROWSER_INTENT = api;
  }
})();
