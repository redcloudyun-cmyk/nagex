// DC3-B2 Preflight — a mandatory finding, not an optional add-on: a
// legitimate, authorized UIA window enumeration incidentally surfaced a
// real credential value sitting in a window title on the operator's own
// desktop. This confirmed, for real, that UI Automation metadata
// (window/tab/document titles, control names, text values, tooltips,
// clipboard content) can carry secrets NAgex was never asked to observe
// as data, only as structure.
//
// The permanent rule this file exists to uphold: UIA observation is not
// permission to persist everything observed. "Observe only what is
// necessary. Persist only what is safe. Show only what is meaningful."
//
// Deliberately NOT a universal secret-detection system (out of scope,
// explicitly, for this slice) — a small, bounded, conservative set of
// known high-confidence secret SHAPES. False negatives on exotic secret
// formats are an accepted, disclosed limitation; false positives (over-
// redacting) are the safer failure mode and are tolerated.
export interface RedactionResult {
  redactedText: string;
  containedSecretLike: boolean;
}

// Each pattern is a real, publicly-documented secret prefix/shape — not
// guessed. Kept intentionally small; expand only with real evidence, the
// same "no premature abstraction" discipline the rest of this codebase
// already follows for allowlists (e.g. the click-consequence keyword
// table in browser.service.ts).
const SECRET_PATTERNS: RegExp[] = [
  /sk-(?:proj-)?[A-Za-z0-9_-]{16,}/g, // OpenAI-style API keys (the exact real shape that triggered this finding)
  /AIza[0-9A-Za-z_-]{35}/g, // Google API keys
  /gh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /xox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /Bearer\s+[A-Za-z0-9._-]{20,}/gi, // Bearer tokens
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT shape (header.payload.signature)
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, // PEM private keys
  /\b(?:password|passwd|pwd)\s*[:=]\s*\S+/gi, // inline "password=..." / "password: ..." assignments
  /:\/\/[^\s:/@]+:[^\s@]+@/g, // credentials embedded in a connection-string/URL (scheme://user:pass@)
];

export function redactSensitiveText(input: string): RedactionResult {
  let redacted = input;
  let matched = false;
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(redacted)) {
      matched = true;
      redacted = redacted.replace(pattern, '[REDACTED]');
    }
    pattern.lastIndex = 0; // reset shared global-regex state between calls
  }
  return { redactedText: redacted, containedSecretLike: matched };
}

// The shape any UIA-observed text must be converted to BEFORE it is
// logged, persisted, sent to Activity/Audit, shown in a diagnostic, or
// sent to a model — raw text never survives past this boundary. Prefers
// metadata (presence, length, a capped+redacted preview) over content.
export interface SafeTextEvidence {
  present: boolean;
  length: number;
  redactedPreview: string;
  containedSecretLike: boolean;
}

const MAX_PREVIEW_LENGTH = 60;

export function toSafeTextEvidence(input: string | null | undefined): SafeTextEvidence {
  if (!input) {
    return { present: false, length: 0, redactedPreview: '', containedSecretLike: false };
  }
  const { redactedText, containedSecretLike } = redactSensitiveText(input);
  const redactedPreview = redactedText.length > MAX_PREVIEW_LENGTH ? `${redactedText.slice(0, MAX_PREVIEW_LENGTH)}…` : redactedText;
  return { present: true, length: input.length, redactedPreview, containedSecretLike };
}
