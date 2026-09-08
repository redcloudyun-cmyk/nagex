// Phase 1 STEP 7 — Real Actions. Extended in STEP 9 — Retry / Failure
// Handling.
//
// Converts an ACCEPTED canonical Candidate into real downstream state,
// safely, idempotently, and truthfully. This is the ONLY place that logic
// lives (item K) — nothing else in the codebase is allowed to create a
// Task/Memory/Knowledge record or request a Calendar approval on a
// candidate's behalf.
//
// Central principle (item A): Candidate acceptance and action execution are
// two separate operations. Nothing here runs automatically when a candidate
// is ACCEPTED — it only ever runs when explicitly invoked
// (executeCandidate/retryCandidate), mirroring "Apply" in the UI.
//
// For CALENDAR specifically (the Korean note in the STEP 7 directive):
// Candidate Review ("is this the right event?") and Action Approval ("should
// NAgex actually create it in Google Calendar?") are two distinct gates.
// executeCandidate's first call only ever REQUESTS the Action Approval; the
// real Google write happens only after that approval is separately granted
// via the existing, unchanged /api/v1/approvals/:id/approve endpoint, and
// only on a later call to executeCandidate (or the API's execute route) that
// finds the approval already APPROVED.
//
// STEP 9 adds: a shared failure taxonomy (RETRYABLE/TERMINAL/AMBIGUOUS/
// NEEDS_HUMAN), durable retry bookkeeping separate from status, a
// reconciliation layer that inspects real downstream stores before ever
// creating a second Task/Memory/Knowledge record or re-touching Calendar,
// and stale-RUNNING recovery on next access after a crash. Never: catch an
// error and mark success; assume an unknown external outcome either way.
import { NagexError } from '../common/errors.js';
import { classifyFailure, computeNextRetryAt, type FailureCategory } from '../common/failure-taxonomy.js';
import type { CandidateStore } from './candidate.store.js';
import type {
  CalendarCandidatePayload,
  CandidateAction,
  CandidateRecord,
  KnowledgeCandidatePayload,
  MemoryCandidatePayload,
  TaskCandidatePayload,
} from './candidate.types.js';
import type { CaptureStore } from './capture.store.js';
import type { TaskStore } from '../tasks/task.store.js';
import type { MemoryEngine } from '../context/memory.engine.js';
import type { KnowledgeEngine } from '../context/knowledge.engine.js';
import type { GoogleCalendarService } from '../tools/google-calendar.service.js';
import type { ExecutionStore } from '../governance/execution.store.js';
import type { AuditLogger } from '../governance/audit.logger.js';
import type { ActivityStore, ActivityStatus } from '../governance/activity.store.js';
import type { CalendarEventPayload } from '../integrations/google/calendar.client.js';
import { PreExecutionSafetyGate } from '../governance/action-safety.gate.js';
import { PersistentSafetyStore } from '../governance/safety.store.js';

export interface CandidateActionResolverOptions {
  candidateStore: CandidateStore;
  captureStore: CaptureStore;
  taskStore?: TaskStore;
  memoryEngine?: MemoryEngine;
  knowledgeEngine?: KnowledgeEngine;
  calendarService?: GoogleCalendarService;
  executionStore?: ExecutionStore;
  auditLogger?: AuditLogger;
  // Phase 1 STEP 8 — the durable, tenant-isolated consumer Activity
  // projection (never the raw AuditLogger, never the legacy non-isolated
  // executionHistory demo array).
  activityStore?: ActivityStore;
  // Phase 1 STEP 9, item O — how old a RUNNING action must be before it is
  // treated as possibly crashed and eligible for reconciliation on next
  // access, rather than permanently blocking with CANDIDATE_ACTION_IN_PROGRESS.
  runningStaleThresholdMs?: number;
}

const DEFAULT_RUNNING_STALE_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes

function newRequestId(): string {
  return `req_cand_act_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export type ReconciliationOutcome = 'CONFIRMED_SUCCESS' | 'CONFIRMED_NOT_EXECUTED' | 'AMBIGUOUS';

export class CandidateActionResolver {
  private readonly runningStaleThresholdMs: number;

  constructor(private readonly deps: CandidateActionResolverOptions) {
    this.runningStaleThresholdMs = deps.runningStaleThresholdMs ?? DEFAULT_RUNNING_STALE_THRESHOLD_MS;
  }

  // item T's execute endpoint. Idempotent: a SUCCEEDED action is returned
  // unchanged, never re-run (item I).
  public async executeCandidate(candidateId: string, tenantId: string, principalId: string, requestId = newRequestId()): Promise<CandidateRecord> {
    const candidate = this.requireExecutable(candidateId, tenantId, principalId, requestId);

    if (candidate.action?.status === 'SUCCEEDED') {
      return candidate;
    }
    if (candidate.action?.status === 'RUNNING') {
      if (this.isStaleRunning(candidate)) {
        // STEP 9, item O: a crash mid-RUNNING must not permanently stick —
        // inspect real durable state and resolve it truthfully instead of
        // blocking forever or guessing.
        const { candidate: reconciled } = this.reconcileCandidateAction(candidateId, tenantId, principalId, requestId);
        if (reconciled.action?.status === 'RUNNING') {
          // Reconciliation itself could not determine anything new (e.g. no
          // dependent store configured) — still fail closed rather than spin.
          throw new NagexError({ code: 'CANDIDATE_ACTION_IN_PROGRESS', category: 'CONFLICT', message: `Candidate ${candidateId}'s action is already running.`, request_id: requestId });
        }
        // A reconciled non-RUNNING result (SUCCEEDED, or FAILED/retryable)
        // is returned as-is; the caller decides whether to retry.
        return reconciled;
      }
      throw new NagexError({
        code: 'CANDIDATE_ACTION_IN_PROGRESS',
        category: 'CONFLICT',
        message: `Candidate ${candidateId}'s action is already running.`,
        request_id: requestId,
      });
    }

    // Phase 2 Step 1 — Pre-Execution Action Safety Gate (TS-4, Directive Section 6 & 17)
    const safetyDecision = await PreExecutionSafetyGate.getInstance().evaluateAction({
      tenantId,
      userId: principalId,
      capabilityId: candidate.type,
      actionType: candidate.type,
      toolArguments: candidate.payload as Record<string, any>,
    });

    if (!safetyDecision.executionAllowed) {
      const now = new Date().toISOString();
      const updated = this.deps.candidateStore.updateAction(
        candidate.candidateId,
        candidate.tenantId,
        candidate.principalId,
        {
          status: 'FAILED',
          errorCode: 'SAFETY_BLOCKED',
          category: 'TERMINAL',
          retryable: false,
        },
        requestId
      );

      const safetyStore = new PersistentSafetyStore();
      await safetyStore.recordEvent({
        eventId: `sev_act_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        tenantId,
        userId: principalId,
        decisionId: safetyDecision.decisionId,
        eventType: 'safety.action.blocked',
        riskLevel: safetyDecision.riskLevel,
        categories: safetyDecision.categories,
        reasonCodes: safetyDecision.reasonCodes,
        policyVersion: safetyDecision.policyVersion,
        actionTaken: safetyDecision.userFacingExplanation,
        userFacingExplanation: safetyDecision.userFacingExplanation,
        timestamp: now,
      });

      this.audit('candidate.action.blocked', updated, requestId, 'DENIED');
      return updated;
    }

    this.audit('candidate.action.requested', candidate, requestId, 'PENDING_APPROVAL');

    if (candidate.type === 'TASK') return this.executeTask(candidate, requestId);
    if (candidate.type === 'MEMORY') return this.executeMemory(candidate, requestId);
    if (candidate.type === 'KNOWLEDGE') return this.executeKnowledge(candidate, requestId);
    return this.executeCalendar(candidate, requestId);
  }

  // item Q's retry endpoint. Only a FAILED action whose classification says
  // retryable=true may be retried (items B/I/R) — never blindly, never for
  // AMBIGUOUS/TERMINAL failures.
  public async retryCandidate(candidateId: string, tenantId: string, principalId: string, requestId = newRequestId()): Promise<CandidateRecord> {
    const candidate = this.requireExecutable(candidateId, tenantId, principalId, requestId);
    if (candidate.action?.status !== 'FAILED') {
      throw new NagexError({
        code: 'CANDIDATE_ACTION_NOT_RETRYABLE',
        category: 'CONFLICT',
        message: `Candidate ${candidateId}'s action is ${candidate.action?.status ?? 'NOT_STARTED'}; only a FAILED action can be retried.`,
        request_id: requestId,
      });
    }
    if (candidate.action.retryable !== true) {
      this.audit('candidate.action.retry.blocked', candidate, requestId, 'DENIED');
      const classification = classifyFailure(candidate.action.errorCode);
      throw new NagexError({
        code: candidate.action.errorCode || 'CANDIDATE_ACTION_NOT_RETRYABLE',
        category: 'CONFLICT',
        message: classification.userMessage,
        request_id: requestId,
      });
    }

    const nextAttempt = (candidate.action.retry?.attemptCount ?? 0) + 1;
    this.audit('candidate.action.retry.requested', candidate, requestId, 'PENDING_APPROVAL');
    // A retry attempt is its own truthful, historical Activity entry (item
    // X) — distinct from the earlier failure and whatever this attempt
    // eventually produces; never overwrites either.
    this.recordActivity(candidate, 'RUNNING', CandidateActionResolver.RETRY_LABEL[candidate.type], `${candidate.candidateId}:RETRY:${nextAttempt}`);
    return this.executeCandidate(candidateId, tenantId, principalId, requestId);
  }

  public getAction(candidateId: string, tenantId: string, principalId: string, requestId = newRequestId()): CandidateRecord['action'] {
    const candidate = this.deps.candidateStore.get(candidateId);
    if (!candidate || candidate.tenantId !== tenantId || candidate.principalId !== principalId) {
      throw new NagexError({ code: 'CANDIDATE_NOT_FOUND', category: 'NOT_FOUND', message: `Candidate ${candidateId} was not found.`, request_id: requestId });
    }
    return candidate.action ?? { status: 'NOT_STARTED' };
  }

  // Phase 1 STEP 9, item P — inspects real downstream stores/execution
  // records to determine what actually happened, without contacting any
  // external API. Safe to call repeatedly; only writes when it can prove a
  // real outcome (CONFIRMED_SUCCESS) or that nothing happened
  // (CONFIRMED_NOT_EXECUTED coming from a stale RUNNING) — AMBIGUOUS is
  // recorded but never guessed past.
  public reconcileCandidateAction(candidateId: string, tenantId: string, principalId: string, requestId = newRequestId()): { outcome: ReconciliationOutcome; candidate: CandidateRecord } {
    const candidate = this.deps.candidateStore.get(candidateId);
    if (!candidate || candidate.tenantId !== tenantId || candidate.principalId !== principalId) {
      throw new NagexError({ code: 'CANDIDATE_NOT_FOUND', category: 'NOT_FOUND', message: `Candidate ${candidateId} was not found.`, request_id: requestId });
    }

    let outcome: ReconciliationOutcome;
    let successPatch: { targetType: CandidateRecord['type']; targetId: string; executionId?: string; externalUrl?: string } | null = null;

    if (candidate.type === 'TASK') {
      const existing = this.deps.taskStore?.findByCandidateId(candidateId);
      if (existing) { outcome = 'CONFIRMED_SUCCESS'; successPatch = { targetType: 'TASK', targetId: existing.taskId }; }
      else outcome = 'CONFIRMED_NOT_EXECUTED';
    } else if (candidate.type === 'MEMORY') {
      const existing = this.deps.memoryEngine?.findByCandidateId(candidateId);
      if (existing) { outcome = 'CONFIRMED_SUCCESS'; successPatch = { targetType: 'MEMORY', targetId: existing.id }; }
      else outcome = 'CONFIRMED_NOT_EXECUTED';
    } else if (candidate.type === 'KNOWLEDGE') {
      const existing = this.deps.knowledgeEngine?.findByCandidateId(candidateId);
      if (existing) { outcome = 'CONFIRMED_SUCCESS'; successPatch = { targetType: 'KNOWLEDGE', targetId: existing.document_id }; }
      else outcome = 'CONFIRMED_NOT_EXECUTED';
    } else {
      const approvalId = candidate.action?.approvalId;
      if (!approvalId) {
        outcome = 'CONFIRMED_NOT_EXECUTED';
      } else {
        const approval = this.deps.calendarService?.getApproval(approvalId);
        if (!approval || approval.status === 'PENDING' || approval.status === 'REJECTED' || approval.status === 'EXPIRED') {
          outcome = 'CONFIRMED_NOT_EXECUTED';
        } else {
          const execution = approval.executionId && this.deps.executionStore ? this.deps.executionStore.get(approval.executionId) : null;
          if (execution && execution.status === 'SUCCEEDED' && execution.externalId) {
            outcome = 'CONFIRMED_SUCCESS';
            successPatch = { targetType: 'CALENDAR', targetId: execution.externalId, executionId: execution.executionId, externalUrl: execution.externalUrl || undefined };
          } else {
            outcome = 'AMBIGUOUS';
          }
        }
      }
    }

    let updated = candidate;
    if (outcome === 'CONFIRMED_SUCCESS' && successPatch) {
      if (candidate.action?.status !== 'SUCCEEDED') {
        updated = this.markSucceeded(candidate, successPatch, requestId);
      }
      this.audit('candidate.action.reconciled', updated, requestId, 'SUCCESS');
    } else if (outcome === 'AMBIGUOUS') {
      if (candidate.action?.status !== 'FAILED' || candidate.action?.errorCode !== 'CANDIDATE_ACTION_RECONCILE_REQUIRED') {
        updated = this.markFailed(candidate, 'CANDIDATE_ACTION_RECONCILE_REQUIRED', requestId);
      }
      this.audit('candidate.action.ambiguous', updated, requestId, 'FAILED');
    } else if (candidate.action?.status === 'RUNNING') {
      // Confirmed no real side effect occurred — honestly FAILED/retryable,
      // never silently reset to NOT_STARTED (that would erase the fact an
      // attempt was made) and never assumed SUCCEEDED.
      updated = this.markFailed(candidate, 'CANDIDATE_ACTION_INTERRUPTED', requestId);
      this.audit('candidate.action.reconciled', updated, requestId, 'FAILED');
    }
    return { outcome, candidate: updated };
  }

  private isStaleRunning(candidate: CandidateRecord): boolean {
    if (candidate.action?.status !== 'RUNNING') return false;
    const updatedAt = candidate.action.updatedAt ? new Date(candidate.action.updatedAt).getTime() : 0;
    if (!updatedAt) return true; // no timestamp at all — treat as stale, never trust silently
    return Date.now() - updatedAt > this.runningStaleThresholdMs;
  }

  // item R: re-verifies ACCEPTED status and source integrity immediately
  // before every execute/retry — never trusts a decision made in the past
  // against content that may have since changed.
  private requireExecutable(candidateId: string, tenantId: string, principalId: string, requestId: string): CandidateRecord {
    const candidate = this.deps.candidateStore.get(candidateId);
    if (!candidate || candidate.tenantId !== tenantId || candidate.principalId !== principalId) {
      throw new NagexError({ code: 'CANDIDATE_NOT_FOUND', category: 'NOT_FOUND', message: `Candidate ${candidateId} was not found.`, request_id: requestId });
    }
    if (candidate.status !== 'ACCEPTED') {
      throw new NagexError({
        code: 'CANDIDATE_NOT_ACCEPTED',
        category: 'CONFLICT',
        message: `Candidate ${candidateId} is ${candidate.status}; only an ACCEPTED candidate can be executed.`,
        request_id: requestId,
      });
    }
    if (candidate.contentHash) {
      const capture = this.deps.captureStore.getCapture(candidate.captureId);
      if (!capture || capture.metadata.contentHash !== candidate.contentHash) {
        throw new NagexError({
          code: 'CANDIDATE_SOURCE_CHANGED',
          category: 'CONFLICT',
          message: 'The source content has changed since this candidate was proposed; it cannot be executed as-is.',
          request_id: requestId,
        });
      }
    }
    return candidate;
  }

  private audit(action: string, candidate: CandidateRecord, requestId: string, result: 'SUCCESS' | 'PENDING_APPROVAL' | 'FAILED' | 'DENIED'): void {
    this.deps.auditLogger?.logEvent({
      actor: { type: 'user', id: candidate.principalId },
      tenant_id: candidate.tenantId,
      action,
      resource: { type: 'Candidate', id: candidate.candidateId },
      result,
      reason_code: result === 'FAILED' || result === 'DENIED' ? candidate.action?.errorCode : undefined,
      request_id: requestId,
      details: {
        candidateId: candidate.candidateId,
        candidateType: candidate.type,
        targetType: candidate.action?.targetType,
        targetId: candidate.action?.targetId,
        approvalId: candidate.action?.approvalId,
        executionId: candidate.action?.executionId,
        attempt: candidate.action?.retry?.attemptCount,
      },
    });
  }

  // The single truthful, human-readable Activity trail (STEP 8, item P) —
  // carried as a durable, tenant-scoped audit event's details.summary
  // rather than the legacy in-memory executionHistory demo array (see
  // server_web.ts), which has no tenant/principal isolation. Never exposes
  // provider/tool internals — only the plain-language outcome. Kept
  // separate from recordActivity (the durable consumer-facing store) —
  // this one is the technical audit trail.
  private activity(summary: string, candidate: CandidateRecord, requestId: string): void {
    this.deps.auditLogger?.logEvent({
      actor: { type: 'user', id: candidate.principalId },
      tenant_id: candidate.tenantId,
      action: 'candidate.action.activity',
      resource: { type: 'Candidate', id: candidate.candidateId },
      result: 'SUCCESS',
      request_id: requestId,
      details: { summary, candidateId: candidate.candidateId },
    });
  }

  private markSucceeded(candidate: CandidateRecord, patch: { targetType: CandidateRecord['type']; targetId: string; executionId?: string; externalUrl?: string }, requestId: string): CandidateRecord {
    const prevRetry = candidate.action?.retry;
    const actionPatch: Partial<CandidateAction> = {
      ...patch,
      status: 'SUCCEEDED',
      errorCode: undefined,
      category: undefined,
      retryable: undefined,
      // attemptCount is kept as truthful history ("it took N attempts") —
      // never erased on success (item V/W).
      retry: prevRetry ? { ...prevRetry, nextRetryAt: null } : undefined,
    };
    const updated = this.deps.candidateStore.updateAction(candidate.candidateId, candidate.tenantId, candidate.principalId, actionPatch, requestId);
    this.audit('candidate.action.succeeded', updated, requestId, 'SUCCESS');
    return updated;
  }

  private static readonly ACTION_FAILURE_LABEL: Record<CandidateRecord['type'], string> = {
    TASK: 'Task action failed',
    MEMORY: 'Memory action failed',
    KNOWLEDGE: 'Knowledge action failed',
    CALENDAR: 'Calendar action failed',
  };

  private static readonly RETRY_LABEL: Record<CandidateRecord['type'], string> = {
    TASK: 'Retried task action',
    MEMORY: 'Retried memory action',
    KNOWLEDGE: 'Retried knowledge action',
    CALENDAR: 'Retried calendar action',
  };

  // Phase 1 STEP 9, item C/D — classifies the failure via the shared
  // taxonomy and records durable retry bookkeeping (attemptCount,
  // lastAttemptAt, lastErrorCode, nextRetryAt) separately from status —
  // never overloading CandidateActionStatus itself.
  private markFailed(candidate: CandidateRecord, errorCode: string, requestId: string): CandidateRecord {
    const classification = classifyFailure(errorCode);
    const now = new Date();
    const attemptCount = (candidate.action?.retry?.attemptCount ?? 0) + 1;
    const actionPatch: Partial<CandidateAction> = {
      status: 'FAILED',
      errorCode,
      category: classification.category,
      retryable: classification.retryable,
      retry: {
        attemptCount,
        lastAttemptAt: now.toISOString(),
        lastErrorCode: errorCode,
        nextRetryAt: classification.retryable ? computeNextRetryAt(attemptCount, now) : null,
      },
    };
    const updated = this.deps.candidateStore.updateAction(candidate.candidateId, candidate.tenantId, candidate.principalId, actionPatch, requestId);
    this.audit('candidate.action.failed', updated, requestId, 'FAILED');
    // Phase 1 STEP 8 (item Q): a truthful FAILED Activity item — the
    // candidate itself stays ACCEPTED (never REJECTED), only its action
    // failed, and this is what Home/Inbox/the Activity tab actually read.
    // AMBIGUOUS outcomes get their own distinct wording (item R/X) — never
    // presented as a plain retryable failure.
    const label = classification.category === 'AMBIGUOUS' ? 'Action outcome needs verification' : CandidateActionResolver.ACTION_FAILURE_LABEL[candidate.type];
    this.recordActivity(updated, 'FAILED', label);
    return updated;
  }

  // Phase 1 STEP 8 — writes the durable, tenant-isolated consumer Activity
  // projection. dedupeKey defaults to ties identity to the terminal action
  // lifecycle (item J of STEP 8), so a retried/replayed call overwrites
  // rather than duplicates; callers that need a per-attempt entry (retry
  // itself, item X of STEP 9) pass an explicit dedupeKey instead.
  private recordActivity(candidate: CandidateRecord, status: ActivityStatus, title: string, dedupeKey?: string): void {
    if (!this.deps.activityStore) return;
    this.deps.activityStore.record({
      tenantId: candidate.tenantId,
      principalId: candidate.principalId,
      type: `candidate.action.${candidate.type.toLowerCase()}`,
      title,
      status,
      source: {
        candidateId: candidate.candidateId,
        captureId: candidate.captureId,
        taskId: candidate.action?.targetType === 'TASK' ? candidate.action.targetId : undefined,
        approvalId: candidate.action?.approvalId,
        executionId: candidate.action?.executionId,
      },
      dedupeKey: dedupeKey ?? `${candidate.candidateId}:${status}`,
    });
  }

  // ─── TASK (item C) ───
  private executeTask(candidate: CandidateRecord, requestId: string): CandidateRecord {
    if (!this.deps.taskStore) return this.markFailed(candidate, 'TASK_STORE_NOT_CONFIGURED', requestId);
    this.audit('candidate.action.started', candidate, requestId, 'PENDING_APPROVAL');

    // Reconciliation-first (items J/P): a prior attempt may have created
    // the Task but crashed before the linkage write landed — never create
    // a second one.
    const existing = this.deps.taskStore.findByCandidateId(candidate.candidateId);
    if (existing) {
      const updated = this.markSucceeded(candidate, { targetType: 'TASK', targetId: existing.taskId }, requestId);
      this.recordActivity(updated, 'COMPLETED', `Created task "${existing.name}"`);
      return updated;
    }

    const payload = candidate.payload as TaskCandidatePayload;
    try {
      // dueAt is informational only — never silently turned into a
      // schedule/trigger/recurrence NAgex invents on the user's behalf
      // (item C: "Do not invent recurrence. Do not invent trigger type.").
      // The safest supported one-time representation is ONE_TIME/MANUAL.
      const objective = payload.dueAt
        ? `${payload.objective || payload.name} (due ${payload.dueAt})`
        : (payload.objective || payload.name);
      const task = this.deps.taskStore.create({
        tenantId: candidate.tenantId,
        ownerId: candidate.principalId,
        name: payload.name,
        objective,
        type: 'ONE_TIME',
        trigger: { type: 'MANUAL' },
        candidateId: candidate.candidateId,
      });
      const updated = this.markSucceeded(candidate, { targetType: 'TASK', targetId: task.taskId }, requestId);
      this.activity(`Created task "${task.name}"`, candidate, requestId);
      this.recordActivity(updated, 'COMPLETED', `Created task "${task.name}"`);
      return updated;
    } catch (err) {
      return this.markFailed(candidate, err instanceof NagexError ? err.code : 'TASK_CREATE_FAILED', requestId);
    }
  }

  // ─── MEMORY (item E) ───
  private executeMemory(candidate: CandidateRecord, requestId: string): CandidateRecord {
    if (!this.deps.memoryEngine) return this.markFailed(candidate, 'MEMORY_ENGINE_NOT_CONFIGURED', requestId);
    this.audit('candidate.action.started', candidate, requestId, 'PENDING_APPROVAL');
    const payload = candidate.payload as MemoryCandidatePayload;

    const existing = this.deps.memoryEngine.findByCandidateId(candidate.candidateId);
    if (existing) {
      const updated = this.markSucceeded(candidate, { targetType: 'MEMORY', targetId: existing.id }, requestId);
      this.recordActivity(updated, 'COMPLETED', `Remembered: ${payload.statement.slice(0, 60)}`);
      return updated;
    }

    try {
      // Only the exact reviewed/modified statement is ever written — never
      // re-derived from the original understanding output, never merged
      // with unrelated memory, never rewritten.
      const mem = this.deps.memoryEngine.proposeMemory('USER', candidate.principalId, {
        subject: 'user',
        predicate: 'preference',
        value: payload.statement,
      }, candidate.candidateId);
      this.deps.memoryEngine.activateMemory(mem.id);
      const updated = this.markSucceeded(candidate, { targetType: 'MEMORY', targetId: mem.id }, requestId);
      this.activity(`Remembered: ${payload.statement.slice(0, 60)}`, candidate, requestId);
      this.recordActivity(updated, 'COMPLETED', `Remembered: ${payload.statement.slice(0, 60)}`);
      return updated;
    } catch (err) {
      return this.markFailed(candidate, err instanceof NagexError ? err.code : 'MEMORY_WRITE_FAILED', requestId);
    }
  }

  // ─── KNOWLEDGE (item F) ───
  private executeKnowledge(candidate: CandidateRecord, requestId: string): CandidateRecord {
    if (!this.deps.knowledgeEngine) return this.markFailed(candidate, 'KNOWLEDGE_ENGINE_NOT_CONFIGURED', requestId);
    this.audit('candidate.action.started', candidate, requestId, 'PENDING_APPROVAL');
    const payload = candidate.payload as KnowledgeCandidatePayload;

    const existing = this.deps.knowledgeEngine.findByCandidateId(candidate.candidateId);
    if (existing) {
      const updated = this.markSucceeded(candidate, { targetType: 'KNOWLEDGE', targetId: existing.document_id }, requestId);
      this.recordActivity(updated, 'COMPLETED', `Added "${payload.title}" to knowledge`);
      return updated;
    }

    try {
      const doc = this.deps.knowledgeEngine.addDocument({
        source_id: candidate.captureId,
        title: payload.title,
        classification: 'INTERNAL',
        content: payload.summary || payload.title,
        candidateId: candidate.candidateId,
        contentHash: candidate.contentHash,
        sourceRefs: candidate.sourceRefs,
      });
      const updated = this.markSucceeded(candidate, { targetType: 'KNOWLEDGE', targetId: doc.document_id }, requestId);
      this.activity(`Added "${payload.title}" to knowledge`, candidate, requestId);
      this.recordActivity(updated, 'COMPLETED', `Added "${payload.title}" to knowledge`);
      return updated;
    } catch (err) {
      return this.markFailed(candidate, err instanceof NagexError ? err.code : 'KNOWLEDGE_INDEX_FAILED', requestId);
    }
  }

  // ─── CALENDAR (item D — the two-gate flow; item M — the strictest retry path) ───
  private buildCalendarPayload(candidate: CandidateRecord, requestId: string): CalendarEventPayload {
    const p = candidate.payload as CalendarCandidatePayload;
    if (!p.start || !p.end || !p.timezone) {
      throw new NagexError({
        code: 'CANDIDATE_CALENDAR_INCOMPLETE',
        category: 'VALIDATION',
        message: 'This calendar candidate is missing a start, end, or timezone and cannot be scheduled — modify it (while still PROPOSED) or reject it.',
        request_id: requestId,
      });
    }
    return {
      calendarId: 'primary',
      summary: p.summary,
      description: '',
      start: p.start,
      end: p.end,
      timezone: p.timezone,
      attendees: p.attendees || [],
    };
  }

  private requestCalendarApproval(candidate: CandidateRecord, requestId: string): CandidateRecord {
    let payload: CalendarEventPayload;
    try {
      payload = this.buildCalendarPayload(candidate, requestId);
    } catch (err) {
      return this.markFailed(candidate, err instanceof NagexError ? err.code : 'CALENDAR_PAYLOAD_INVALID', requestId);
    }
    this.audit('candidate.action.started', candidate, requestId, 'PENDING_APPROVAL');
    try {
      const approval = this.deps.calendarService!.requestCreateEventApproval({ tenantId: candidate.tenantId, principalId: candidate.principalId, payload, requestId });
      const updated = this.deps.candidateStore.updateAction(candidate.candidateId, candidate.tenantId, candidate.principalId, {
        status: 'PENDING_APPROVAL', targetType: 'CALENDAR', approvalId: approval.approvalId, errorCode: undefined, category: undefined, retryable: undefined,
      }, requestId);
      this.audit('candidate.action.approval_required', updated, requestId, 'PENDING_APPROVAL');
      return updated;
    } catch (err) {
      return this.markFailed(candidate, err instanceof NagexError ? err.code : 'CALENDAR_APPROVAL_REQUEST_FAILED', requestId);
    }
  }

  private async executeCalendar(candidate: CandidateRecord, requestId: string): Promise<CandidateRecord> {
    if (!this.deps.calendarService) return this.markFailed(candidate, 'CALENDAR_SERVICE_NOT_CONFIGURED', requestId);
    const summary = (candidate.payload as CalendarCandidatePayload).summary;

    // Gate 2, step 1: no Action Approval requested yet for this candidate —
    // Candidate Review (ACCEPT) alone never reaches Google (item D/M —
    // Korean note: 후보 승인 ≠ 실행 승인).
    if (!candidate.action?.approvalId) {
      return this.requestCalendarApproval(candidate, requestId);
    }

    // Gate 2, step 2+: an Action Approval already exists for this candidate
    // — advance based on ITS real, live status. Never request a second one
    // while this one is still meaningful (item I: one attempt chain only).
    const approval = this.deps.calendarService.getApproval(candidate.action.approvalId);
    if (!approval) return this.markFailed(candidate, 'CALENDAR_APPROVAL_NOT_FOUND', requestId);

    if (approval.status === 'PENDING') {
      return candidate; // still waiting on the user — nothing to do
    }
    if (approval.status === 'REJECTED') {
      // The Action Approval was declined — the candidate itself stays
      // ACCEPTED (item O of STEP 7); only its action is FAILED.
      return this.markFailed(candidate, 'CALENDAR_APPROVAL_REJECTED', requestId);
    }
    if (approval.status === 'EXPIRED') {
      // STEP 9, item M case 2: expired ≠ consumed — nothing ever reached
      // Google through this approval, so requesting a fresh one is safe
      // (never a terminal dead end just because the review window lapsed).
      const cleared = this.deps.candidateStore.updateAction(candidate.candidateId, candidate.tenantId, candidate.principalId, { approvalId: undefined }, requestId);
      return this.requestCalendarApproval(cleared, requestId);
    }
    if (approval.status === 'CONSUMED') {
      // Already used by SOME execution attempt (possibly this resolver,
      // possibly a generic /api/v1/tools/google-calendar/create-event call)
      // — reconcile against the real recorded outcome rather than guessing
      // or re-attempting (item M cases 3-5).
      const execution = approval.executionId && this.deps.executionStore ? this.deps.executionStore.get(approval.executionId) : null;
      if (execution && execution.status === 'SUCCEEDED' && execution.externalId) {
        const updated = this.markSucceeded(candidate, {
          targetType: 'CALENDAR', targetId: execution.externalId, executionId: execution.executionId, externalUrl: execution.externalUrl || undefined,
        }, requestId);
        this.activity(`Added "${summary}" to Google Calendar`, candidate, requestId);
        this.recordActivity(updated, 'COMPLETED', `Added "${summary}" to Google Calendar`);
        return updated;
      }
      // Consumed but not confirmed successful — the real outcome is unknown
      // and must never be guessed at (item M case 5, item Z).
      return this.markFailed(candidate, 'CANDIDATE_ACTION_RECONCILE_REQUIRED', requestId);
    }

    // approval.status === 'APPROVED' — this call is the one that actually
    // reaches Google.
    this.deps.candidateStore.updateAction(candidate.candidateId, candidate.tenantId, candidate.principalId, { status: 'RUNNING' }, requestId);
    try {
      const payload = this.buildCalendarPayload(candidate, requestId);
      const result = await this.deps.calendarService.executeCreateEvent({ approvalId: candidate.action.approvalId, payload, tenantId: candidate.tenantId, principalId: candidate.principalId, requestId });
      const updated = this.markSucceeded(candidate, {
        targetType: 'CALENDAR', targetId: result.externalId, executionId: result.executionId, externalUrl: result.externalUrl,
      }, requestId);
      this.activity(`Added "${summary}" to Google Calendar`, candidate, requestId);
      this.recordActivity(updated, 'COMPLETED', `Added "${summary}" to Google Calendar`);
      return updated;
    } catch (err) {
      const code = err instanceof NagexError ? err.code : 'CALENDAR_EXECUTION_FAILED';
      // The approval may have already been consumed by this very attempt
      // right before the Google call itself failed — from here on, the real
      // external outcome cannot be safely assumed either way (item M case 6).
      const reconcileNeeded = code === 'APPROVAL_ALREADY_CONSUMED';
      return this.markFailed(candidate, reconcileNeeded ? 'CANDIDATE_ACTION_RECONCILE_REQUIRED' : code, requestId);
    }
  }
}

export type { FailureCategory };
