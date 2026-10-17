// THE RECOVERY PLANNER: after a failure, what happens next toward the person's GOAL?
//
// It is a pure decision function over facts (the normalized failure, the route history, a snapshot of the candidate routes). It executes nothing, asks for nothing and approves nothing; the caller (a
// state machine that already exists - the Product Builder, the video job service ...) carries out the decision through its own approval and execution paths. There is no second agent runtime here.
//
//   failure -> classify -> budget? -> reconcile? -> denied? -> retry the same route? -> look for another route:
//     hard eligibility (deterministic) -> deterministic ranking -> OPTIONAL advisory ranking (reorder / ask the person, nothing more) -> does the switch change material terms? -> approval or automatic
//
// Bounded by construction: a goal has a total attempt budget, a switch budget and a per-route retry allowance; when they run out the decision is ABORT, never "try again".
import { classifyFailure, type FailureClassification, type FailureEvidence } from './failure-taxonomy.js';
import { adviceEffect, buildAdviceRequest, type RouteAdvice, type RouteAdvisor } from './route-advisor.js';
import type { GoalNeeds, RouteCandidate, StandingAuthorization } from './route-candidate.js';
import { selectRoutes, type RankedCandidate, type Rejection } from './route-selection.js';

export interface AdaptiveBudget {
  /** all attempts of the goal, whatever the route */
  maxAttempts: number;
  /** how many times the work may move to a different route */
  maxSwitches: number;
  /** repeats of one route after a retryable failure */
  maxRetriesPerRoute: number;
}
export const DEFAULT_BUDGET: AdaptiveBudget = Object.freeze({ maxAttempts: 6, maxSwitches: 3, maxRetriesPerRoute: 1 });

/** The part of the history the planner reasons over (the persistent history holds more). */
export interface AttemptSummary { routeId: string; outcome: 'SUCCEEDED' | 'FAILED' | 'RETRYING' | 'DECLINED' | 'SKIPPED' | 'AWAITING_APPROVAL' | 'APPROVED'; failureClass: string | null }

export type Reconciliation = 'NOT_NEEDED' | 'CONFIRMED_NOT_STARTED' | 'CONFIRMED_STARTED';

export interface PlanInput {
  needs: GoalNeeds;
  failedRoute: RouteCandidate | null;
  failure: FailureEvidence;
  attempts: AttemptSummary[];
  candidates: RouteCandidate[];
  standing?: StandingAuthorization[];
  budget?: AdaptiveBudget;
  reconciliation?: Reconciliation;
  now?: () => number;
}

export type RankedBy = 'DETERMINISTIC' | 'ADVISOR' | 'DETERMINISTIC_FALLBACK';
export type AbortReason = 'PERMISSION_DENIED' | 'BUDGET_EXHAUSTED' | 'NO_AUTHORIZED_ROUTE' | 'OUTCOME_CONFIRMED_STARTED';

export interface MissingCapability { provider: string; label: string; reasons: string[] }

export type RecoveryDecision =
  | { action: 'RETRY_SAME_ROUTE'; afterMs: number; classification: FailureClassification }
  | { action: 'RECONCILE_FIRST'; classification: FailureClassification }
  | { action: 'ABORT'; reason: AbortReason; classification: FailureClassification; rejected: Rejection[]; missing: MissingCapability[] }
  | {
      action: 'SWITCH_ROUTE' | 'ASK_PERSON';
      /** the route the planner would use first */
      route: RankedCandidate;
      /** every eligible route, in order: the person may choose any of them */
      options: RankedCandidate[];
      /** the person's decision is required before the work moves (a material change in terms, or the advisor recommends asking) */
      requiresApproval: boolean;
      rankedBy: RankedBy;
      advice: { provider: string; effect: string; confidence: number } | null;
      classification: FailureClassification;
      rejected: Rejection[];
    };

const DEFAULT_RETRY_DELAY_MS = 1_500;

export class RecoveryPlanner {
  constructor(private readonly deps: { advisor?: RouteAdvisor | null } = {}) {}

  public async plan(input: PlanInput): Promise<RecoveryDecision> {
    const budget = input.budget ?? DEFAULT_BUDGET;
    const classification = classifyFailure(input.failure);
    const failedAttempts = input.attempts.filter((a) => a.outcome === 'FAILED' || a.outcome === 'RETRYING');
    const empty = { rejected: [] as Rejection[], missing: [] as MissingCapability[] };

    // 1. a denial is the answer: no other route is looked for
    if (classification.failureClass === 'PERMISSION_DENIED') return { action: 'ABORT', reason: 'PERMISSION_DENIED', classification, ...empty };

    // 2. the outcome of a chargeable / consequential operation is not known: nothing is repeated, nothing is started elsewhere, until it is reconciled
    if (classification.failureClass === 'UNKNOWN_OUTCOME') {
      if (input.reconciliation === 'CONFIRMED_STARTED') return { action: 'ABORT', reason: 'OUTCOME_CONFIRMED_STARTED', classification, ...empty };
      if (input.reconciliation !== 'CONFIRMED_NOT_STARTED') return { action: 'RECONCILE_FIRST', classification };
    }

    // 3. the budget is the budget
    const switches = new Set(input.attempts.map((a) => a.routeId)).size - 1;
    if (input.attempts.length >= budget.maxAttempts || switches >= budget.maxSwitches) return { action: 'ABORT', reason: 'BUDGET_EXHAUSTED', classification, ...empty };

    // 4. the same route again - only for the classes that allow it, only with the documented or a short delay, only within the per-route allowance
    const failedId = input.failedRoute?.routeId ?? null;
    const retriesOnThisRoute = failedId ? input.attempts.filter((a) => a.routeId === failedId && a.outcome === 'RETRYING').length : 0;
    if (classification.retry !== 'NEVER' && failedId && retriesOnThisRoute < budget.maxRetriesPerRoute && failedAttempts.length < budget.maxAttempts) {
      return { action: 'RETRY_SAME_ROUTE', afterMs: classification.retryAfterMs ?? DEFAULT_RETRY_DELAY_MS, classification };
    }

    // 5. another route: hard eligibility, then a deterministic order
    const tried = Array.from(new Set(input.attempts.map((a) => a.routeId)));
    const selection = selectRoutes({
      needs: input.needs, failure: classification.failureClass === 'UNKNOWN_OUTCOME' ? { ...classification, fallback: 'ALLOWED' } : classification,
      failedRoute: input.failedRoute, attemptedRouteIds: tried, candidates: input.candidates, standing: input.standing, now: input.now,
    });
    if (selection.eligible.length === 0) {
      const missing: MissingCapability[] = selection.rejected
        .filter((r) => r.reasons.some((x) => x === 'NOT_CONFIGURED' || x === 'AUTH_REJECTED' || x === 'QUOTA_EXHAUSTED_RECENTLY' || x === 'UNAVAILABLE'))
        .map((r) => ({ provider: r.provider, label: r.label, reasons: r.reasons }));
      return { action: 'ABORT', reason: 'NO_AUTHORIZED_ROUTE', classification, rejected: selection.rejected, missing };
    }

    // 6. an OPTIONAL advisory ranking: it may reorder the eligible set or ask for the person; it cannot add, remove or approve
    let eligible = selection.eligible;
    let rankedBy: RankedBy = 'DETERMINISTIC';
    let advice: RouteAdvice | null = null;
    let adviceSummary: { provider: string; effect: string; confidence: number } | null = null;
    let askBecauseOfAdvice = false;
    const advisor = this.deps.advisor ?? null;
    if (advisor) {
      if (!advisor.available()) rankedBy = 'DETERMINISTIC_FALLBACK';
      else {
        advice = await advisor.advise(buildAdviceRequest({ capability: input.needs.capability, failureClass: classification.failureClass, attemptsSoFar: input.attempts.length, attemptsRemaining: Math.max(0, budget.maxAttempts - input.attempts.length), eligible }));
        const effect = adviceEffect(advice);
        if (!advice) rankedBy = 'DETERMINISTIC_FALLBACK';
        else {
          adviceSummary = { provider: advice.provider, effect: effect.kind, confidence: advice.confidence };
          if (effect.kind === 'REORDER') {
            const chosen = eligible.find((c) => c.candidate.routeId === effect.routeId);
            if (chosen) { eligible = [chosen, ...eligible.filter((c) => c !== chosen)].map((c, i) => ({ ...c, rank: i + 1 })); rankedBy = 'ADVISOR'; }
          } else if (effect.kind === 'ASK_PERSON') askBecauseOfAdvice = true;
        }
      }
    }
    const top = eligible[0];
    const requiresApproval = askBecauseOfAdvice || (top.material && !top.coveredByStanding);
    return {
      action: askBecauseOfAdvice ? 'ASK_PERSON' : 'SWITCH_ROUTE',
      route: top, options: eligible, requiresApproval, rankedBy, advice: adviceSummary, classification, rejected: selection.rejected,
    };
  }
}
