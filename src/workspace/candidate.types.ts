// Phase 1 STEP 5 — Canonical Candidate Model.
//
// A Candidate means: "NAgex believes this may be useful, but the user has
// not yet accepted it." It is not a Task, Calendar event, Memory record,
// Knowledge record, Approval record, or execution request — those are all
// downstream systems a Candidate may later feed into (STEP 7), never
// something a Candidate creates by existing or being accepted.
export type CandidateType = 'TASK' | 'CALENDAR' | 'MEMORY' | 'KNOWLEDGE';
export type CandidateStatus = 'PROPOSED' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED';

// Phase 1 STEP 7 — a separate axis from CandidateStatus (item G): whether an
// ACCEPTED candidate's real downstream action has run, and how it went.
// CANDIDATE STATUS NEVER CHANGES BECAUSE OF THIS — a candidate stays
// ACCEPTED even when its action is FAILED (item O).
export type CandidateActionStatus = 'NOT_STARTED' | 'PENDING_APPROVAL' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';

// Phase 1 STEP 9, item D — retry bookkeeping, kept separate from
// CandidateActionStatus itself so status never has to encode "how many
// times has this been tried."
export interface CandidateActionRetry {
  attemptCount: number;
  maxAttempts?: number;
  lastAttemptAt?: string;
  nextRetryAt?: string | null;
  lastErrorCode?: string;
}

export interface CandidateAction {
  status: CandidateActionStatus;
  targetType?: CandidateType;
  // The id of the real downstream object this action produced (Task.taskId,
  // MemoryRecord.id, KnowledgeDocument.document_id, or the external Google
  // Calendar event id) — never set until execution genuinely succeeded.
  targetId?: string;
  approvalId?: string;
  executionId?: string;
  externalUrl?: string;
  errorCode?: string;
  // Phase 1 STEP 9, item C — the same failure taxonomy used across
  // Capture/Understanding/Action, so the UI's Retry gating (item R) reads a
  // single, consistent field regardless of which subsystem failed.
  category?: 'RETRYABLE' | 'TERMINAL' | 'AMBIGUOUS' | 'NEEDS_HUMAN';
  retryable?: boolean;
  retry?: CandidateActionRetry;
  updatedAt?: string;
}

export interface TaskCandidatePayload {
  name: string;
  objective?: string;
  dueAt?: string | null;
}

export interface CalendarCandidatePayload {
  summary: string;
  start?: string | null;
  end?: string | null;
  timezone?: string | null;
  attendees?: string[];
}

export interface MemoryCandidatePayload {
  statement: string;
  category?: string;
  durability?: string;
}

export interface KnowledgeCandidatePayload {
  title: string;
  summary?: string;
  sourceCaptureId: string;
}

export type CandidatePayload =
  | TaskCandidatePayload
  | CalendarCandidatePayload
  | MemoryCandidatePayload
  | KnowledgeCandidatePayload;

interface BaseCandidateRecord {
  candidateId: string;

  tenantId: string;
  principalId: string;

  captureId: string;
  understandingId?: string;

  status: CandidateStatus;

  title: string;
  summary?: string;

  confidence?: number;

  // Plain reference strings, never fabricated (Phase 1 STEP 5, item H):
  // a real ProcessingChunk id for PDFs, or a `capture:<captureId>` reference
  // when the source has no finer-grained chunk structure (TEXT, small URL
  // pages) — always traceable back to real content that was actually
  // shown to the model.
  sourceRefs: string[];
  contentHash?: string;

  createdAt: string;
  updatedAt: string;
  reviewedAt?: string | null;

  review?: {
    decision?: 'ACCEPT' | 'REJECT';
    modified?: boolean;
  };

  // Phase 1 STEP 7 — present only once an execute has actually been
  // requested; absent means NOT_STARTED.
  action?: CandidateAction;
}

export interface TaskCandidateRecord extends BaseCandidateRecord {
  type: 'TASK';
  payload: TaskCandidatePayload;
}

export interface CalendarCandidateRecord extends BaseCandidateRecord {
  type: 'CALENDAR';
  payload: CalendarCandidatePayload;
}

export interface MemoryCandidateRecord extends BaseCandidateRecord {
  type: 'MEMORY';
  payload: MemoryCandidatePayload;
}

export interface KnowledgeCandidateRecord extends BaseCandidateRecord {
  type: 'KNOWLEDGE';
  payload: KnowledgeCandidatePayload;
}

export type CandidateRecord =
  | TaskCandidateRecord
  | CalendarCandidateRecord
  | MemoryCandidateRecord
  | KnowledgeCandidateRecord;

function isCandidateStatus(value: unknown): value is CandidateStatus {
  return value === 'PROPOSED' || value === 'ACCEPTED' || value === 'REJECTED' || value === 'EXPIRED';
}

function isCandidateType(value: unknown): value is CandidateType {
  return value === 'TASK' || value === 'CALENDAR' || value === 'MEMORY' || value === 'KNOWLEDGE';
}

function isCandidateActionStatus(value: unknown): value is CandidateActionStatus {
  return value === 'NOT_STARTED' || value === 'PENDING_APPROVAL' || value === 'RUNNING' || value === 'SUCCEEDED' || value === 'FAILED';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

// Fail-closed validator used by CandidateStore's FileRecordStore — a
// corrupted or malformed persisted record is treated as absent rather than
// trusted (Phase 1 STEP 5, item D).
export function isCandidateRecord(value: unknown): value is CandidateRecord {
  if (!isPlainObject(value)) return false;
  const v = value;
  if (
    typeof v.candidateId !== 'string' ||
    typeof v.tenantId !== 'string' ||
    typeof v.principalId !== 'string' ||
    typeof v.captureId !== 'string' ||
    !isCandidateType(v.type) ||
    !isCandidateStatus(v.status) ||
    typeof v.title !== 'string' ||
    !Array.isArray(v.sourceRefs) ||
    !v.sourceRefs.every((r) => typeof r === 'string') ||
    typeof v.createdAt !== 'string' ||
    typeof v.updatedAt !== 'string' ||
    !isPlainObject(v.payload)
  ) {
    return false;
  }
  if (v.action !== undefined && (!isPlainObject(v.action) || !isCandidateActionStatus(v.action.status))) {
    return false;
  }
  const payload = v.payload;
  if (v.type === 'TASK') return typeof payload.name === 'string';
  if (v.type === 'CALENDAR') return typeof payload.summary === 'string';
  if (v.type === 'MEMORY') return typeof payload.statement === 'string';
  if (v.type === 'KNOWLEDGE') return typeof payload.title === 'string' && typeof payload.sourceCaptureId === 'string';
  return false;
}
