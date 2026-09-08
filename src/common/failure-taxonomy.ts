// Phase 1 STEP 9 — Failure Taxonomy.
//
// A single, shared classification of "what kind of failure was this" used
// by both Capture processing and Candidate Action execution, so the same
// errorCode is never treated inconsistently in two different places. The
// default for an unrecognized code is the SAFEST one — TERMINAL, not
// retryable — never RETRYABLE/AMBIGUOUS by default (never turn uncertainty
// into an invitation to blindly retry).
export type FailureCategory = 'RETRYABLE' | 'TERMINAL' | 'AMBIGUOUS' | 'NEEDS_HUMAN';

export interface FailureClassification {
  category: FailureCategory;
  retryable: boolean;
  // Plain-language, user-safe explanation — never a stack trace, secret,
  // token, or raw external payload (item C).
  userMessage: string;
}

export interface FailureInfo extends FailureClassification {
  errorCode: string;
  occurredAt: string;
  attempt: number;
  lastAttemptAt?: string;
  technicalRef?: string;
  provider?: string;
  requestId?: string;
}

// Known error codes across Capture (STEP 1-4) and Candidate Action (STEP 7)
// paths. Unlisted codes fall back to the safe default below.
const CLASSIFICATIONS: Record<string, FailureClassification> = {
  // ─── Text/URL/PDF Understanding (capture-processor.ts / ai-service.ts) ───
  NO_MODEL_PROVIDER_CONFIGURED: { category: 'TERMINAL', retryable: true, userMessage: 'No AI model provider is configured yet. Retry after connecting one.' },
  ALL_MODEL_PROVIDERS_FAILED: { category: 'RETRYABLE', retryable: true, userMessage: 'Could not reach any configured AI provider. This is usually temporary.' },
  INVALID_MODEL_RESPONSE: { category: 'RETRYABLE', retryable: true, userMessage: 'The AI provider returned an unexpected response. This is usually temporary.' },

  // ─── URL / Browser Agent ───
  BROWSER_UNSAFE_URL: { category: 'TERMINAL', retryable: false, userMessage: 'This link is blocked by security policy and cannot be retried.' },
  BROWSER_UNAVAILABLE: { category: 'RETRYABLE', retryable: true, userMessage: 'The browser could not start. This is usually temporary.' },
  BROWSER_NAVIGATION_FAILED: { category: 'RETRYABLE', retryable: true, userMessage: 'The page could not be reached. This is usually temporary.' },
  BLOCKED_NEEDS_HUMAN: { category: 'NEEDS_HUMAN', retryable: false, userMessage: 'This website needs you to sign in or complete a human verification.' },
  EMPTY_PAGE: { category: 'RETRYABLE', retryable: true, userMessage: 'The page had no readable content. It may load differently on a retry.' },

  // ─── PDF ───
  PDF_EMPTY: { category: 'TERMINAL', retryable: false, userMessage: 'This file is empty and cannot be processed.' },
  INVALID_PDF: { category: 'TERMINAL', retryable: false, userMessage: 'This file is not a valid PDF.' },
  PDF_EXTRACTION_FAILED: { category: 'TERMINAL', retryable: false, userMessage: 'This PDF appears to be corrupted and cannot be read.' },
  PDF_STORAGE_MISSING: { category: 'RETRYABLE', retryable: true, userMessage: 'The file could not be read from storage. This is usually temporary.' },
  OCR_REQUIRED: { category: 'NEEDS_HUMAN', retryable: false, userMessage: 'This PDF has no extractable text (it looks like a scanned image). OCR is not yet supported.' },

  // ─── Candidate lifecycle ───
  CANDIDATE_NOT_FOUND: { category: 'TERMINAL', retryable: false, userMessage: 'This item could not be found.' },
  CANDIDATE_NOT_ACCEPTED: { category: 'TERMINAL', retryable: false, userMessage: 'This suggestion has not been accepted yet.' },
  CANDIDATE_ILLEGAL_TRANSITION: { category: 'TERMINAL', retryable: false, userMessage: 'This suggestion was already decided in another session. Refresh to see its current state.' },
  CANDIDATE_NOT_MODIFIABLE: { category: 'TERMINAL', retryable: false, userMessage: 'This suggestion can no longer be edited.' },
  CANDIDATE_VALIDATION_FAILED: { category: 'TERMINAL', retryable: false, userMessage: 'Please fix the highlighted fields before saving.' },
  CANDIDATE_SOURCE_CHANGED: { category: 'TERMINAL', retryable: false, userMessage: 'The source content has changed since this suggestion was made. It can no longer be acted on.' },

  // ─── Candidate Action (action-resolver.ts) ───
  TASK_STORE_NOT_CONFIGURED: { category: 'RETRYABLE', retryable: true, userMessage: 'The task system is temporarily unavailable.' },
  TASK_CREATE_FAILED: { category: 'RETRYABLE', retryable: true, userMessage: 'Creating the task did not complete. This is usually temporary.' },
  MEMORY_ENGINE_NOT_CONFIGURED: { category: 'RETRYABLE', retryable: true, userMessage: 'Memory is temporarily unavailable.' },
  MEMORY_WRITE_FAILED: { category: 'RETRYABLE', retryable: true, userMessage: 'Saving this memory did not complete. This is usually temporary.' },
  KNOWLEDGE_ENGINE_NOT_CONFIGURED: { category: 'RETRYABLE', retryable: true, userMessage: 'Knowledge indexing is temporarily unavailable.' },
  KNOWLEDGE_INDEX_FAILED: { category: 'RETRYABLE', retryable: true, userMessage: 'Adding this to knowledge did not complete. This is usually temporary.' },

  // ─── Calendar Action (the strictest path — item M) ───
  CALENDAR_SERVICE_NOT_CONFIGURED: { category: 'RETRYABLE', retryable: true, userMessage: 'Google Calendar is temporarily unavailable.' },
  CANDIDATE_CALENDAR_INCOMPLETE: { category: 'TERMINAL', retryable: false, userMessage: 'This calendar suggestion is missing a start time, end time, or timezone.' },
  CALENDAR_APPROVAL_REQUEST_FAILED: { category: 'RETRYABLE', retryable: true, userMessage: 'Requesting approval did not complete. This is usually temporary.' },
  CALENDAR_APPROVAL_NOT_FOUND: { category: 'TERMINAL', retryable: false, userMessage: 'The approval for this action could not be found.' },
  CALENDAR_APPROVAL_REJECTED: { category: 'TERMINAL', retryable: false, userMessage: 'This calendar action was not approved.' },
  CALENDAR_APPROVAL_EXPIRED: { category: 'RETRYABLE', retryable: true, userMessage: 'The approval window expired before this was reviewed. You can request a new approval.' },
  GOOGLE_CALENDAR_DISCONNECTED: { category: 'NEEDS_HUMAN', retryable: true, userMessage: 'Google Calendar is not connected. Connect it, then retry.' },
  CALENDAR_EXECUTION_FAILED: { category: 'RETRYABLE', retryable: true, userMessage: 'Adding this to Google Calendar did not complete. This is usually temporary.' },
  CANDIDATE_ACTION_RECONCILE_REQUIRED: { category: 'AMBIGUOUS', retryable: false, userMessage: 'This action may have already partially completed. Its outcome needs to be verified before trying again.' },
  CANDIDATE_ACTION_IN_PROGRESS: { category: 'AMBIGUOUS', retryable: false, userMessage: 'This action is already in progress.' },
  CANDIDATE_ACTION_NOT_RETRYABLE: { category: 'TERMINAL', retryable: false, userMessage: 'This action cannot be retried right now.' },
  // STEP 9, item O — a RUNNING action was found stale (older than the
  // recovery threshold) on next access, and reconciliation confirmed no
  // real downstream side effect exists. Honestly reported as an
  // interrupted, safely-retryable failure — never silently reset to
  // NOT_STARTED (which would erase that an attempt happened) and never
  // assumed to have succeeded.
  CANDIDATE_ACTION_INTERRUPTED: { category: 'RETRYABLE', retryable: true, userMessage: 'This action was interrupted before it could finish. It can be safely retried.' },
};

const SAFE_DEFAULT: FailureClassification = {
  category: 'TERMINAL',
  retryable: false,
  userMessage: 'This action could not be completed.',
};

export function classifyFailure(errorCode: string | undefined | null): FailureClassification {
  if (!errorCode) return SAFE_DEFAULT;
  return CLASSIFICATIONS[errorCode] ?? SAFE_DEFAULT;
}

// Bounded exponential backoff (item T) — informational only in Phase 1
// (manual retry is preferred for external/consequential actions, item U);
// nothing in this codebase currently enforces it against a manual click.
// Exposed so a future automatic-retry mechanism, or the UI, can use it
// without re-deriving the formula.
const BACKOFF_STEPS_MS = [1000, 2000, 4000];
const BACKOFF_MAX_MS = 4000;

export function computeNextRetryAt(attemptCount: number, from: Date = new Date()): string {
  const delay = BACKOFF_STEPS_MS[Math.min(attemptCount, BACKOFF_STEPS_MS.length - 1)] ?? BACKOFF_MAX_MS;
  return new Date(from.getTime() + delay).toISOString();
}
