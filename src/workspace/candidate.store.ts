import { generateResourceId, getCurrentISOString } from '../common/utils.js';
import { NagexError } from '../common/errors.js';
import { FileRecordStore, resolveNagexDataDir } from '../governance/file-record.store.js';
import {
  isCandidateRecord,
  type CalendarCandidatePayload,
  type CandidateAction,
  type CandidatePayload,
  type CandidateRecord,
  type CandidateStatus,
  type CandidateType,
  type KnowledgeCandidatePayload,
  type MemoryCandidatePayload,
  type TaskCandidatePayload,
} from './candidate.types.js';

// Phase 1 STEP 6 — Modify. Only the fields a caller may actually change;
// candidateId/tenantId/principalId/captureId/contentHash/sourceRefs/status/
// type are structurally absent, not merely runtime-checked (item G).
export interface ModifyCandidateInput {
  title?: string;
  payload?: Record<string, unknown>;
}

function validationError(message: string, requestId: string): NagexError {
  return new NagexError({ code: 'CANDIDATE_VALIDATION_FAILED', category: 'VALIDATION', message, request_id: requestId });
}

function isValidIsoDateTime(value: string): boolean {
  return !Number.isNaN(new Date(value).getTime());
}

function isValidTimezone(tz: string): boolean {
  try {
    // eslint-disable-next-line no-new
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export type UpsertCandidateInput = {
  tenantId: string;
  principalId: string;
  captureId: string;
  understandingId?: string;
  contentHash?: string;
  sourceRefs: string[];
  confidence?: number;
  title: string;
  summary?: string;
} & (
  | { type: 'TASK'; payload: import('./candidate.types.js').TaskCandidatePayload }
  | { type: 'CALENDAR'; payload: import('./candidate.types.js').CalendarCandidatePayload }
  | { type: 'MEMORY'; payload: import('./candidate.types.js').MemoryCandidatePayload }
  | { type: 'KNOWLEDGE'; payload: import('./candidate.types.js').KnowledgeCandidatePayload }
);

export interface CandidateStoreOptions {
  dir?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => string;
}

function normalizeSemanticText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

// Stable semantic identity for dedup/upsert (Phase 1 STEP 5, item F) — never
// includes candidateId, status, or timestamps, so the same real-world
// suggestion always maps to the same identity regardless of when or how
// many times it was generated.
function semanticIdentity(input: { captureId: string; contentHash?: string; type: CandidateType; payload: CandidatePayload }): string {
  let semantic: string;
  if (input.type === 'TASK') {
    const p = input.payload as import('./candidate.types.js').TaskCandidatePayload;
    semantic = normalizeSemanticText(`${p.name}|${p.objective || ''}`);
  } else if (input.type === 'CALENDAR') {
    const p = input.payload as import('./candidate.types.js').CalendarCandidatePayload;
    semantic = normalizeSemanticText(`${p.summary}|${p.start || ''}|${p.end || ''}`);
  } else if (input.type === 'MEMORY') {
    const p = input.payload as import('./candidate.types.js').MemoryCandidatePayload;
    semantic = normalizeSemanticText(p.statement);
  } else {
    const p = input.payload as import('./candidate.types.js').KnowledgeCandidatePayload;
    semantic = normalizeSemanticText(`${p.title}|${p.sourceCaptureId}`);
  }
  return `${input.captureId}::${input.contentHash || ''}::${input.type}::${semantic}`;
}

// Durable, tenant/principal-isolated Candidate persistence (Phase 1 STEP 5).
// Independent of Task/Calendar/Memory/Knowledge persistence — this store
// never calls into any of those systems; accepting a candidate here only
// ever changes this store's own record (item J).
export class CandidateStore {
  private readonly records = new Map<string, CandidateRecord>();
  private readonly fileStore: FileRecordStore<CandidateRecord>;
  private readonly now: () => string;

  constructor(options: CandidateStoreOptions = {}) {
    const env = options.env ?? process.env;
    const dir = options.dir ?? resolveNagexDataDir('candidates', 'NAGEX_CANDIDATES_DIR', env);
    this.fileStore = new FileRecordStore<CandidateRecord>(dir, isCandidateRecord);
    this.now = options.now ?? (() => getCurrentISOString());
    for (const record of this.fileStore.readAll()) this.records.set(record.candidateId, record);
  }

  private persist(record: CandidateRecord): CandidateRecord {
    record.updatedAt = this.now();
    this.records.set(record.candidateId, record);
    this.fileStore.write(record.candidateId, record);
    return record;
  }

  public get(candidateId: string): CandidateRecord | undefined {
    return this.records.get(candidateId);
  }

  // Tenant/principal-isolated fetch (item D) — a candidate belonging to a
  // different tenant or principal is treated as not found, never returned,
  // even when the exact ID is known.
  private requireOwned(candidateId: string, tenantId: string, principalId: string, requestId: string): CandidateRecord {
    const record = this.records.get(candidateId);
    if (!record || record.tenantId !== tenantId || record.principalId !== principalId) {
      throw new NagexError({
        code: 'CANDIDATE_NOT_FOUND',
        category: 'NOT_FOUND',
        message: `Candidate ${candidateId} was not found.`,
        request_id: requestId,
      });
    }
    return record;
  }

  public list(principalId: string, tenantId: string, filter?: { status?: CandidateStatus; type?: CandidateType }): CandidateRecord[] {
    return [...this.records.values()]
      .filter((c) => c.principalId === principalId && c.tenantId === tenantId)
      .filter((c) => !filter?.status || c.status === filter.status)
      .filter((c) => !filter?.type || c.type === filter.type)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  public listByCapture(captureId: string, principalId: string, tenantId: string): CandidateRecord[] {
    return this.list(principalId, tenantId).filter((c) => c.captureId === captureId);
  }

  // Idempotent upsert (item F): the same real-world suggestion (same
  // captureId + contentHash + type + normalized semantic identity) never
  // produces a second PROPOSED record — reprocessing/retrying unchanged
  // Understanding output is always safe.
  public upsert(input: UpsertCandidateInput): CandidateRecord {
    const key = semanticIdentity(input);
    let existing: CandidateRecord | undefined;
    for (const record of this.records.values()) {
      if (record.tenantId !== input.tenantId || record.principalId !== input.principalId) continue;
      if (semanticIdentity(record) !== key) continue;
      existing = record;
      break;
    }

    if (existing) {
      if (existing.status === 'PROPOSED') {
        // Refresh the grounding/confidence a fresh Understanding pass
        // produced, without minting a duplicate or disturbing identity.
        existing.sourceRefs = input.sourceRefs;
        existing.confidence = input.confidence;
        existing.summary = input.summary;
        existing.understandingId = input.understandingId ?? existing.understandingId;
        return this.persist(existing);
      }
      // ACCEPTED / REJECTED / EXPIRED history is never silently overwritten
      // or resurrected by a later upsert (items G/K).
      return existing;
    }

    const timestamp = this.now();
    const record = {
      candidateId: generateResourceId('cand'),
      tenantId: input.tenantId,
      principalId: input.principalId,
      captureId: input.captureId,
      understandingId: input.understandingId,
      type: input.type,
      status: 'PROPOSED' as const,
      title: input.title,
      summary: input.summary,
      payload: input.payload,
      confidence: input.confidence,
      sourceRefs: input.sourceRefs,
      contentHash: input.contentHash,
      createdAt: timestamp,
      updatedAt: timestamp,
      reviewedAt: null,
    } as CandidateRecord;
    return this.persist(record);
  }

  // Source-change supersession (item G): any still-PROPOSED candidate for
  // this capture whose contentHash no longer matches the capture's current
  // content is superseded — it is EXPIRED, never silently treated as
  // current. ACCEPTED/REJECTED decisions are history and are never touched
  // here, regardless of contentHash.
  public expireStaleForCapture(captureId: string, tenantId: string, principalId: string, currentContentHash: string | undefined): void {
    for (const record of this.records.values()) {
      if (record.captureId !== captureId || record.tenantId !== tenantId || record.principalId !== principalId) continue;
      if (record.status !== 'PROPOSED') continue;
      if (record.contentHash === currentContentHash) continue;
      record.status = 'EXPIRED';
      record.reviewedAt = this.now();
      this.persist(record);
    }
  }

  // Allowed transitions (item I): PROPOSED -> ACCEPTED / REJECTED / EXPIRED
  // only. Anything else (including re-accepting/re-rejecting, or reopening
  // a decided/expired candidate) fails closed with CANDIDATE_ILLEGAL_TRANSITION.
  private transition(candidateId: string, tenantId: string, principalId: string, to: CandidateStatus, review: CandidateRecord['review'], requestId: string): CandidateRecord {
    const record = this.requireOwned(candidateId, tenantId, principalId, requestId);
    if (record.status !== 'PROPOSED') {
      throw new NagexError({
        code: 'CANDIDATE_ILLEGAL_TRANSITION',
        category: 'CONFLICT',
        message: `Candidate ${candidateId} is ${record.status}; only a PROPOSED candidate can transition to ${to}.`,
        request_id: requestId,
      });
    }
    record.status = to;
    record.reviewedAt = this.now();
    if (review) record.review = review;
    return this.persist(record);
  }

  // IMPORTANT (item J): accepting a candidate here ONLY changes its own
  // status. It never creates a Task, Calendar event, Memory record, or
  // Knowledge entry, and never calls into TaskStore/MemoryEngine/
  // KnowledgeEngine/ActionApprovalStore — that belongs to a later, separate
  // Action phase (STEP 7).
  public accept(candidateId: string, tenantId: string, principalId: string, requestId = 'cand_accept'): CandidateRecord {
    return this.transition(candidateId, tenantId, principalId, 'ACCEPTED', { decision: 'ACCEPT' }, requestId);
  }

  public reject(candidateId: string, tenantId: string, principalId: string, requestId = 'cand_reject'): CandidateRecord {
    return this.transition(candidateId, tenantId, principalId, 'REJECTED', { decision: 'REJECT' }, requestId);
  }

  public expire(candidateId: string, tenantId: string, principalId: string, requestId = 'cand_expire'): CandidateRecord {
    return this.transition(candidateId, tenantId, principalId, 'EXPIRED', undefined, requestId);
  }

  // Phase 1 STEP 7 — a dumb, tenant/principal-isolated merge-setter for the
  // action sub-record. It does NOT decide idempotency/transition legality
  // itself (that belongs entirely to CandidateActionResolver, the single
  // place that logic lives); it only ever merges the given fields and stamps
  // action.updatedAt. Candidate.status is never touched here (item G).
  public updateAction(candidateId: string, tenantId: string, principalId: string, patch: Partial<CandidateAction>, requestId = 'cand_action_update'): CandidateRecord {
    const record = this.requireOwned(candidateId, tenantId, principalId, requestId);
    record.action = {
      status: 'NOT_STARTED',
      ...(record.action || {}),
      ...patch,
      updatedAt: this.now(),
    };
    return this.persist(record);
  }

  // Phase 1 STEP 6, item G: only a PROPOSED candidate may be modified.
  // Validates the type-specific payload and fails closed (never invents a
  // missing value) — candidateId/captureId/contentHash/sourceRefs/status/
  // type are never touched, and the resulting review.modified=true is a
  // durable, visible fact that this suggestion was edited before deciding.
  public modify(candidateId: string, tenantId: string, principalId: string, patch: ModifyCandidateInput, requestId = 'cand_modify'): CandidateRecord {
    const record = this.requireOwned(candidateId, tenantId, principalId, requestId);
    if (record.status !== 'PROPOSED') {
      throw new NagexError({
        code: 'CANDIDATE_NOT_MODIFIABLE',
        category: 'CONFLICT',
        message: `Candidate ${candidateId} is ${record.status}; only a PROPOSED candidate can be modified.`,
        request_id: requestId,
      });
    }

    if (patch.title !== undefined) {
      if (!patch.title.trim()) throw validationError('title must not be blank.', requestId);
      record.title = patch.title.trim();
    }

    if (patch.payload !== undefined) {
      record.payload = this.validateAndMergePayload(record.type, record.payload, patch.payload, requestId) as never;
    }

    record.review = { ...(record.review || {}), modified: true };
    return this.persist(record);
  }

  private validateAndMergePayload(type: CandidateType, existing: CandidatePayload, patch: Record<string, unknown>, requestId: string): CandidatePayload {
    if (type === 'TASK') {
      const e = existing as TaskCandidatePayload;
      const name = patch.name !== undefined ? String(patch.name) : e.name;
      if (!name.trim()) throw validationError('name must not be blank.', requestId);
      const objective = patch.objective !== undefined ? (patch.objective === null ? undefined : String(patch.objective)) : e.objective;
      const dueAt = patch.dueAt !== undefined ? (patch.dueAt as string | null) : (e.dueAt ?? null);
      if (dueAt && !isValidIsoDateTime(dueAt)) throw validationError('dueAt must be a valid date/time.', requestId);
      const result: TaskCandidatePayload = { name: name.trim(), dueAt };
      if (objective !== undefined) result.objective = objective;
      return result;
    }

    if (type === 'CALENDAR') {
      const e = existing as CalendarCandidatePayload;
      const summary = patch.summary !== undefined ? String(patch.summary) : e.summary;
      if (!summary.trim()) throw validationError('summary must not be blank.', requestId);
      const start = patch.start !== undefined ? (patch.start as string | null) : (e.start ?? null);
      const end = patch.end !== undefined ? (patch.end as string | null) : (e.end ?? null);
      if (start && !isValidIsoDateTime(start)) throw validationError('start must be a valid date/time.', requestId);
      if (end && !isValidIsoDateTime(end)) throw validationError('end must be a valid date/time.', requestId);
      if (start && end && new Date(end).getTime() < new Date(start).getTime()) {
        throw validationError('end must not be before start.', requestId);
      }
      const timezone = patch.timezone !== undefined ? (patch.timezone as string | null) : (e.timezone ?? null);
      if (timezone && !isValidTimezone(timezone)) throw validationError('timezone is not a recognized IANA timezone.', requestId);
      const attendees = patch.attendees !== undefined ? (patch.attendees as unknown[]) : (e.attendees ?? []);
      const normalizedAttendees: string[] = [];
      for (const raw of attendees) {
        const email = String(raw).trim();
        if (!isValidEmail(email)) throw validationError(`attendee "${email}" is not a valid email address.`, requestId);
        normalizedAttendees.push(email);
      }
      return { summary: summary.trim(), start, end, timezone, attendees: normalizedAttendees };
    }

    if (type === 'MEMORY') {
      const e = existing as MemoryCandidatePayload;
      const statement = patch.statement !== undefined ? String(patch.statement) : e.statement;
      if (!statement.trim()) throw validationError('statement must not be blank.', requestId);
      const category = patch.category !== undefined ? (patch.category as string | undefined) : e.category;
      const durability = patch.durability !== undefined ? (patch.durability as string | undefined) : e.durability;
      const result: MemoryCandidatePayload = { statement: statement.trim() };
      if (category !== undefined) result.category = category;
      if (durability !== undefined) result.durability = durability;
      return result;
    }

    // KNOWLEDGE
    const e = existing as KnowledgeCandidatePayload;
    const knowledgeTitle = patch.title !== undefined ? String(patch.title) : e.title;
    if (!knowledgeTitle.trim()) throw validationError('title must not be blank.', requestId);
    const summary = patch.summary !== undefined ? (patch.summary as string | undefined) : e.summary;
    const result: KnowledgeCandidatePayload = { title: knowledgeTitle.trim(), sourceCaptureId: e.sourceCaptureId };
    if (summary !== undefined) result.summary = summary;
    return result;
  }
}
