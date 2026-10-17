// Recovery for the goal "find current evidence for this question": a search route that fails is not a failed goal, and a route that said no is not asked again and again.
//
// This is the adaptive core (src/adaptive/, ADR-0017) applied to web search - not a second mechanism:
//   - every configured search provider is a ROUTE CANDIDATE described by facts (configured? credential rejected? quota seen exhausted? who receives the query? what does it cost?);
//   - a failure is classified into one of the twelve normalized classes and the class decides what may happen next (a quota or a rejected credential is never retried; a rate limit is waited out only when
//     the wait is short; a timeout or an outage may be retried once, briefly);
//   - another route is looked for through the same hard eligibility, deterministic order and OPTIONAL advisory ranking (RouteAdvisor / JEV) as everywhere else - the advisor can only reorder what is
//     already eligible, and the order stands without it;
//   - moving the query to a company that did not receive it before is a MATERIAL change of terms: it happens without asking only inside the operator's explicit standing configuration (the providers the
//     operator listed in NAGEX_WEB_SEARCH_FALLBACKS and whose price is known to be zero); otherwise the search stops and says another service exists and needs the person's permission;
//   - the whole thing is bounded (attempts, switches, one short retry) and every attempt is reported, with no provider text and no secret.
//
// Nothing here fabricates a result: when no route succeeds the outcome is the honest status of the last failure, never an empty "success".
import { PRACTICAL_RETRY_AFTER_MS, classifyFailure, type FailureEvidence } from '../adaptive/failure-taxonomy.js';
import { RecoveryPlanner, type AdaptiveBudget, type AttemptSummary } from '../adaptive/recovery-planner.js';
import { routeIdOf, type GoalNeeds, type ProcessingLocation, type RouteCandidate, type RouteReliability, type SensitivityClass, type StandingAuthorization } from '../adaptive/route-candidate.js';
import { QUOTA_COOLDOWN_MS, selectRoutes } from '../adaptive/route-selection.js';
import type { SearchAttemptSummary } from './evidence-pack.types.js';
import type { SearchProviderResultStatus, SearchQueryInput, SearchQueryResult, WebSearchProviderPort } from './web-search-provider.port.js';

/** What NAgex has seen a route do. RouteOutcomeLedger satisfies this; the default is a process-local memory. */
export interface OutcomeMemory {
  recordSuccess(routeId: string, latencyMs?: number): void;
  recordFailure(routeId: string, failureClass: string): void;
  quotaExhaustedAt(routeId: string): string | null;
  reliabilityOf(routeId: string): RouteReliability | null;
}

export class InMemoryOutcomeMemory implements OutcomeMemory {
  private readonly records = new Map<string, { recent: Array<{ ok: boolean; failureClass: string | null; latencyMs: number | null; at: string }>; quotaExhaustedAt: string | null }>();
  constructor(private readonly now: () => number = Date.now) {}
  private rec(routeId: string) {
    let r = this.records.get(routeId);
    if (!r) { r = { recent: [], quotaExhaustedAt: null }; this.records.set(routeId, r); }
    return r;
  }
  public recordSuccess(routeId: string, latencyMs?: number): void {
    const r = this.rec(routeId);
    r.recent.push({ ok: true, failureClass: null, latencyMs: typeof latencyMs === 'number' ? Math.round(latencyMs) : null, at: new Date(this.now()).toISOString() });
    if (r.recent.length > 30) r.recent.shift();
    r.quotaExhaustedAt = null;
  }
  public recordFailure(routeId: string, failureClass: string): void {
    const r = this.rec(routeId);
    const at = new Date(this.now()).toISOString();
    r.recent.push({ ok: false, failureClass, latencyMs: null, at });
    if (r.recent.length > 30) r.recent.shift();
    if (failureClass === 'QUOTA_EXHAUSTED' || failureClass === 'BILLING_REQUIRED') r.quotaExhaustedAt = at;
  }
  public quotaExhaustedAt(routeId: string): string | null { return this.records.get(routeId)?.quotaExhaustedAt ?? null; }
  public reliabilityOf(routeId: string): RouteReliability | null {
    const r = this.records.get(routeId);
    if (!r || r.recent.length === 0) return null;
    const failures = r.recent.filter((x) => !x.ok);
    const latencies = r.recent.filter((x) => x.ok && x.latencyMs !== null).map((x) => x.latencyMs as number).sort((a, b) => a - b);
    const last = failures[failures.length - 1];
    return { successes: r.recent.length - failures.length, failures: failures.length, lastFailureClass: last?.failureClass ?? null, lastFailureAt: last?.at ?? null, medianLatencyMs: latencies.length ? latencies[Math.floor(latencies.length / 2)] : null };
  }
}

interface SearchVendor { vendorId: string; label: string; processing: ProcessingLocation; costUsd: number | null }

/** NAgex's own declaration of who receives a search query and what it costs. It is not a statement about any vendor's practices; a provider that is not listed is an unknown third party with an unknown price. */
const SEARCH_VENDORS: Record<string, SearchVendor> = {
  // Wikipedia's and OpenAlex's public read APIs are free and keyless
  open_knowledge: { vendorId: 'open-knowledge', label: 'Wikipedia and OpenAlex', processing: 'THIRD_PARTY_CLOUD', costUsd: 0 },
  tavily: { vendorId: 'tavily', label: 'Tavily', processing: 'THIRD_PARTY_CLOUD', costUsd: null },
  // the operator's own search endpoint: NAgex does not know where it processes the query (it may be a third-party API behind a URL), so it is not declared private
  custom_http: { vendorId: 'operator-search', label: 'the configured search service', processing: 'THIRD_PARTY_CLOUD', costUsd: null },
};

export function searchVendorOf(providerName: string): SearchVendor {
  const key = providerName.toLowerCase();
  return SEARCH_VENDORS[key] ?? { vendorId: key, label: providerName, processing: 'THIRD_PARTY_CLOUD', costUsd: null };
}

/** the route of a search provider, from facts: its configuration, what the memory has seen, and NAgex's declaration of who receives the query */
export function describeSearchRoute(provider: WebSearchProviderPort, memory: OutcomeMemory, rejectedAuthUntil: Map<string, number>, now: () => number): RouteCandidate {
  const vendor = searchVendorOf(provider.name);
  const routeId = routeIdOf('WEB_SEARCH', provider.name, null);
  const exhaustedAt = memory.quotaExhaustedAt(routeId);
  const rejected = (rejectedAuthUntil.get(routeId) ?? 0) > now();
  return {
    routeId, capability: 'WEB_SEARCH', provider: provider.name, model: null, label: vendor.label,
    inputs: ['TEXT'], outputs: ['SEARCH_RESULTS'], limits: { textInput: true },
    auth: !provider.isConfigured() ? 'UNCONFIGURED' : rejected ? 'REJECTED' : 'CONFIGURED',
    availability: 'AVAILABLE',
    quota: exhaustedAt && now() - Date.parse(exhaustedAt) < QUOTA_COOLDOWN_MS ? 'EXHAUSTED' : 'UNKNOWN',
    quotaExhaustedAt: exhaustedAt,
    cost: vendor.costUsd === null ? { usd: null, unknown: true, basis: 'UNKNOWN' } : { usd: vendor.costUsd, unknown: false, basis: 'PRICE_TABLE' },
    // a query is sanitized (secret and personal markers removed) before it leaves: only the lowest class is ever sent
    dataHandling: { processing: vendor.processing, vendorId: vendor.vendorId, maxSensitivity: 'S0' as SensitivityClass, region: null },
    approval: { required: true, reason: 'sending the question to another search service changes who receives it and what it may cost' },
    executionRoute: vendor.processing === 'PRIVATE_ENDPOINT' ? 'LOCAL_PROCESS' : 'API',
    reliability: memory.reliabilityOf(routeId),
  };
}

const SEARCH_NEEDS: GoalNeeds = Object.freeze({ capability: 'WEB_SEARCH', inputs: ['TEXT'], sensitivity: 'S0', maxCostUsd: null }) as GoalNeeds;
/** an interactive request: a few attempts, at most one brief retry, never a long wait */
export const SEARCH_BUDGET: AdaptiveBudget = Object.freeze({ maxAttempts: 4, maxSwitches: 2, maxRetriesPerRoute: 1 });
const MAX_INTERACTIVE_WAIT_MS = 2_500;
const AUTH_REJECTION_MS = 10 * 60_000;

function evidenceOf(result: SearchQueryResult, status: SearchProviderResultStatus): FailureEvidence {
  const common: FailureEvidence = { phase: 'AFTER_SEND', chargeable: false };
  const http = result.httpStatus;
  switch (status) {
    case 'AUTH_FAILED': return { ...common, code: 'PROVIDER_AUTH_FAILED', ...(http !== undefined ? { httpStatus: http } : {}) };
    case 'RATE_LIMITED': return { ...common, code: result.quotaExhausted ? 'QUOTA_EXHAUSTED' : 'RATE_LIMITED', httpStatus: http ?? 429, ...(result.retryAfterMs !== undefined ? { retryAfterMs: result.retryAfterMs } : {}) };
    case 'TIMEOUT': return { ...common, code: 'TIMEOUT' };
    case 'UNAVAILABLE': return { ...common, phase: 'BEFORE_SEND', code: 'PROVIDER_UNCONFIGURED' };
    case 'INVALID_RESPONSE': return { ...common, code: 'MALFORMED_RESPONSE' };
    case 'NO_RESULTS': return { ...common, phase: 'VERIFICATION', code: 'EMPTY_PROVIDER_RESULT' };
    case 'PROVIDER_ERROR': return http !== undefined ? { ...common, httpStatus: http } : { ...common, code: 'NETWORK_ERROR' };
    default: return common;
  }
}

/** the status a person-facing layer should report when every route failed: the most informative honest one */
export const STATUS_PRECEDENCE: SearchProviderResultStatus[] =['TIMEOUT', 'RATE_LIMITED', 'AUTH_FAILED', 'PROVIDER_ERROR', 'INVALID_RESPONSE', 'FAILED', 'NO_RESULTS', 'UNAVAILABLE'];

export interface SearchRecoveryDeps {
  /** operator-configured routes, in the operator's order */
  providers: WebSearchProviderPort[];
  memory: OutcomeMemory;
  planner: RecoveryPlanner;
  /** providers the operator named as acceptable alternatives (known price, listed vendor) */
  standing: StandingAuthorization[];
  rejectedAuthUntil: Map<string, number>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  budget?: AdaptiveBudget;
}

export async function searchWithRecovery(deps: SearchRecoveryDeps, input: SearchQueryInput): Promise<SearchQueryResult> {
  const budget = deps.budget ?? SEARCH_BUDGET;
  const byRoute = new Map(deps.providers.map((p) => [routeIdOf('WEB_SEARCH', p.name, null), p] as const));
  const describe = (): RouteCandidate[] => deps.providers.map((p) => describeSearchRoute(p, deps.memory, deps.rejectedAuthUntil, deps.now));
  const summaries: SearchAttemptSummary[] = [];
  const attempts: AttemptSummary[] = [];

  // the first route: hard eligibility and the deterministic order over what the operator configured
  const first = selectRoutes({ needs: SEARCH_NEEDS, failure: null, failedRoute: null, attemptedRouteIds: [], candidates: describe(), standing: deps.standing, now: deps.now });
  for (const r of first.rejected) summaries.push({ provider: r.provider, outcome: 'SKIPPED', failureClass: null, reasons: r.reasons });
  if (first.eligible.length === 0) {
    const reasons = first.rejected.flatMap((r) => r.reasons);
    const status: SearchProviderResultStatus = reasons.includes('AUTH_REJECTED') ? 'AUTH_FAILED' : reasons.includes('QUOTA_EXHAUSTED_RECENTLY') ? 'RATE_LIMITED' : 'UNAVAILABLE';
    return { status, results: [], error: status === 'UNAVAILABLE' ? 'No web search provider is configured.' : 'Every configured web search provider is out of use at the moment.', provider: deps.providers[0]?.name, attempts: summaries };
  }

  // the operator's order decides where to start (the deterministic ranking would put a free public API ahead of the search service the operator chose); it decides only the later switches
  const operatorOrder = new Map(deps.providers.map((p, index) => [routeIdOf('WEB_SEARCH', p.name, null), index] as const));
  let current: RouteCandidate = first.eligible.slice().sort((a, b) => (operatorOrder.get(a.candidate.routeId) ?? 99) - (operatorOrder.get(b.candidate.routeId) ?? 99))[0].candidate;
  let lastFailure: SearchQueryResult | null = null;
  const failures: SearchQueryResult[] = [];
  for (let guard = 0; guard < budget.maxAttempts + 2; guard += 1) {
    const provider = byRoute.get(current.routeId);
    if (!provider) break;
    const started = deps.now();
    let result: SearchQueryResult;
    try { result = await provider.search(input); } catch { result = { status: 'PROVIDER_ERROR', results: [], error: 'The search provider threw.', provider: provider.name }; }
    if (result.status === 'SUCCESS' && result.results.length > 0) {
      deps.memory.recordSuccess(current.routeId, deps.now() - started);
      summaries.push({ provider: provider.name, outcome: 'SUCCEEDED', failureClass: null });
      return { ...result, provider: provider.name, attempts: summaries };
    }

    const status: SearchProviderResultStatus = result.status === 'SUCCESS' ? 'NO_RESULTS' : result.status;
    let evidence = evidenceOf(result, status);
    // an interactive request does not wait out a long Retry-After: the documented wait is then simply "not practical", and another route is looked for
    if (evidence.retryAfterMs !== undefined && evidence.retryAfterMs > Math.min(PRACTICAL_RETRY_AFTER_MS, MAX_INTERACTIVE_WAIT_MS)) evidence = { ...evidence, retryAfterMs: undefined };
    const classification = classifyFailure(evidence);
    // an empty answer is not the provider's fault: it is not held against it
    if (status !== 'NO_RESULTS') deps.memory.recordFailure(current.routeId, classification.failureClass);
    if (classification.failureClass === 'AUTHENTICATION_FAILURE') deps.rejectedAuthUntil.set(current.routeId, deps.now() + AUTH_REJECTION_MS);
    attempts.push({ routeId: current.routeId, outcome: 'FAILED', failureClass: classification.failureClass });
    summaries.push({ provider: provider.name, outcome: 'FAILED', failureClass: classification.failureClass });
    failures.push({ ...result, status });
    lastFailure = { ...result, status };

    // a route that just spent its whole timeout is not given a second one while another route is ready: the person is waiting
    const planBudget: AdaptiveBudget = classification.failureClass === 'TIMEOUT' && deps.providers.length > 1 ? { ...budget, maxRetriesPerRoute: 0 } : budget;
    const decision = await deps.planner.plan({ needs: SEARCH_NEEDS, failedRoute: current, failure: evidence, attempts, candidates: describe(), standing: deps.standing, budget: planBudget, now: deps.now });
    if (decision.action === 'RETRY_SAME_ROUTE') {
      // the allowance is consumed either way; the wait happens only when it is brief
      attempts.push({ routeId: current.routeId, outcome: 'RETRYING', failureClass: classification.failureClass });
      if (decision.afterMs <= MAX_INTERACTIVE_WAIT_MS) { await deps.sleep(decision.afterMs); continue; }
      const replan = await deps.planner.plan({ needs: SEARCH_NEEDS, failedRoute: current, failure: evidence, attempts, candidates: describe(), standing: deps.standing, budget, now: deps.now });
      if (replan.action === 'SWITCH_ROUTE' && !replan.requiresApproval) { current = replan.route.candidate; continue; }
      break;
    }
    if (decision.action === 'SWITCH_ROUTE' && !decision.requiresApproval) { current = decision.route.candidate; continue; }
    if (decision.action === 'SWITCH_ROUTE' || decision.action === 'ASK_PERSON') {
      // another route exists but moving the question there changes who receives it or what it may cost: that is the person's decision, not ours
      summaries.push({ provider: decision.route.candidate.provider, outcome: 'SKIPPED', failureClass: null, reasons: ['NEEDS_PERSON_DECISION'] });
    }
    break;
  }

  // nothing succeeded: report the most informative honest failure
  const chosen = failures.slice().sort((a, b) => STATUS_PRECEDENCE.indexOf(a.status) - STATUS_PRECEDENCE.indexOf(b.status))[0] ?? lastFailure;
  const onlyEmpty = failures.length > 0 && failures.every((f) => f.status === 'NO_RESULTS');
  return {
    status: onlyEmpty ? 'NO_RESULTS' : (chosen?.status ?? 'FAILED'),
    results: [],
    ...(chosen?.error ? { error: chosen.error } : {}),
    provider: chosen?.provider ?? deps.providers[0]?.name,
    attempts: summaries,
  };
}
