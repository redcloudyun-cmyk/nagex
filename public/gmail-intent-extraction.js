// NAgex Gmail Intent Extraction — deterministic, non-LLM parsing of simple
// natural-language email requests into a GmailComposePayload-shaped hint
// object, mirroring calendar-intent-extraction.js's approach and limits.
//
// This never invents a recipient's email address, a subject, or body text
// that is not literally present in the prompt. A bare name ("John", "Sarah")
// is surfaced only as `recipientNameHint` — informational text shown next to
// the (deliberately blank, required) To field — never placed into `to`
// itself. If extraction cannot confidently fill a field, it is left null so
// renderGmailComposeForm (app.js) shows it blank and the user must supply it
// before "Preview & Request Approval" can be submitted — this is how an
// ambiguous recipient is "asked about": the form simply requires it.
(function () {
  'use strict';

  function extractEmails(text) {
    var matches = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
    return matches ? Array.from(new Set(matches)) : [];
  }

  // "cc: a@b.com, c@d.com" / "cc a@b.com" — only ever pulls literal addresses
  // that follow an explicit cc/bcc marker, never a guess at who else to include.
  function extractMarkedEmails(text, marker) {
    var re = new RegExp('\\b' + marker + '\\s*:?\\s*([a-zA-Z0-9._%+\\-,\\s@]+\\.[a-zA-Z]{2,}[a-zA-Z0-9._%+\\-,\\s@]*)', 'i');
    var match = re.exec(text);
    if (!match) return [];
    return extractEmails(match[1]);
  }

  // A bare name the message addresses ("Email John ...", "Reply to Sarah ...")
  // — kept only as a hint for the human filling in the real address, never
  // used as the address itself.
  // NOTE: none of these patterns use the /i flag — only the leading trigger
  // word's case varies in practice (sentence-initial "Email"/"Reply"/
  // "Draft"), handled explicitly below via [Ee]/[Rr]/[Dd]. The capture
  // group's [A-Z] must stay genuinely case-sensitive: it is the actual
  // "looks like a proper name" signal that keeps this from mistaking an
  // ordinary lowercase word ("him", "them", "the") for a name.
  function extractRecipientNameHint(text) {
    var toPattern = /\b[Ee]mail\s+([A-Z][a-zA-Z'-]*)\b/.exec(text);
    if (toPattern) return toPattern[1];
    var replyPattern = /\b[Rr]eply\s+to\s+([A-Z][a-zA-Z'-]*)\b/.exec(text);
    if (replyPattern) return replyPattern[1];
    var draftPattern = /\b[Dd]raft\s+(?:an?\s+)?email\s+to\s+(?:the\s+)?([A-Z][a-zA-Z'-]*)\b/.exec(text);
    if (draftPattern && draftPattern[1].toLowerCase() !== 'client' && draftPattern[1].toLowerCase() !== 'team') return draftPattern[1];
    return null;
  }

  function extractSubject(text) {
    var explicit = /\bsubject\s*:\s*['"]?([^'".\n]+)['"]?/i.exec(text);
    if (explicit) return explicit[1].trim();
    var titled = /\btitled\s+['"]([^'"]+)['"]/i.exec(text);
    if (titled) return titled[1].trim();
    return null;
  }

  // Conservative clause extraction: only ever a literal substring of the
  // prompt following one of a small set of explicit signal phrases — never a
  // paraphrase or invented sentence. Returns null (never a fabricated body)
  // when no such phrase is present.
  function extractBody(text) {
    var patterns = [
      /\bthat\s+(.+?)[.!?]*$/i,
      /\btelling\s+(?:her|him|them)\s+(?:that\s+)?(.+?)[.!?]*$/i,
      /\btell\s+(?:her|him|them)\s+(?:that\s+)?(.+?)[.!?]*$/i,
      /\bsaying\s+(.+?)[.!?]*$/i,
      /\bsummarizing\s+(.+?)[.!?]*$/i,
    ];
    for (var i = 0; i < patterns.length; i++) {
      var match = patterns[i].exec(text);
      if (match && match[1].trim()) return match[1].trim();
    }
    return null;
  }

  function detectIntentKind(text) {
    if (/\breply\b/i.test(text)) return 'reply';
    if (/\bdraft\b/i.test(text)) return 'create_draft';
    if (/\bfind\b.*\bemails?\b|\bsearch\b.*\bemails?\b/i.test(text)) return 'search';
    if (/\b(latest|show me).*\bthread\b|\bread\b.*\bthread\b/i.test(text)) return 'read_thread';
    if (/\bemail\b/i.test(text)) return 'send_email';
    return null;
  }

  // Returns { kind, to, cc, bcc, subject, body, recipientNameHint, searchQuery }
  // — `kind` is one of 'send_email' | 'reply' | 'create_draft' | 'search' |
  // 'read_thread' | null (prompt does not look like a Gmail request at all).
  function extractGmailIntent(prompt) {
    var text = String(prompt || '');
    var kind = detectIntentKind(text);
    if (!kind) return null;

    var cc = extractMarkedEmails(text, 'cc');
    var bcc = extractMarkedEmails(text, 'bcc');
    var allEmails = extractEmails(text);
    // "to" is only ever a literal address not already claimed by an explicit
    // cc/bcc marker — still never a guess, just excluding an address that
    // was clearly meant for a different field.
    var to = allEmails.filter(function (email) { return cc.indexOf(email) === -1 && bcc.indexOf(email) === -1; });

    return {
      kind: kind,
      to: to,
      cc: cc,
      bcc: bcc,
      subject: extractSubject(text),
      body: extractBody(text),
      recipientNameHint: extractRecipientNameHint(text),
      searchQuery: kind === 'search' ? text.replace(/^(find|search)\b/i, '').replace(/\bemails?\b/i, '').replace(/\bfrom\b/i, '').trim() : null,
    };
  }

  var api = {
    extractGmailIntent: extractGmailIntent,
    extractEmails: extractEmails,
    extractMarkedEmails: extractMarkedEmails,
    extractRecipientNameHint: extractRecipientNameHint,
    extractSubject: extractSubject,
    extractBody: extractBody,
    detectIntentKind: detectIntentKind,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.NAGEX_GMAIL_INTENT = api;
  }
})();
