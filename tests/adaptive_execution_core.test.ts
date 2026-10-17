// Goal-driven adaptive execution - the CORE, without any provider: how failures are classified, what a route must be to be eligible at all, what counts as a material change of terms, what the planner may
// decide (and when it must stop), what an advisor (JEV) can and cannot change, how an image is verified at the byte level, and what is remembered. Everything here is deterministic and offline; the JEV
// service is a SIMULATED service of the repository's verified System One shape (no JEV credential exists on this machine, so no live call is claimed).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { FAILURE_CLASSES, PRACTICAL_RETRY_AFTER_MS, classifyFailure, evidenceFromProviderResult, type FailureEvidence } from '../src/adaptive/failure-taxonomy.js';
import { verifyImageBytes } from '../src/adaptive/goal-verifier.js';
import { JevRouteAdvisor, buildJevRouteBody } from '../src/adaptive/jev-route-advisor.js';
import { DEFAULT_BUDGET, RecoveryPlanner, type AttemptSummary } from '../src/adaptive/recovery-planner.js';
import { RouteAdvisor, adviceEffect, normalizeRouteAdvice, buildAdviceRequest, type RouteAdvisorPort } from '../src/adaptive/route-advisor.js';
import { routeIdOf, type GoalNeeds, type RouteCandidate } from '../src/adaptive/route-candidate.js';
import { RouteHistoryStore } from '../src/adaptive/route-history.store.js';
import { RouteOutcomeLedger } from '../src/adaptive/route-outcome-ledger.js';
import { selectRoutes } from '../src/adaptive/route-selection.js';
import { coveredByStandingAuthorization, diffTerms } from '../src/adaptive/route-terms.js';
import { STAND_IN_PNG } from './_product_builder_fakes.js';

function route(provider: string, patch: Partial<RouteCandidate> & { vendor?: string; usd?: number | null } = {}): RouteCandidate {
  const { vendor, usd, ...rest } = patch;
  return {
    routeId: routeIdOf('IMAGE_GENERATION', provider, 'm'), capability: 'IMAGE_GENERATION', provider, model: 'm', label: provider, inputs: ['TEXT'], outputs: ['IMAGE'],
    limits: { aspectRatios: ['1:1', '16:9'], maxReferenceImages: 0 }, auth: 'CONFIGURED', availability: 'AVAILABLE', quota: 'OK', quotaExhaustedAt: null,
    cost: usd === undefined || usd === null ? { usd: null, unknown: true, basis: 'UNKNOWN' } : { usd, unknown: false, basis: 'PRICE_TABLE' },
    dataHandling: { processing: 'THIRD_PARTY_CLOUD', vendorId: vendor ?? provider, maxSensitivity: 'S1', region: null },
    approval: { required: true, reason: 'different company or price' }, executionRoute: 'API', reliability: null, ...rest,
  };
}
const NEEDS: GoalNeeds = { capability: 'IMAGE_GENERATION', inputs: ['TEXT'], aspectRatio: '16:9', sensitivity: 'S1', maxCostUsd: null };

describe('failure taxonomy: one closed set, and the rules belong to the class', () => {
  const classOf = (e: FailureEvidence) => classifyFailure(e).failureClass;

  it('reduces every vendor vocabulary to the twelve classes', () => {
    const cases: Array<[FailureEvidence, string]> = [
      [{ code: 'PROVIDER_AUTH_FAILED' }, 'AUTHENTICATION_FAILURE'], [{ httpStatus: 401 }, 'AUTHENTICATION_FAILURE'], [{ httpStatus: 403 }, 'AUTHENTICATION_FAILURE'],
      [{ code: 'CONTENT_REJECTED' }, 'PERMISSION_DENIED'], [{ code: 'USER_DECLINED' }, 'PERMISSION_DENIED'], [{ code: 'DOMAIN_NOT_ALLOWED' }, 'PERMISSION_DENIED'],
      [{ code: 'PROVIDER_QUOTA_EXCEEDED' }, 'QUOTA_EXHAUSTED'], [{ providerStatus: 'RESOURCE_EXHAUSTED' }, 'QUOTA_EXHAUSTED'], [{ code: 'PROVIDER_INSUFFICIENT_CREDITS' }, 'QUOTA_EXHAUSTED'],
      [{ httpStatus: 429 }, 'RATE_LIMITED'], [{ code: 'HOST_RATE_LIMITED' }, 'RATE_LIMITED'],
      [{ httpStatus: 402 }, 'BILLING_REQUIRED'], [{ code: 'PROVIDER_BILLING_REQUIRED' }, 'BILLING_REQUIRED'],
      [{ httpStatus: 503 }, 'PROVIDER_UNAVAILABLE'], [{ code: 'PROVIDER_UNAVAILABLE_ERROR' }, 'PROVIDER_UNAVAILABLE'],
      [{ code: 'TIMEOUT' }, 'TIMEOUT'], [{ httpStatus: 504 }, 'TIMEOUT'],
      [{ code: 'UNSUPPORTED_ASPECT_RATIO' }, 'INPUT_UNSUPPORTED'], [{ httpStatus: 422 }, 'INPUT_UNSUPPORTED'],
      [{ code: 'PROVIDER_UNCONFIGURED' }, 'CAPABILITY_UNAVAILABLE'], [{ code: 'PROVIDER_MODEL_NOT_FOUND' }, 'CAPABILITY_UNAVAILABLE'], [{ httpStatus: 404 }, 'CAPABILITY_UNAVAILABLE'],
      [{ code: 'MALFORMED_RESPONSE' }, 'TRANSIENT_EXECUTION_FAILURE'], [{ httpStatus: 500 }, 'TRANSIENT_EXECUTION_FAILURE'],
      [{ code: 'IMAGE_VERIFICATION_FAILED' }, 'VERIFICATION_FAILED'], [{ phase: 'VERIFICATION' }, 'VERIFICATION_FAILED'],
      [{ code: 'SUBMIT_UNCERTAIN' }, 'UNKNOWN_OUTCOME'], [{ code: 'DEPLOY_STATE_UNCERTAIN' }, 'UNKNOWN_OUTCOME'],
    ];
    for (const [evidence, expected] of cases) assert.equal(classOf(evidence), expected, JSON.stringify(evidence));
    assert.equal(FAILURE_CLASSES.length, 12);
    for (const [, expected] of cases) assert.ok((FAILURE_CLASSES as readonly string[]).includes(expected));
  });

  it('a chargeable request that was sent and not answered is an UNKNOWN outcome whatever the transport said - unless the provider de-duplicates', () => {
    assert.equal(classOf({ chargeable: true, phase: 'AFTER_SEND', code: 'TIMEOUT' }), 'UNKNOWN_OUTCOME');
    assert.equal(classOf({ chargeable: true, phase: 'AFTER_SEND', code: 'NETWORK_ERROR' }), 'UNKNOWN_OUTCOME');
    assert.equal(classOf({ chargeable: true, phase: 'AFTER_SEND', httpStatus: 502 }), 'UNKNOWN_OUTCOME');
    assert.equal(classOf({ chargeable: true, phase: 'AFTER_SEND', idempotent: true, code: 'TIMEOUT' }), 'TIMEOUT');
    assert.equal(classOf({ chargeable: true, phase: 'BEFORE_SEND', code: 'TIMEOUT' }), 'TIMEOUT');
    // a definite refusal after sending is still a refusal, not an unknown
    assert.equal(classOf({ chargeable: true, phase: 'AFTER_SEND', code: 'PROVIDER_QUOTA_EXCEEDED' }), 'QUOTA_EXHAUSTED');
  });

  it('retry and fallback differ by class: quota is never hammered, a denial is never routed around, an unknown outcome is never duplicated', () => {
    const quota = classifyFailure({ code: 'PROVIDER_QUOTA_EXCEEDED' });
    assert.deepEqual([quota.retry, quota.fallback], ['NEVER', 'ALLOWED']);
    const denied = classifyFailure({ code: 'CONTENT_REJECTED' });
    assert.deepEqual([denied.retry, denied.fallback], ['NEVER', 'FORBIDDEN']);
    const unknown = classifyFailure({ code: 'SUBMIT_UNCERTAIN' });
    assert.deepEqual([unknown.retry, unknown.fallback], ['NEVER', 'AFTER_RECONCILIATION']);
    assert.deepEqual([classifyFailure({ code: 'UNSUPPORTED_ASPECT_RATIO' }).retry, classifyFailure({ code: 'UNSUPPORTED_ASPECT_RATIO' }).fallback], ['NEVER', 'COMPATIBLE_ONLY']);
    // a short documented wait is used; a long one (or none) means another route instead of waiting
    const short = classifyFailure({ httpStatus: 429, retryAfterMs: 3_000 });
    assert.deepEqual([short.retry, short.retryAfterMs], ['AFTER_DOCUMENTED_DELAY', 3_000]);
    assert.equal(classifyFailure({ httpStatus: 429, retryAfterMs: PRACTICAL_RETRY_AFTER_MS + 1 }).retry, 'NEVER');
    assert.equal(classifyFailure({ httpStatus: 429 }).retry, 'NEVER');
    // a repeat of a chargeable, un-deduplicated request is not offered; a bad result of a chargeable one is not repeated blindly
    assert.equal(classifyFailure({ code: 'PROVIDER_UNAVAILABLE_ERROR', chargeable: true, phase: 'AFTER_SEND' }).retry, 'NEVER');
    assert.equal(classifyFailure({ code: 'PROVIDER_UNAVAILABLE_ERROR', chargeable: true, phase: 'BEFORE_SEND' }).retry, 'ONCE_AFTER_DELAY');
    assert.equal(classifyFailure({ code: 'IMAGE_VERIFICATION_FAILED', chargeable: true }).retry, 'NEVER');
  });

  it('reads an adapter result (errorCode, UNAVAILABLE status, http status in the metadata)', () => {
    assert.deepEqual(evidenceFromProviderResult({ status: 'FAILED', errorCode: 'PROVIDER_QUOTA_EXCEEDED', metadata: { customData: { httpStatus: 429 } } }), { code: 'PROVIDER_QUOTA_EXCEEDED', httpStatus: 429 });
    assert.equal(classOfResult({ status: 'UNAVAILABLE' }), 'PROVIDER_UNAVAILABLE');
    function classOfResult(r: Parameters<typeof evidenceFromProviderResult>[0]) { return classifyFailure(evidenceFromProviderResult(r)).failureClass; }
  });
});

describe('hard eligibility comes before any ranking, and a recommendation cannot override it', () => {
  const base = { needs: NEEDS, failure: classifyFailure({ code: 'PROVIDER_QUOTA_EXCEEDED' }), failedRoute: route('google'), attemptedRouteIds: [routeIdOf('IMAGE_GENERATION', 'google', 'm')] };

  it('rejects, with the reason, a route that is the failed one, already tried, unconfigured, rejected, unavailable, out of quota, incompatible, too sensitive, or too dear', () => {
    const candidates = [
      route('google'), route('b-unconfigured', { auth: 'UNCONFIGURED' }), route('c-rejected', { auth: 'REJECTED' }), route('d-down', { availability: 'UNAVAILABLE' }),
      route('e-quota', { quota: 'EXHAUSTED' }), route('f-ratio', { limits: { aspectRatios: ['1:1'] } }), route('g-sensitive', { dataHandling: { processing: 'THIRD_PARTY_CLOUD', vendorId: 'g', maxSensitivity: 'S0', region: null } }),
      route('h-dear', { usd: 9 }), route('i-ok', { usd: 0.04 }),
    ];
    const { eligible, rejected } = selectRoutes({ ...base, candidates, needs: { ...NEEDS, maxCostUsd: 1 } });
    assert.deepEqual(eligible.map((e) => e.candidate.provider), ['i-ok']);
    const why = Object.fromEntries(rejected.map((r) => [r.provider, r.reasons]));
    assert.deepEqual(why.google, ['SAME_AS_FAILED_ROUTE']);
    assert.deepEqual(why['b-unconfigured'], ['NOT_CONFIGURED']);
    assert.deepEqual(why['c-rejected'], ['AUTH_REJECTED']);
    assert.deepEqual(why['d-down'], ['UNAVAILABLE']);
    assert.deepEqual(why['e-quota'], ['QUOTA_EXHAUSTED_RECENTLY']);
    assert.deepEqual(why['f-ratio'], ['INPUT_INCOMPATIBLE']);
    assert.deepEqual(why['g-sensitive'], ['SENSITIVITY_EXCEEDS_ROUTE']);
    assert.deepEqual(why['h-dear'], ['COST_OVER_AUTHORIZED_LIMIT']);
  });

  it('a route whose quota was seen exhausted stays out for the cool-down, then is tried again', () => {
    const exhausted = route('q', { quotaExhaustedAt: new Date(1_000_000).toISOString() });
    const within = selectRoutes({ ...base, candidates: [exhausted], now: () => 1_000_000 + 60_000 });
    assert.equal(within.eligible.length, 0);
    const after = selectRoutes({ ...base, candidates: [exhausted], now: () => 1_000_000 + 16 * 60_000 });
    assert.equal(after.eligible.length, 1);
  });

  it('a failure that forbids fallback (a denial) or needs reconciliation makes every route ineligible', () => {
    const denied = selectRoutes({ ...base, failure: classifyFailure({ code: 'CONTENT_REJECTED' }), candidates: [route('x')] });
    assert.deepEqual(denied.rejected[0].reasons, ['FALLBACK_FORBIDDEN_BY_FAILURE']);
    const unknown = selectRoutes({ ...base, failure: classifyFailure({ code: 'SUBMIT_UNCERTAIN' }), candidates: [route('x')] });
    assert.deepEqual(unknown.rejected[0].reasons, ['FALLBACK_NEEDS_RECONCILIATION']);
  });

  it('orders what is left deterministically: unchanged terms, then a known lower price, then measured reliability, then latency, then a stable id', () => {
    const failed = route('google', { vendor: 'g' });
    const same = route('z-google-other-model', { vendor: 'g', usd: 0.04, model: 'm2', routeId: routeIdOf('IMAGE_GENERATION', 'z-google-other-model', 'm2') });
    const cheap = route('b-cheap', { usd: 0.01 });
    const dear = route('a-dear', { usd: 0.05 });
    const unknownPrice = route('c-unknown');
    const reliable = route('d-reliable', { usd: 0.05, reliability: { successes: 9, failures: 1, lastFailureClass: null, lastFailureAt: null, medianLatencyMs: 4000 } });
    const result = selectRoutes({ ...base, failedRoute: { ...failed, cost: { usd: 0.04, unknown: false, basis: 'PRICE_TABLE' } }, candidates: [unknownPrice, dear, cheap, reliable, same] });
    // the same company at the same price keeps the person's terms: first. Then by known price, and a reliable route beats an equally priced one with no record.
    assert.deepEqual(result.eligible.map((e) => e.candidate.provider), ['z-google-other-model', 'b-cheap', 'd-reliable', 'a-dear', 'c-unknown']);
    assert.deepEqual(result.eligible.map((e) => e.rank), [1, 2, 3, 4, 5]);
    // a reliability record with too few samples is ignored, not trusted
    const thin = route('t', { usd: 0.05, reliability: { successes: 2, failures: 0, lastFailureClass: null, lastFailureAt: null, medianLatencyMs: null } });
    assert.equal(selectRoutes({ ...base, candidates: [thin] }).eligible[0].factors.successRatio, null);
  });
});

describe('material terms: a switch that changes what the person agreed to needs their decision', () => {
  const google = route('google', { vendor: 'google', usd: 0.04, dataHandling: { processing: 'THIRD_PARTY_CLOUD', vendorId: 'google', maxSensitivity: 'S1', region: 'us' } });

  it('another company, another processing location, a higher or an unknown price, fewer input capabilities - each is material; the same terms are not', () => {
    const kinds = (r: RouteCandidate) => diffTerms(google, r).map((c) => c.kind);
    assert.deepEqual(kinds(route('openai', { vendor: 'openai', usd: 0.04 })).includes('NEW_THIRD_PARTY_RECEIVES_DATA'), true);
    assert.ok(kinds(route('x', { vendor: 'google', usd: 0.04, dataHandling: { processing: 'LOCAL_DEVICE', vendorId: 'google', maxSensitivity: 'S1', region: null } })).includes('PROCESSING_LOCATION_CHANGED'));
    assert.ok(kinds(route('x', { vendor: 'google', usd: 0.5, dataHandling: { processing: 'THIRD_PARTY_CLOUD', vendorId: 'google', maxSensitivity: 'S1', region: 'us' } })).includes('COST_INCREASED'));
    assert.ok(kinds(route('x', { vendor: 'google', dataHandling: { processing: 'THIRD_PARTY_CLOUD', vendorId: 'google', maxSensitivity: 'S1', region: 'us' } })).includes('COST_UNKNOWN'));
    assert.ok(kinds(route('x', { vendor: 'google', usd: 0.04, limits: { maxReferenceImages: 0 }, dataHandling: { processing: 'THIRD_PARTY_CLOUD', vendorId: 'google', maxSensitivity: 'S1', region: 'us' } })).length === 0, 'identical terms: nothing to ask');
    assert.ok(kinds(route('x', { vendor: 'google', usd: 0.041, dataHandling: { processing: 'THIRD_PARTY_CLOUD', vendorId: 'google', maxSensitivity: 'S1', region: 'us' } })).length === 0, 'a rounding-sized price difference is not a new decision');
    assert.ok(diffTerms({ ...google, limits: { maxReferenceImages: 2 } }, route('x', { vendor: 'google', usd: 0.04, limits: { maxReferenceImages: 0 }, dataHandling: google.dataHandling })).some((c) => c.kind === 'INPUT_CAPABILITY_REDUCED'));
  });

  it('only an explicit standing authorization can stand in for the decision - and never for a location change, an unknown price or a reduced capability', () => {
    // the same region as the original: only the company and the (known) price are what a standing grant can cover
    const openai = route('openai', { vendor: 'openai', usd: 0.04, dataHandling: { processing: 'THIRD_PARTY_CLOUD', vendorId: 'openai', maxSensitivity: 'S1', region: 'us' } });
    const changes = diffTerms(google, openai);
    assert.equal(coveredByStandingAuthorization(changes, openai, undefined), false);
    assert.equal(coveredByStandingAuthorization(changes, openai, []), false);
    assert.equal(coveredByStandingAuthorization(changes, openai, [{ capability: 'IMAGE_GENERATION', allowedVendors: ['openai'], maxCostUsd: 1 }]), true);
    assert.equal(coveredByStandingAuthorization(changes, openai, [{ capability: 'IMAGE_GENERATION', allowedVendors: ['other'], maxCostUsd: 1 }]), false);
    const dearer = { ...openai, cost: { usd: 2, unknown: false, basis: 'PRICE_TABLE' as const } };
    assert.equal(coveredByStandingAuthorization(diffTerms(google, dearer), dearer, [{ capability: 'IMAGE_GENERATION', allowedVendors: ['openai'], maxCostUsd: 1 }]), false);
    // the ceiling holds even when the price did not rise enough to count as a change
    assert.equal(coveredByStandingAuthorization(changes, openai, [{ capability: 'IMAGE_GENERATION', allowedVendors: ['openai'], maxCostUsd: 0.01 }]), false);
    // a different region is never covered by a company-and-ceiling grant
    const elsewhere = route('openai', { vendor: 'openai', usd: 0.04 });
    assert.equal(coveredByStandingAuthorization(diffTerms(google, elsewhere), elsewhere, [{ capability: 'IMAGE_GENERATION', allowedVendors: ['openai'], maxCostUsd: 5 }]), false);
    const unknownPrice = route('openai', { vendor: 'openai', dataHandling: openai.dataHandling });
    assert.equal(coveredByStandingAuthorization(diffTerms(google, unknownPrice), unknownPrice, [{ capability: 'IMAGE_GENERATION', allowedVendors: ['openai'], maxCostUsd: 5 }]), false);
  });
});

describe('the planner: bounded, class-aware, and deterministic without any advisor', () => {
  const planner = new RecoveryPlanner();
  const failedGoogle = route('google', { vendor: 'google', usd: null });
  const attempt = (provider: string, outcome: AttemptSummary['outcome'], failureClass: string | null = null): AttemptSummary => ({ routeId: routeIdOf('IMAGE_GENERATION', provider, 'm'), outcome, failureClass });
  const input = (over: Partial<Parameters<RecoveryPlanner['plan']>[0]> = {}) => ({ needs: NEEDS, failedRoute: failedGoogle, failure: { code: 'PROVIDER_QUOTA_EXCEEDED' } as FailureEvidence, attempts: [attempt('google', 'FAILED', 'QUOTA_EXHAUSTED')], candidates: [failedGoogle, route('openai')], ...over });

  it('quota exhausted: no repeat call on the exhausted account; another authorized route is proposed, and because the company and price change it needs the person', async () => {
    const decision = await planner.plan(input());
    assert.equal(decision.action, 'SWITCH_ROUTE');
    if (decision.action !== 'SWITCH_ROUTE') return;
    assert.equal(decision.route.candidate.provider, 'openai');
    assert.equal(decision.requiresApproval, true);
    assert.deepEqual(decision.route.changes.map((c) => c.kind).sort(), ['COST_UNKNOWN', 'NEW_THIRD_PARTY_RECEIVES_DATA']);
    assert.equal(decision.rankedBy, 'DETERMINISTIC');
    assert.equal(decision.classification.failureClass, 'QUOTA_EXHAUSTED');
  });

  it('with an explicit standing authorization that covers the switch, it happens without asking; without one it never does', async () => {
    const covered = await planner.plan(input({ failedRoute: { ...failedGoogle, cost: { usd: 0.04, unknown: false, basis: 'PRICE_TABLE' } }, candidates: [failedGoogle, route('openai', { usd: 0.04 })], standing: [{ capability: 'IMAGE_GENERATION', allowedVendors: ['openai'], maxCostUsd: 1 }] }));
    assert.equal(covered.action === 'SWITCH_ROUTE' && covered.requiresApproval, false);
    const uncovered = await planner.plan(input({ failedRoute: { ...failedGoogle, cost: { usd: 0.04, unknown: false, basis: 'PRICE_TABLE' } }, candidates: [failedGoogle, route('openai', { usd: 0.04 })] }));
    assert.equal(uncovered.action === 'SWITCH_ROUTE' && uncovered.requiresApproval, true);
  });

  it('nothing eligible: ABORT with exactly which capability is missing; the goal state is for the caller to keep (resumable)', async () => {
    const decision = await planner.plan(input({ candidates: [failedGoogle, route('openai', { auth: 'UNCONFIGURED', availability: 'UNAVAILABLE' }), route('nim', { auth: 'UNCONFIGURED', availability: 'UNAVAILABLE' })] }));
    assert.equal(decision.action, 'ABORT');
    if (decision.action !== 'ABORT') return;
    assert.equal(decision.reason, 'NO_AUTHORIZED_ROUTE');
    assert.deepEqual(decision.missing.map((m) => m.provider).sort(), ['nim', 'openai']);
    assert.ok(decision.missing.every((m) => m.reasons.includes('NOT_CONFIGURED')));
  });

  it('a denial is the answer: no other route is looked for; an unknown outcome waits for reconciliation and is never duplicated', async () => {
    const denied = await planner.plan(input({ failure: { code: 'CONTENT_REJECTED' } }));
    assert.deepEqual([denied.action, denied.action === 'ABORT' && denied.reason], ['ABORT', 'PERMISSION_DENIED']);
    const unknown = await planner.plan(input({ failure: { code: 'SUBMIT_UNCERTAIN' } }));
    assert.equal(unknown.action, 'RECONCILE_FIRST');
    const started = await planner.plan(input({ failure: { code: 'SUBMIT_UNCERTAIN' }, reconciliation: 'CONFIRMED_STARTED' }));
    assert.deepEqual([started.action, started.action === 'ABORT' && started.reason], ['ABORT', 'OUTCOME_CONFIRMED_STARTED']);
    const notStarted = await planner.plan(input({ failure: { code: 'SUBMIT_UNCERTAIN' }, reconciliation: 'CONFIRMED_NOT_STARTED' }));
    assert.equal(notStarted.action, 'SWITCH_ROUTE');
  });

  it('a transient failure is retried once on the same route, then the work moves; the attempt budget ends the goal', async () => {
    const transient = { code: 'PROVIDER_UNAVAILABLE_ERROR' } as FailureEvidence;
    const first = await planner.plan(input({ failure: transient, attempts: [attempt('google', 'FAILED', 'PROVIDER_UNAVAILABLE')] }));
    assert.equal(first.action, 'RETRY_SAME_ROUTE');
    const again = await planner.plan(input({ failure: transient, attempts: [attempt('google', 'RETRYING', 'PROVIDER_UNAVAILABLE'), attempt('google', 'FAILED', 'PROVIDER_UNAVAILABLE')] }));
    assert.equal(again.action, 'SWITCH_ROUTE');
    const spent = await planner.plan(input({ attempts: Array.from({ length: DEFAULT_BUDGET.maxAttempts }, (_, i) => attempt(`p${i % 2}`, 'FAILED', 'QUOTA_EXHAUSTED')) }));
    assert.deepEqual([spent.action, spent.action === 'ABORT' && spent.reason], ['ABORT', 'BUDGET_EXHAUSTED']);
    const switched = await planner.plan(input({ attempts: ['a', 'b', 'c', 'd'].map((p) => attempt(p, 'FAILED', 'QUOTA_EXHAUSTED')) }));
    assert.deepEqual([switched.action, switched.action === 'ABORT' && switched.reason], ['ABORT', 'BUDGET_EXHAUSTED'], 'the number of switches is bounded too');
  });

  it('input the route cannot take: only a compatible route is proposed', async () => {
    const decision = await planner.plan(input({ failure: { code: 'UNSUPPORTED_ASPECT_RATIO' }, candidates: [failedGoogle, route('narrow', { limits: { aspectRatios: ['1:1'] } }), route('wide', { limits: { aspectRatios: ['16:9'] } })] }));
    assert.equal(decision.action === 'SWITCH_ROUTE' && decision.options.map((o) => o.candidate.provider).join(), 'wide');
  });
});

describe('the advisor (JEV) can reorder or ask the person - and nothing else', () => {
  const failed = route('google', { vendor: 'google' });
  const candidates = [failed, route('openai', { usd: 0.04 }), route('nim', { usd: 0.05 })];
  const attempts: AttemptSummary[] = [{ routeId: failed.routeId, outcome: 'FAILED', failureClass: 'QUOTA_EXHAUSTED' }];
  const advisorOf = (answer: unknown | (() => Promise<unknown>), configured = true): { port: RouteAdvisorPort; asked: unknown[] } => {
    const asked: unknown[] = [];
    return { asked, port: { provider: 'sim', configured: () => configured, advise: async (request) => { asked.push(request); return typeof answer === 'function' ? (answer as () => Promise<unknown>)() : answer; } } };
  };
  const plan = (advisor: RouteAdvisor | null) => new RecoveryPlanner({ advisor }).plan({ needs: NEEDS, failedRoute: failed, failure: { code: 'PROVIDER_QUOTA_EXCEEDED' }, attempts, candidates });

  it('a confident recommendation among the offered routes reorders them; it does not remove the need for approval', async () => {
    const decision = await plan(new RouteAdvisor(advisorOf({ recommendedRouteId: routeIdOf('IMAGE_GENERATION', 'nim', 'm'), confidence: 0.9 }).port));
    assert.equal(decision.action, 'SWITCH_ROUTE');
    if (decision.action !== 'SWITCH_ROUTE') return;
    assert.deepEqual([decision.route.candidate.provider, decision.rankedBy, decision.requiresApproval], ['nim', 'ADVISOR', true]);
    assert.deepEqual(decision.options.map((o) => o.candidate.provider), ['nim', 'openai']);
    assert.deepEqual(decision.options.map((o) => o.rank), [1, 2]);
  });

  it('a weak recommendation, one for a route that was not offered (or an ineligible one), and nonsense are no advice: the deterministic order stands', async () => {
    for (const answer of [
      { recommendedRouteId: routeIdOf('IMAGE_GENERATION', 'nim', 'm'), confidence: 0.3 },
      { recommendedRouteId: 'IMAGE_GENERATION:made-up:m', confidence: 0.99 },
      { recommendedRouteId: failed.routeId, confidence: 0.99 },
      { recommendedRouteId: routeIdOf('IMAGE_GENERATION', 'nim', 'm'), confidence: 1.5 },
      { recommendedRouteId: 7, confidence: 0.9 }, 'yes', null, {},
    ]) {
      const decision = await plan(new RouteAdvisor(advisorOf(answer).port));
      assert.equal(decision.action === 'SWITCH_ROUTE' && decision.route.candidate.provider, 'openai', JSON.stringify(answer));
    }
  });

  it('a confident "ask the person" or "abort" turns the automatic step into a question; it can never turn a question into an automatic step', async () => {
    for (const choice of ['ASK_PERSON', 'ABORT']) {
      const decision = await plan(new RouteAdvisor(advisorOf({ recommendedRouteId: choice, confidence: 0.95 }).port));
      assert.deepEqual([decision.action, decision.action === 'ASK_PERSON' && decision.requiresApproval], ['ASK_PERSON', true], choice);
    }
    const weak = await plan(new RouteAdvisor(advisorOf({ recommendedRouteId: 'ABORT', confidence: 0.5 }).port));
    assert.equal(weak.action, 'SWITCH_ROUTE');
    // an advisor that says "go ahead" with full confidence changes nothing about approval
    const confident = await plan(new RouteAdvisor(advisorOf({ recommendedRouteId: routeIdOf('IMAGE_GENERATION', 'openai', 'm'), confidence: 1 }).port));
    assert.equal(confident.action === 'SWITCH_ROUTE' && confident.requiresApproval, true);
  });

  it('unavailable, slow, throwing or unconfigured: a safe deterministic fallback, flagged as such; a failing provider is given up on', async () => {
    const down = new RouteAdvisor(advisorOf(async () => { throw new Error('503'); }).port);
    for (let i = 0; i < 3; i += 1) assert.equal((await plan(down)) .action, 'SWITCH_ROUTE');
    assert.equal(down.available(), false, 'a provider that failed twice is not asked again');
    const decision = await plan(down);
    assert.equal(decision.action === 'SWITCH_ROUTE' && decision.rankedBy, 'DETERMINISTIC_FALLBACK');
    const slow = new RouteAdvisor(advisorOf(() => new Promise(() => undefined)).port, { deadlineMs: 20 });
    assert.equal((await slow.advise(buildAdviceRequest({ capability: 'IMAGE_GENERATION', failureClass: 'QUOTA_EXHAUSTED', attemptsSoFar: 1, attemptsRemaining: 5, eligible: [] }))), null);
    const unconfigured = await plan(new RouteAdvisor(advisorOf({ recommendedRouteId: 'x', confidence: 1 }, false).port));
    assert.equal(unconfigured.action === 'SWITCH_ROUTE' && unconfigured.rankedBy, 'DETERMINISTIC_FALLBACK');
  });

  it('what is sent to an advisor has no field for a goal, a prompt or a name - only kinds, buckets and provider ids', async () => {
    const { port, asked } = advisorOf({ recommendedRouteId: routeIdOf('IMAGE_GENERATION', 'openai', 'm'), confidence: 0.9 });
    await plan(new RouteAdvisor(port));
    const request = asked[0] as ReturnType<typeof buildAdviceRequest>;
    assert.deepEqual(Object.keys(request).sort(), ['attemptsRemaining', 'attemptsSoFar', 'candidates', 'capability', 'failureClass']);
    assert.deepEqual(Object.keys(request.candidates[0]).sort(), ['changes', 'costBucket', 'deterministicRank', 'latency', 'provider', 'reliability', 'routeId', 'vendorId']);
    assert.equal(normalizeRouteAdvice({ recommendedRouteId: 'ASK_PERSON', confidence: 0.9, extra: 'x', approved: true }, request, 'sim')?.recommendation.kind, 'ASK_PERSON');
    assert.deepEqual(adviceEffect(null), { kind: 'NONE' });
  });
});

describe('JEV as one provider: the repository\'s verified System One shape, against a SIMULATED service', () => {
  const failed = route('google');
  const request = buildAdviceRequest({ capability: 'IMAGE_GENERATION', failureClass: 'QUOTA_EXHAUSTED', attemptsSoFar: 1, attemptsRemaining: 5, eligible: selectRoutes({ needs: NEEDS, failure: classifyFailure({ code: 'PROVIDER_QUOTA_EXCEEDED' }), failedRoute: failed, attemptedRouteIds: [failed.routeId], candidates: [route('openai', { usd: 0.04 }), route('nim', { usd: 0.05 })] }).eligible });

  it('asks ONE choice question over the offered route ids (+ ask / abort) in the verified request shape, with no content', () => {
    const body = buildJevRouteBody(request) as any;
    assert.equal(body.model, 'jev-latest');
    assert.deepEqual(Object.keys(body.questions), ['route']);
    assert.equal(body.questions.route.type, 'choice');
    assert.deepEqual(body.questions.route.choices, [routeIdOf('IMAGE_GENERATION', 'openai', 'm'), routeIdOf('IMAGE_GENERATION', 'nim', 'm'), 'ASK_PERSON', 'ABORT']);
    assert.match(body.questions.route.instructions, /advisory only/);
    assert.match(JSON.stringify(body), /^(?!.*(prompt|password|secret)).*$/i);
  });

  it('reads answers.route.{choice, confidence}; sends the key only in Authorization; is unconfigured without a key and then never contacts the service', async () => {
    const seen: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
    const fetchFn = (async (url: any, init: any) => { seen.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) }); return new Response(JSON.stringify({ answers: { route: { choice: routeIdOf('IMAGE_GENERATION', 'nim', 'm'), confidence: 0.82 } } }), { status: 200 }); }) as typeof fetch;
    const jev = new JevRouteAdvisor({ apiKey: 'simulated-key', fetchFn, endpoint: 'http://127.0.0.1:1/v1/systemone' });
    const advice = await new RouteAdvisor(jev).advise(request);
    assert.deepEqual(advice?.recommendation, { kind: 'ROUTE', routeId: routeIdOf('IMAGE_GENERATION', 'nim', 'm') });
    assert.equal(advice?.confidence, 0.82);
    assert.equal(seen[0].headers.Authorization, 'Bearer simulated-key');
    assert.ok(!JSON.stringify(seen[0].body).includes('simulated-key'));
    const idle: string[] = [];
    const none = new JevRouteAdvisor({ fetchFn: (async (url: any) => { idle.push(String(url)); return new Response('{}'); }) as typeof fetch });
    assert.equal(none.configured(), false);
    assert.equal(await new RouteAdvisor(none).advise(request), null);
    assert.deepEqual(idle, []);
    const http500 = new RouteAdvisor(new JevRouteAdvisor({ apiKey: 'k', fetchFn: (async () => new Response('x', { status: 500 })) as typeof fetch }));
    assert.equal(await http500.advise(request), null);
  });
});

describe('goal-level verification of an image: real bytes, not a 200', () => {
  it('accepts a real PNG and reports what it is (type, size, dimensions, hash)', () => {
    const v = verifyImageBytes(STAND_IN_PNG, { claimedMime: 'image/png' });
    assert.deepEqual([v.ok, v.mimeType, v.width, v.height], [true, 'image/png', 480, 300]);
    assert.equal(v.bytes, STAND_IN_PNG.length);
    assert.match(v.sha256 ?? '', /^[0-9a-f]{64}$/);
  });

  it('refuses nothing, a speck, text, a truncated file, a placeholder-sized image, and a mislabelled type is reported (the real type wins)', () => {
    assert.deepEqual(verifyImageBytes(Buffer.alloc(0)).problems, ['EMPTY']);
    assert.deepEqual(verifyImageBytes(null).problems, ['EMPTY']);
    assert.deepEqual(verifyImageBytes(Buffer.from('tiny')).problems, ['TOO_SMALL_TO_BE_AN_IMAGE']);
    assert.deepEqual(verifyImageBytes(Buffer.from('<html><body>Quota exceeded, please sign in.</body></html>'.repeat(3))).problems, ['NOT_A_KNOWN_IMAGE_FORMAT']);
    const truncated = verifyImageBytes(STAND_IN_PNG.subarray(0, STAND_IN_PNG.length - 20));
    assert.ok(!truncated.ok && truncated.problems.includes('TRUNCATED_OR_CORRUPT'));
    const speck = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    assert.ok(verifyImageBytes(speck).problems.includes('DIMENSIONS_TOO_SMALL'), 'a 1x1 pixel is not a mockup');
    const mislabelled = verifyImageBytes(STAND_IN_PNG, { claimedMime: 'image/jpeg' });
    assert.deepEqual([mislabelled.ok, mislabelled.mimeType, mislabelled.problems], [true, 'image/png', ['CLAIMED_TYPE_MISMATCH']]);
  });

  it('reads a JPEG, a GIF and a WebP header too', () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1'), Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x40, 0x01, 0xe0, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]), Buffer.alloc(40), Buffer.from([0xff, 0xd9])]);
    assert.deepEqual([verifyImageBytes(jpeg).mimeType, verifyImageBytes(jpeg).width, verifyImageBytes(jpeg).height, verifyImageBytes(jpeg).ok], ['image/jpeg', 480, 320, true]);
    const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.from([0x40, 0x01, 0xc8, 0x00]), Buffer.alloc(40), Buffer.from([0x3b])]);
    assert.deepEqual([verifyImageBytes(gif).mimeType, verifyImageBytes(gif).width, verifyImageBytes(gif).height], ['image/gif', 320, 200]);
    const webpBody = Buffer.concat([Buffer.from('VP8 '), Buffer.from([0x14, 0, 0, 0]), Buffer.alloc(6), Buffer.from([0x40, 0x01, 0xc8, 0x00]), Buffer.alloc(8)]);
    const riff = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), webpBody]);
    riff.writeUInt32LE(riff.length - 8, 4);
    assert.deepEqual([verifyImageBytes(riff).mimeType, verifyImageBytes(riff).width, verifyImageBytes(riff).height], ['image/webp', 320, 200]);
  });
});

describe('what NAgex remembers: observed outcomes, quota state, and the route history of a goal', () => {
  const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-adaptive-'));

  it('the ledger keeps recent outcomes, derives reliability, marks a quota seen exhausted and clears it on the next success - across a restart', () => {
    const d = dir();
    let now = Date.parse('2026-10-17T10:00:00Z');
    const a = new RouteOutcomeLedger({ dir: d, now: () => now });
    const id = routeIdOf('IMAGE_GENERATION', 'google', 'm');
    assert.equal(a.reliabilityOf(id), null, 'no record is not a good record');
    a.recordSuccess(id, 4000); a.recordSuccess(id, 6000); a.recordFailure(id, 'TIMEOUT');
    now += 1000;
    a.recordFailure(id, 'QUOTA_EXHAUSTED');
    const restarted = new RouteOutcomeLedger({ dir: d, now: () => now });
    assert.deepEqual(restarted.reliabilityOf(id), { successes: 2, failures: 2, lastFailureClass: 'QUOTA_EXHAUSTED', lastFailureAt: new Date(now).toISOString(), medianLatencyMs: 6000 });
    assert.equal(restarted.quotaExhaustedAt(id), new Date(now).toISOString());
    restarted.recordSuccess(id, 3000);
    assert.equal(restarted.quotaExhaustedAt(id), null);
    // a failure class that is not about quota does not mark it
    restarted.recordFailure(id, 'TIMEOUT');
    assert.equal(restarted.quotaExhaustedAt(id), null);
    // the window is bounded
    for (let i = 0; i < 100; i += 1) restarted.recordSuccess(id);
    const r = restarted.reliabilityOf(id)!;
    assert.ok(r.successes + r.failures <= 30);
  });

  it('the history of a goal is owner-scoped, survives a restart, keeps the order and what was decided and by whom', () => {
    const d = dir();
    const store = new RouteHistoryStore({ dir: d });
    const at = '2026-10-17T10:00:00.000Z';
    const history = store.ensure('pbp_aaaaaaaaaaaaaaaa.mockups.1', 'ten_a', 'usr_a', 'IMAGE_GENERATION', at);
    store.append(history, { at, routeId: 'r1', provider: 'google', model: 'm', outcome: 'FAILED', failureClass: 'QUOTA_EXHAUSTED', code: 'IMAGE_QUOTA_EXCEEDED', decision: { action: 'SWITCH_ROUTE', rankedBy: 'DETERMINISTIC', advisor: null, reason: 'quota exhausted' }, materialChanges: ['NEW_THIRD_PARTY_RECEIVES_DATA'], approvalId: null, latencyMs: null });
    store.append(history, { at, routeId: 'r2', provider: 'openai', model: 'm', outcome: 'SUCCEEDED', failureClass: null, code: null, decision: null, materialChanges: [], approvalId: 'appr_x', latencyMs: 5000 });
    const again = new RouteHistoryStore({ dir: d }).get('pbp_aaaaaaaaaaaaaaaa.mockups.1', 'ten_a', 'usr_a')!;
    assert.deepEqual(again.attempts.map((x) => [x.n, x.provider, x.outcome]), [[1, 'google', 'FAILED'], [2, 'openai', 'SUCCEEDED']]);
    assert.equal(again.attempts[0].decision?.rankedBy, 'DETERMINISTIC');
    assert.equal(new RouteHistoryStore({ dir: d }).get('pbp_aaaaaaaaaaaaaaaa.mockups.1', 'ten_a', 'usr_other'), null);
    assert.equal(new RouteHistoryStore({ dir: d }).get('pbp_aaaaaaaaaaaaaaaa.mockups.1', 'ten_other', 'usr_a'), null);
  });
});
