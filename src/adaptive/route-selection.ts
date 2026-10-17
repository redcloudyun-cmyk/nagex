// ROUTE SELECTION: the DETERMINISTIC part. Hard eligibility first (what a route may NOT be, whatever anyone recommends), then a stable, explainable ranking of what is left.
//
// Order of authority, in this file and everywhere that uses it:
//   1. hard eligibility (configured, authenticated, available, within quota, compatible input, sensitivity ceiling, spending ceiling, not already tried, fallback not forbidden by the failure class);
//   2. deterministic ranking of the eligible set (terms unchanged first, then known cost, then reliability evidence, then latency, then a stable id);
//   3. an advisory ranking (e.g. JEV) that may only REORDER or SLOW DOWN the eligible set - it can add nothing and remove no check (see route-advisor.ts).
// A route that fails (1) cannot become eligible by being recommended.
import type { FailureClassification } from './failure-taxonomy.js';
import { sensitivityAtMost, type GoalNeeds, type RouteCandidate, type StandingAuthorization } from './route-candidate.js';
import { coveredByStandingAuthorization, diffTerms, isMaterial, type TermChange } from './route-terms.js';

export type IneligibleReason =
  | 'SAME_AS_FAILED_ROUTE'
  | 'ALREADY_ATTEMPTED'
  | 'NOT_CONFIGURED'
  | 'AUTH_REJECTED'
  | 'UNAVAILABLE'
  | 'QUOTA_EXHAUSTED_RECENTLY'
  | 'INPUT_INCOMPATIBLE'
  | 'SENSITIVITY_EXCEEDS_ROUTE'
  | 'COST_OVER_AUTHORIZED_LIMIT'
  | 'COST_NOT_AUTHORIZED'
  | 'FALLBACK_FORBIDDEN_BY_FAILURE'
  | 'FALLBACK_NEEDS_RECONCILIATION';

export interface Rejection { routeId: string; provider: string; label: string; reasons: IneligibleReason[] }

export interface RankedCandidate {
  candidate: RouteCandidate;
  changes: TermChange[];
  /** a person's decision is needed before the work moves here */
  material: boolean;
  /** an explicit standing authorization already covers every change */
  coveredByStanding: boolean;
  factors: { termsUnchanged: boolean; costUsd: number | null; successRatio: number | null; medianLatencyMs: number | null };
  rank: number;
}

export interface SelectionInput {
  needs: GoalNeeds;
  failure: FailureClassification | null;
  /** the route that just failed (its terms are the baseline for "what changes") */
  failedRoute: RouteCandidate | null;
  attemptedRouteIds: string[];
  candidates: RouteCandidate[];
  standing?: StandingAuthorization[];
  /** how long a route stays out after its quota was seen exhausted */
  quotaCooldownMs?: number;
  now?: () => number;
}

export const QUOTA_COOLDOWN_MS = 15 * 60_000;
/** a reliability record with fewer samples than this says nothing */
export const MIN_RELIABILITY_SAMPLES = 3;

function inputCompatible(needs: GoalNeeds, route: RouteCandidate): boolean {
  if (route.capability !== needs.capability) return false;
  for (const input of needs.inputs) if (!route.inputs.includes(input)) return false;
  if (needs.aspectRatio && route.limits.aspectRatios && route.limits.aspectRatios.length > 0 && !route.limits.aspectRatios.includes(needs.aspectRatio)) return false;
  if ((needs.referenceImages ?? 0) > (route.limits.maxReferenceImages ?? 0)) return false;
  return true;
}

function quotaRecentlyExhausted(route: RouteCandidate, cooldownMs: number, now: number): boolean {
  if (route.quota === 'EXHAUSTED') return true;
  if (!route.quotaExhaustedAt) return false;
  const at = Date.parse(route.quotaExhaustedAt);
  return Number.isFinite(at) && now - at < cooldownMs;
}

export function eligibilityOf(route: RouteCandidate, input: SelectionInput): IneligibleReason[] {
  const now = (input.now ?? Date.now)();
  const reasons: IneligibleReason[] = [];
  if (input.failedRoute && route.routeId === input.failedRoute.routeId) reasons.push('SAME_AS_FAILED_ROUTE');
  else if (input.attemptedRouteIds.includes(route.routeId)) reasons.push('ALREADY_ATTEMPTED');
  if (route.auth === 'UNCONFIGURED') reasons.push('NOT_CONFIGURED');
  if (route.auth === 'REJECTED') reasons.push('AUTH_REJECTED');
  if (route.availability === 'UNAVAILABLE') reasons.push('UNAVAILABLE');
  if (quotaRecentlyExhausted(route, input.quotaCooldownMs ?? QUOTA_COOLDOWN_MS, now)) reasons.push('QUOTA_EXHAUSTED_RECENTLY');
  if (!inputCompatible(input.needs, route)) reasons.push('INPUT_INCOMPATIBLE');
  if (!sensitivityAtMost(input.needs.sensitivity, route.dataHandling.maxSensitivity)) reasons.push('SENSITIVITY_EXCEEDS_ROUTE');
  // money: a known price above the authorized ceiling, or any price at all when nothing beyond free use is authorized and the price is not known to be zero
  const limit = input.needs.maxCostUsd;
  if (route.cost.usd !== null && !route.cost.unknown) {
    if (limit !== null && route.cost.usd > limit + 0.0001) reasons.push('COST_OVER_AUTHORIZED_LIMIT');
  }
  if (input.failure?.fallback === 'FORBIDDEN') reasons.push('FALLBACK_FORBIDDEN_BY_FAILURE');
  if (input.failure?.fallback === 'AFTER_RECONCILIATION') reasons.push('FALLBACK_NEEDS_RECONCILIATION');
  return reasons;
}

function successRatio(route: RouteCandidate): number | null {
  const r = route.reliability;
  if (!r) return null;
  const total = r.successes + r.failures;
  return total >= MIN_RELIABILITY_SAMPLES ? r.successes / total : null;
}

export function selectRoutes(input: SelectionInput): { eligible: RankedCandidate[]; rejected: Rejection[] } {
  const rejected: Rejection[] = [];
  const kept: Array<Omit<RankedCandidate, 'rank'>> = [];
  for (const candidate of input.candidates) {
    const reasons = eligibilityOf(candidate, input);
    if (reasons.length > 0) { rejected.push({ routeId: candidate.routeId, provider: candidate.provider, label: candidate.label, reasons }); continue; }
    const changes = diffTerms(input.failedRoute, candidate);
    kept.push({
      candidate, changes, material: isMaterial(changes), coveredByStanding: isMaterial(changes) && coveredByStandingAuthorization(changes, candidate, input.standing),
      factors: { termsUnchanged: changes.length === 0, costUsd: candidate.cost.unknown ? null : candidate.cost.usd, successRatio: successRatio(candidate), medianLatencyMs: candidate.reliability?.medianLatencyMs ?? null },
    });
  }
  kept.sort((a, b) => {
    if (a.factors.termsUnchanged !== b.factors.termsUnchanged) return a.factors.termsUnchanged ? -1 : 1;
    // a known price beats an unknown one; among known prices, the lower
    const ca = a.factors.costUsd; const cb = b.factors.costUsd;
    if ((ca === null) !== (cb === null)) return ca === null ? 1 : -1;
    if (ca !== null && cb !== null && Math.abs(ca - cb) > 0.0001) return ca - cb;
    // measured reliability, only where there is enough of it to mean something
    const ra = a.factors.successRatio; const rb = b.factors.successRatio;
    if ((ra === null) !== (rb === null)) return ra === null ? 1 : -1;
    if (ra !== null && rb !== null && Math.abs(ra - rb) > 0.0001) return rb - ra;
    const la = a.factors.medianLatencyMs; const lb = b.factors.medianLatencyMs;
    if ((la === null) !== (lb === null)) return la === null ? 1 : -1;
    if (la !== null && lb !== null && la !== lb) return la - lb;
    return a.candidate.routeId < b.candidate.routeId ? -1 : a.candidate.routeId > b.candidate.routeId ? 1 : 0;
  });
  return { eligible: kept.map((item, index) => ({ ...item, rank: index + 1 })), rejected };
}
