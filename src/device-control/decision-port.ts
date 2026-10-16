// DecisionPort - an OPTIONAL, REPLACEABLE, ADVISORY second opinion for the device loop (canonical AI/Decision architecture §9-§10: a candidate DecisionProvider; never an authority).
//
// What it may do, by construction:
//   * look only at a STRUCTURAL description of the next step - enumerated kinds, numbers, outcome categories. There is no free-text field in a request: the goal, the page, the typed text, names of
//     controls and addresses cannot be sent to a decision provider because the request type has nowhere to put them;
//   * answer with a small, validated NAgex-internal shape (recommendedActionId, actionConfidence, riskProbability/riskEscalation, retryRecommendation, completionAssessment, decisionReasonCode);
//   * TIGHTEN: ask for an approval before a click, or hand the task to the person. That is all.
// What it can never do: allow something the deterministic policy denied (it is consulted only AFTER the hard checks, about an action that already passed them), approve anything, skip an approval,
// widen a domain, read a credential. A failure, a timeout, a malformed or inconsistent answer is "no advice": the loop goes on exactly as it would without a provider.
import type { ProposedDeviceAction } from './device-action.types.js';

export type AdvisedActionId = 'PROCEED' | 'OBSERVE' | 'WAIT' | 'HANDOFF';
export const ADVISED_ACTION_IDS: readonly AdvisedActionId[] = ['PROCEED', 'OBSERVE', 'WAIT', 'HANDOFF'];
export type RetryRecommendation = 'CONTINUE' | 'RETRY' | 'ABORT' | 'TAKEOVER';
export const RETRY_RECOMMENDATIONS: readonly RetryRecommendation[] = ['CONTINUE', 'RETRY', 'ABORT', 'TAKEOVER'];
export type CompletionAssessment = 'COMPLETE' | 'INCOMPLETE' | 'UNKNOWN';
export const COMPLETION_ASSESSMENTS: readonly CompletionAssessment[] = ['COMPLETE', 'INCOMPLETE', 'UNKNOWN'];
export type DecisionReasonCode = 'ROUTINE' | 'LOW_CONFIDENCE' | 'HIGH_RISK' | 'LOOP_SUSPECTED' | 'GOAL_NOT_MET' | 'OTHER';
export const DECISION_REASON_CODES: readonly DecisionReasonCode[] = ['ROUTINE', 'LOW_CONFIDENCE', 'HIGH_RISK', 'LOOP_SUSPECTED', 'GOAL_NOT_MET', 'OTHER'];
export type RecentOutcome = 'VERIFIED' | 'NOT_VERIFIED' | 'FAILED' | 'NONE' | 'USER_ACTION_REQUIRED';

/** the probability above which advice counts as "treat this as more risky"; and the confidence needed before advice may hand the task to a person */
export const RISK_ESCALATION_THRESHOLD = 0.7;
export const HANDOFF_CONFIDENCE_THRESHOLD = 0.8;

export interface DecisionRequest {
  stepNumber: number;
  remainingSteps: number;
  proposed: { action: ProposedDeviceAction['action']; targetRole: string | null; formControl: boolean };
  /** the choices a decision may name; always contains PROCEED (the proposed action as it is) */
  candidates: AdvisedActionId[];
  recent: Array<{ action: string; outcome: RecentOutcome }>;
  repeats: number;
  expectationsMet: number;
  expectationsNotMet: number;
}

export interface DecisionAdvice {
  recommendedActionId: AdvisedActionId;
  actionConfidence: number;
  riskProbability: number | null;
  riskEscalation: boolean;
  retryRecommendation: RetryRecommendation;
  completionAssessment: CompletionAssessment;
  decisionReasonCode: DecisionReasonCode;
}

/** A provider. It answers with whatever it has; NAgex validates (normalizeAdvice) - nothing a provider returns is trusted as it is. */
export interface DecisionPort {
  readonly provider: string;
  configured(): boolean;
  advise(request: DecisionRequest, signal: AbortSignal): Promise<unknown>;
}

const isOneOf = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === 'string' && (list as readonly string[]).includes(value);
const unit = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null);

export type NormalizedAdvice = { ok: true; advice: DecisionAdvice } | { ok: false; reason: 'NOT_AN_OBJECT' | 'UNKNOWN_ACTION_ID' | 'ACTION_NOT_OFFERED' | 'BAD_CONFIDENCE' | 'BAD_RISK' | 'BAD_RETRY' | 'BAD_COMPLETION' | 'BAD_REASON' | 'INCONSISTENT' };

/** Accept only what makes sense: a known id that was actually offered, numbers in range, known enumerations, and no self-contradiction. Anything else is rejected whole. */
export function normalizeAdvice(raw: unknown, request: DecisionRequest): NormalizedAdvice {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'NOT_AN_OBJECT' };
  const r = raw as Record<string, unknown>;
  if (!isOneOf(ADVISED_ACTION_IDS, r.recommendedActionId)) return { ok: false, reason: 'UNKNOWN_ACTION_ID' };
  if (!request.candidates.includes(r.recommendedActionId)) return { ok: false, reason: 'ACTION_NOT_OFFERED' };
  const confidence = unit(r.actionConfidence);
  if (confidence === null) return { ok: false, reason: 'BAD_CONFIDENCE' };
  const risk = r.riskProbability === null || r.riskProbability === undefined ? null : unit(r.riskProbability);
  if (r.riskProbability !== null && r.riskProbability !== undefined && risk === null) return { ok: false, reason: 'BAD_RISK' };
  if (!isOneOf(RETRY_RECOMMENDATIONS, r.retryRecommendation)) return { ok: false, reason: 'BAD_RETRY' };
  if (!isOneOf(COMPLETION_ASSESSMENTS, r.completionAssessment)) return { ok: false, reason: 'BAD_COMPLETION' };
  if (!isOneOf(DECISION_REASON_CODES, r.decisionReasonCode)) return { ok: false, reason: 'BAD_REASON' };
  // handing the task to a person while saying "carry on" is not an answer
  if (r.recommendedActionId === 'HANDOFF' && r.retryRecommendation === 'CONTINUE') return { ok: false, reason: 'INCONSISTENT' };
  if (r.recommendedActionId === 'PROCEED' && (r.retryRecommendation === 'ABORT' || r.retryRecommendation === 'TAKEOVER') && confidence >= HANDOFF_CONFIDENCE_THRESHOLD) return { ok: false, reason: 'INCONSISTENT' };
  return {
    ok: true,
    advice: {
      recommendedActionId: r.recommendedActionId,
      actionConfidence: confidence,
      riskProbability: risk,
      riskEscalation: risk !== null && risk >= RISK_ESCALATION_THRESHOLD,
      retryRecommendation: r.retryRecommendation,
      completionAssessment: r.completionAssessment,
      decisionReasonCode: r.decisionReasonCode,
    },
  };
}

export type AdvisoryStatus = 'DISABLED' | 'OK' | 'UNAVAILABLE' | 'INVALID' | 'CIRCUIT_OPEN';

/**
 * Calls a provider within a short deadline, validates what comes back, and gives up on it for the rest of a session after repeated failures (the loop is never slowed by a provider that is down).
 * With no provider - or one without credentials - it is simply DISABLED and nothing is called.
 */
export class DecisionAdvisor {
  private readonly failures = new Map<string, number>();
  private readonly timeoutMs: number;
  private readonly maxConsecutiveFailures: number;

  constructor(private readonly port: DecisionPort | null, options: { timeoutMs?: number; maxConsecutiveFailures?: number } = {}) {
    this.timeoutMs = options.timeoutMs ?? 2500;
    this.maxConsecutiveFailures = options.maxConsecutiveFailures ?? 2;
  }

  public get enabled(): boolean {
    return Boolean(this.port && this.port.configured());
  }

  public get provider(): string {
    return this.port?.provider ?? 'none';
  }

  public forget(sessionKey: string): void {
    this.failures.delete(sessionKey);
  }

  public async consult(sessionKey: string, request: DecisionRequest): Promise<{ status: AdvisoryStatus; advice: DecisionAdvice | null }> {
    if (!this.port || !this.port.configured()) return { status: 'DISABLED', advice: null };
    if ((this.failures.get(sessionKey) ?? 0) >= this.maxConsecutiveFailures) return { status: 'CIRCUIT_OPEN', advice: null };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const raw = await Promise.race([
        this.port.advise(request, controller.signal),
        new Promise<never>((_, reject) => { controller.signal.addEventListener('abort', () => reject(new Error('DECISION_TIMEOUT'))); }),
      ]);
      const normalized = normalizeAdvice(raw, request);
      if (!normalized.ok) { this.failures.set(sessionKey, (this.failures.get(sessionKey) ?? 0) + 1); return { status: 'INVALID', advice: null }; }
      this.failures.delete(sessionKey);
      return { status: 'OK', advice: normalized.advice };
    } catch {
      this.failures.set(sessionKey, (this.failures.get(sessionKey) ?? 0) + 1);
      return { status: 'UNAVAILABLE', advice: null };
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface AdvisoryEffect {
  /** the click is held for the person's approval even though the deterministic policy did not require one */
  forceApproval: boolean;
  /** the task is handed to the person instead of going on */
  handoff: boolean;
}

export const NO_ADVISORY_EFFECT: AdvisoryEffect = Object.freeze({ forceApproval: false, handoff: false });

/**
 * What advice may change. Every effect here ADDS caution; there is no field that removes a check, and no input that can: a "proceed" with full confidence changes nothing at all, and advice
 * about an action the policy would refuse is never asked for (the provider is consulted only after the hard checks passed).
 */
export function advisoryEffect(advice: DecisionAdvice | null, proposed: ProposedDeviceAction): AdvisoryEffect {
  if (!advice) return NO_ADVISORY_EFFECT;
  const handoff = advice.actionConfidence >= HANDOFF_CONFIDENCE_THRESHOLD
    && (advice.recommendedActionId === 'HANDOFF' || advice.retryRecommendation === 'TAKEOVER' || advice.retryRecommendation === 'ABORT');
  const forceApproval = proposed.action === 'CLICK' && advice.riskEscalation;
  return handoff || forceApproval ? { forceApproval, handoff } : NO_ADVISORY_EFFECT;
}
