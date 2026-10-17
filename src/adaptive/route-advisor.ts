// The ADVISORY ranking of routes. A decision provider (JEV, or any other) may be asked which of the ALREADY-ELIGIBLE routes it would try first, or whether to stop and ask the person. It is one
// replaceable provider behind a port; NAgex's own types, validation and limits live here and do not know any vendor exists.
//
// What advice can do - and nothing else:
//   * REORDER the eligible set (put its recommended route first) when it is confident enough;
//   * SLOW THINGS DOWN: a confident "ask the person" / "abort" recommendation turns an automatic step into a question for the person.
// What advice can NOT do: add a route, make an ineligible route eligible, remove a hard check, remove the need for approval when terms change, approve, pay, consent for a third party, or reach a credential.
// An answer that names a route that was not offered, a confidence outside 0..1, or anything that does not parse is NO advice (the deterministic order stands). A provider that is slow, down or wrong is
// given up on for the rest of the process after a few failures: JEV is optional and never a single point of failure.
import type { CapabilityKind } from './route-candidate.js';
import type { FailureClass } from './failure-taxonomy.js';
import type { TermChangeKind } from './route-terms.js';
import type { RankedCandidate } from './route-selection.js';

export const ADVICE_MIN_CONFIDENCE_TO_REORDER = 0.6;
export const ADVICE_MIN_CONFIDENCE_TO_ASK = 0.8;

export type CostBucket = 'ZERO' | 'KNOWN_LOW' | 'KNOWN_HIGH' | 'UNKNOWN';
export type ReliabilityBucket = 'NO_DATA' | 'GOOD' | 'MIXED' | 'POOR';
export type LatencyBucket = 'UNKNOWN' | 'FAST' | 'MEDIUM' | 'SLOW';

/** All a decision provider is ever told. Enumerated facts only: there is no field for the goal text, a prompt, a name, an address or any content. */
export interface RouteAdviceRequest {
  capability: CapabilityKind;
  failureClass: FailureClass;
  attemptsSoFar: number;
  attemptsRemaining: number;
  candidates: Array<{
    routeId: string;
    provider: string;
    vendorId: string;
    costBucket: CostBucket;
    reliability: ReliabilityBucket;
    latency: LatencyBucket;
    changes: TermChangeKind[];
    deterministicRank: number;
  }>;
}

export type RouteRecommendation = { kind: 'ROUTE'; routeId: string } | { kind: 'ABORT' } | { kind: 'ASK_PERSON' };
export interface RouteAdvice { recommendation: RouteRecommendation; confidence: number; provider: string }

export interface RouteAdvisorPort {
  readonly provider: string;
  configured(): boolean;
  /** returns the provider's raw answer mapped onto { recommendedRouteId, confidence }; RouteAdvisor validates it whole */
  advise(request: RouteAdviceRequest, signal: AbortSignal): Promise<unknown>;
}

function costBucket(c: RankedCandidate): CostBucket {
  const usd = c.factors.costUsd;
  if (usd === null) return 'UNKNOWN';
  if (usd <= 0.0001) return 'ZERO';
  return usd <= 0.1 ? 'KNOWN_LOW' : 'KNOWN_HIGH';
}
function reliabilityBucket(c: RankedCandidate): ReliabilityBucket {
  const r = c.factors.successRatio;
  if (r === null) return 'NO_DATA';
  return r >= 0.8 ? 'GOOD' : r >= 0.5 ? 'MIXED' : 'POOR';
}
function latencyBucket(c: RankedCandidate): LatencyBucket {
  const l = c.factors.medianLatencyMs;
  if (l === null) return 'UNKNOWN';
  return l <= 5_000 ? 'FAST' : l <= 30_000 ? 'MEDIUM' : 'SLOW';
}

export function buildAdviceRequest(input: { capability: CapabilityKind; failureClass: FailureClass; attemptsSoFar: number; attemptsRemaining: number; eligible: RankedCandidate[] }): RouteAdviceRequest {
  return {
    capability: input.capability,
    failureClass: input.failureClass,
    attemptsSoFar: input.attemptsSoFar,
    attemptsRemaining: input.attemptsRemaining,
    candidates: input.eligible.map((c) => ({
      routeId: c.candidate.routeId,
      provider: c.candidate.provider,
      vendorId: c.candidate.dataHandling.vendorId,
      costBucket: costBucket(c),
      reliability: reliabilityBucket(c),
      latency: latencyBucket(c),
      changes: c.changes.map((change) => change.kind),
      deterministicRank: c.rank,
    })),
  };
}

/** Strict whole-answer validation: anything that is not exactly an offered recommendation with a confidence in 0..1 is rejected (null = no advice). */
export function normalizeRouteAdvice(raw: unknown, request: RouteAdviceRequest, provider: string): RouteAdvice | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const id = record.recommendedRouteId;
  const confidence = record.confidence;
  if (typeof id !== 'string' || typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
  if (id === 'ABORT') return { recommendation: { kind: 'ABORT' }, confidence, provider };
  if (id === 'ASK_PERSON') return { recommendation: { kind: 'ASK_PERSON' }, confidence, provider };
  if (!request.candidates.some((c) => c.routeId === id)) return null;
  return { recommendation: { kind: 'ROUTE', routeId: id }, confidence, provider };
}

export type AdviceEffect =
  | { kind: 'NONE' }
  | { kind: 'REORDER'; routeId: string }
  | { kind: 'ASK_PERSON'; because: 'ADVISOR_RECOMMENDS_ASKING' | 'ADVISOR_RECOMMENDS_STOPPING' };

/** The closed list of what advice can change. Everything else about a recommendation is recorded, never acted on. */
export function adviceEffect(advice: RouteAdvice | null): AdviceEffect {
  if (!advice) return { kind: 'NONE' };
  const rec = advice.recommendation;
  if (rec.kind === 'ROUTE') return advice.confidence >= ADVICE_MIN_CONFIDENCE_TO_REORDER ? { kind: 'REORDER', routeId: rec.routeId } : { kind: 'NONE' };
  if (advice.confidence < ADVICE_MIN_CONFIDENCE_TO_ASK) return { kind: 'NONE' };
  return { kind: 'ASK_PERSON', because: rec.kind === 'ABORT' ? 'ADVISOR_RECOMMENDS_STOPPING' : 'ADVISOR_RECOMMENDS_ASKING' };
}

export interface RouteAdvisorOptions { deadlineMs?: number; maxFailures?: number }

/** Wraps a provider with a deadline, strict validation and a circuit breaker. `advise` never throws. */
export class RouteAdvisor {
  private failures = 0;
  private readonly deadlineMs: number;
  private readonly maxFailures: number;

  constructor(private readonly port: RouteAdvisorPort, options: RouteAdvisorOptions = {}) {
    this.deadlineMs = options.deadlineMs ?? 2_500;
    this.maxFailures = options.maxFailures ?? 2;
  }

  public get provider(): string { return this.port.provider; }

  public available(): boolean {
    return this.port.configured() && this.failures < this.maxFailures;
  }

  public async advise(request: RouteAdviceRequest): Promise<RouteAdvice | null> {
    if (!this.available() || request.candidates.length === 0) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.deadlineMs);
    try {
      const raw = await this.port.advise(request, controller.signal);
      const advice = normalizeRouteAdvice(raw, request, this.port.provider);
      if (!advice) this.failures += 1;
      return advice;
    } catch {
      this.failures += 1;
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
