// The Product Builder's use of goal-driven adaptive execution, for ONE goal: "make the visual mockups of the approved plan".
//
// The picture provider that was tried first failing is not the end of the goal. This function runs the adaptive loop over the project's image routes - try a route, classify what happened, ask the
// planner what is next, record every attempt - and hands back either the verified pictures or the exact reason it STOPPED, with the proposal the person is asked to decide on. It executes nothing
// beyond the route calls themselves, grants no approval, and never switches to a route whose terms differ from what the person agreed to without stopping for their decision (the state machine that
// calls this carries that decision through the Approval Authority).
import { classifyFailure, type FailureEvidence } from '../adaptive/failure-taxonomy.js';
import { DEFAULT_BUDGET, type AdaptiveBudget, type AttemptSummary, type RecoveryDecision, type RecoveryPlanner } from '../adaptive/recovery-planner.js';
import { routeIdOf, type GoalNeeds, type RouteCandidate } from '../adaptive/route-candidate.js';
import type { RouteAttempt, RouteHistory, RouteHistoryStore } from '../adaptive/route-history.store.js';
import type { RouteOutcomeLedger } from '../adaptive/route-outcome-ledger.js';
import type { RankedCandidate } from '../adaptive/route-selection.js';
import type { MockupPort } from './product-builder.ports.js';
import type { BlockerNeed, ProductPlan, RecoveryProposal, RouteOptionView } from './product-builder.types.js';

/** What the mockups need of a route: text in, a 16:9 picture out, and the data is the person's own plan (personal, not sensitive). Nothing is authorized beyond free use unless the person says so. */
export const MOCKUP_NEEDS: GoalNeeds = Object.freeze({ capability: 'IMAGE_GENERATION', inputs: ['TEXT'], aspectRatio: '16:9', sensitivity: 'S1', maxCostUsd: null });

/** A port that does not describe itself is an UNKNOWN third party: it may receive only the lowest-sensitivity data, so it is not eligible for the person's plan. Unknown is never promoted to trusted. */
export function routeOf(port: MockupPort): RouteCandidate {
  if (port.route) return port.route();
  const available = port.available();
  return {
    routeId: routeIdOf('IMAGE_GENERATION', port.providerId, null), capability: 'IMAGE_GENERATION', provider: port.providerId, model: null, label: port.providerId,
    inputs: ['TEXT'], outputs: ['IMAGE'], limits: { aspectRatios: ['16:9'], maxReferenceImages: 0 },
    auth: available ? 'CONFIGURED' : 'UNCONFIGURED', availability: available ? 'AVAILABLE' : 'UNAVAILABLE', quota: 'UNKNOWN', quotaExhaustedAt: null,
    cost: { usd: null, unknown: true, basis: 'UNKNOWN' },
    dataHandling: { processing: 'THIRD_PARTY_CLOUD', vendorId: port.providerId, maxSensitivity: 'S0', region: null },
    approval: { required: true, reason: 'an unknown service' }, executionRoute: 'API', reliability: null,
  };
}

export function optionView(ranked: RankedCandidate): RouteOptionView {
  const c = ranked.candidate;
  return {
    routeId: c.routeId, providerId: c.provider, label: c.label, vendorId: c.dataHandling.vendorId, processing: c.dataHandling.processing, rank: ranked.rank,
    changes: ranked.changes.map((change) => ({ kind: change.kind, detail: change.detail })),
    costKnown: !c.cost.unknown && c.cost.usd !== null, usd: c.cost.unknown ? null : c.cost.usd,
  };
}

function summaries(history: RouteHistory): AttemptSummary[] {
  return history.attempts.map((a) => ({ routeId: a.routeId, outcome: a.outcome === 'AWAITING_APPROVAL' || a.outcome === 'APPROVED' || a.outcome === 'DECLINED' || a.outcome === 'SKIPPED' || a.outcome === 'RETRYING' || a.outcome === 'FAILED' || a.outcome === 'SUCCEEDED' ? a.outcome : 'FAILED', failureClass: a.failureClass }));
}

export interface MockupGoalArgs {
  goalId: string;
  tenantId: string;
  ownerId: string;
  /** every mockup route the project can use */
  ports: MockupPort[];
  /** the route to try first: the person's own choice, else the first one that is set up */
  first: MockupPort;
  plan: ProductPlan;
  count: number;
  feedback: string | null;
  planner: RecoveryPlanner;
  history: RouteHistoryStore;
  ledger: RouteOutcomeLedger | null;
  budget?: AdaptiveBudget;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  audit: (action: string, detail: string) => void;
}

interface MockupFailure { code: string; need: BlockerNeed; message: string; providerCode?: string; httpStatus?: number; retryAfterMs?: number; chargeable?: boolean }

export type MockupGoalResult =
  | { kind: 'IMAGES'; port: MockupPort; images: Array<{ caption: string; mimeType: string; data: Buffer; width?: number; height?: number; sha256?: string }> }
  | { kind: 'STOPPED'; code: string; need: BlockerNeed; message: string; recovery: RecoveryProposal };

const NEED_FOR: Record<string, BlockerNeed> = {
  QUOTA_EXHAUSTED: 'QUOTA', BILLING_REQUIRED: 'QUOTA', AUTHENTICATION_FAILURE: 'CREDENTIAL', CAPABILITY_UNAVAILABLE: 'CREDENTIAL', PERMISSION_DENIED: 'PERSON', RATE_LIMITED: 'QUOTA',
  PROVIDER_UNAVAILABLE: 'CONFIGURATION', TIMEOUT: 'CONFIGURATION', INPUT_UNSUPPORTED: 'CONFIGURATION', TRANSIENT_EXECUTION_FAILURE: 'PERSON', VERIFICATION_FAILED: 'PERSON', UNKNOWN_OUTCOME: 'PERSON',
};

function decisionNote(decision: RecoveryDecision): NonNullable<RouteAttempt['decision']> {
  switch (decision.action) {
    case 'RETRY_SAME_ROUTE': return { action: 'RETRY_SAME_ROUTE', rankedBy: null, advisor: null, reason: decision.classification.reason };
    case 'RECONCILE_FIRST': return { action: 'RECONCILE_FIRST', rankedBy: null, advisor: null, reason: decision.classification.reason };
    case 'ABORT': return { action: 'ABORT', rankedBy: null, advisor: null, reason: decision.reason };
    default: return { action: decision.action, rankedBy: decision.rankedBy, advisor: decision.advice ? `${decision.advice.provider}:${decision.advice.effect}` : null, reason: decision.requiresApproval ? 'the terms change: the person decides' : 'the terms do not change' };
  }
}

export async function runMockupGoal(args: MockupGoalArgs): Promise<MockupGoalResult> {
  const budget = args.budget ?? DEFAULT_BUDGET;
  const at = () => new Date(args.now()).toISOString();
  const history = args.history.ensure(args.goalId, args.tenantId, args.ownerId, 'IMAGE_GENERATION', at());
  let port = args.first;
  for (let guard = 0; guard < budget.maxAttempts + 2; guard += 1) {
    const route = routeOf(port);
    const startedAt = args.now();
    const outcome = port.available()
      ? await port.generate({ plan: args.plan, count: args.count, feedback: args.feedback, requestId: 'product-builder' })
      : { ok: false as const, code: 'IMAGE_PROVIDER_UNAVAILABLE', need: 'CREDENTIAL' as BlockerNeed, message: `The image provider (${port.providerId}) is not set up, so visual mockups cannot be made.`, providerCode: 'PROVIDER_UNCONFIGURED', chargeable: false };

    if (outcome.ok && outcome.images.length > 0) {
      args.ledger?.recordSuccess(route.routeId, args.now() - startedAt);
      args.history.append(history, { at: at(), routeId: route.routeId, provider: port.providerId, model: route.model, outcome: 'SUCCEEDED', failureClass: null, code: null, decision: { action: 'COMPLETE', rankedBy: null, advisor: null, reason: 'every picture is a real, complete image' }, materialChanges: [], approvalId: null, latencyMs: args.now() - startedAt });
      history.status = 'COMPLETED';
      args.history.save(history, at());
      return { kind: 'IMAGES', port, images: outcome.images };
    }

    const failure: MockupFailure = outcome.ok
      ? { code: 'NO_MOCKUPS_RETURNED', need: 'PERSON', message: 'The image provider returned no pictures.', providerCode: 'EMPTY_PROVIDER_RESULT', chargeable: true }
      : outcome;
    const evidence: FailureEvidence = {
      code: failure.providerCode ?? failure.code,
      ...(failure.httpStatus !== undefined ? { httpStatus: failure.httpStatus } : {}),
      ...(failure.retryAfterMs !== undefined ? { retryAfterMs: failure.retryAfterMs } : {}),
      phase: failure.chargeable === false ? 'BEFORE_SEND' : 'AFTER_SEND',
      chargeable: failure.chargeable !== false,
    };
    const classification = classifyFailure(evidence);
    args.ledger?.recordFailure(route.routeId, classification.failureClass);
    args.history.append(history, { at: at(), routeId: route.routeId, provider: port.providerId, model: route.model, outcome: 'FAILED', failureClass: classification.failureClass, code: failure.code, decision: null, materialChanges: [], approvalId: null, latencyMs: null });
    args.audit('adaptive.route_failed', `${route.routeId}:${classification.failureClass}`);

    // the candidates are read AFTER the failure was recorded, so a quota seen exhausted a moment ago is already out of the picture
    const decision = await args.planner.plan({
      needs: MOCKUP_NEEDS, failedRoute: route, failure: evidence, attempts: summaries(history), candidates: args.ports.map(routeOf), budget, now: args.now,
      ...(history.reconciliation ? { reconciliation: history.reconciliation.outcome } : {}),
    });
    args.history.amendLast(history, { decision: decisionNote(decision), materialChanges: decision.action === 'SWITCH_ROUTE' || decision.action === 'ASK_PERSON' ? decision.route.changes.map((c) => c.kind) : [], ...(decision.action === 'RETRY_SAME_ROUTE' ? { outcome: 'RETRYING' as const } : {}) }, at());

    if (decision.action === 'RETRY_SAME_ROUTE') {
      await args.sleep(decision.afterMs);
      continue;
    }
    if (decision.action === 'SWITCH_ROUTE' && !decision.requiresApproval) {
      const next = args.ports.find((p) => p.providerId === decision.route.candidate.provider);
      if (next) { args.audit('adaptive.route_switched', `${route.routeId}->${decision.route.candidate.routeId}`); port = next; continue; }
    }

    // stopped: for the person's decision, for a reconciliation, or because no authorized route is left. The state is kept; the goal is resumable.
    const proposal: RecoveryProposal = {
      goalId: args.goalId, at: at(), failureClass: classification.failureClass, retry: classification.retry, fallback: classification.fallback,
      decision: decision.action,
      requiresApproval: decision.action === 'SWITCH_ROUTE' || decision.action === 'ASK_PERSON' ? decision.requiresApproval : false,
      rankedBy: decision.action === 'SWITCH_ROUTE' || decision.action === 'ASK_PERSON' ? decision.rankedBy : null,
      advisor: decision.action === 'SWITCH_ROUTE' || decision.action === 'ASK_PERSON' ? decision.advice : null,
      options: decision.action === 'SWITCH_ROUTE' || decision.action === 'ASK_PERSON' ? decision.options.map(optionView) : [],
      missing: decision.action === 'ABORT' ? decision.missing : [],
      abortReason: decision.action === 'ABORT' ? decision.reason : null,
      failedRouteId: route.routeId, failedProvider: port.providerId,
    };
    if (decision.action === 'ABORT') { history.status = decision.reason === 'BUDGET_EXHAUSTED' ? 'EXHAUSTED' : 'ACTIVE'; args.history.save(history, at()); }
    args.audit('adaptive.route_stopped', `${route.routeId}:${proposal.decision}`);
    return { kind: 'STOPPED', code: failure.code, need: failure.need ?? NEED_FOR[classification.failureClass] ?? 'PERSON', message: failure.message, recovery: proposal };
  }
  // the loop is bounded by the budget; reaching here means every allowed attempt was used
  const proposal: RecoveryProposal = { goalId: args.goalId, at: at(), failureClass: 'TRANSIENT_EXECUTION_FAILURE', retry: 'NEVER', fallback: 'ALLOWED', decision: 'ABORT', requiresApproval: false, rankedBy: null, advisor: null, options: [], missing: [], abortReason: 'BUDGET_EXHAUSTED', failedRouteId: routeOf(port).routeId, failedProvider: port.providerId };
  return { kind: 'STOPPED', code: 'ADAPTIVE_BUDGET_EXHAUSTED', need: 'PERSON', message: 'Every allowed attempt was used without a usable picture.', recovery: proposal };
}
