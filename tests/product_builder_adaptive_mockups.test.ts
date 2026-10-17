// Goal-driven adaptive execution applied to the FIRST real target: the visual mockups of an approved Product Builder plan.
// "Generate a website mockup for the approved customer management product." - the first image provider fails; NAgex classifies the failure, discovers the other registered image routes, checks which are
// really available and authorized, ranks the eligible ones (deterministically, or with an advisor), asks the person when the terms change, executes the route the person approves, VERIFIES the bytes and
// carries the project on to the design decision. Every attempt is in a persistent history.
//
// The providers here are SCRIPTED STAND-INS (tests/_product_builder_fakes.ts) behind the real service, planner, ledger, history store and approval authority: this certifies the orchestration, NOT that any
// real image provider produced a picture (see tests/product_builder_live.test.ts and the evidence document for what the real Google adapter said).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ActionApprovalStore } from '../src/governance/action-approval.store.js';
import { RecoveryPlanner } from '../src/adaptive/recovery-planner.js';
import { RouteAdvisor, type RouteAdvisorPort } from '../src/adaptive/route-advisor.js';
import { routeIdOf } from '../src/adaptive/route-candidate.js';
import { RouteHistoryStore } from '../src/adaptive/route-history.store.js';
import { RouteOutcomeLedger } from '../src/adaptive/route-outcome-ledger.js';
import { describeImageRoute } from '../src/adaptive/image-route-catalog.js';
import { ImageProviderMockupAdapter } from '../src/product-builder/adapters/image-provider-mockup.adapter.js';
import { ProductBuilderService, ROUTE_SWITCH_TOOL_ID, type Identity } from '../src/product-builder/product-builder.service.js';
import { ProductProjectStore } from '../src/product-builder/product-builder.store.js';
import { ProductWorkspaceStore } from '../src/product-builder/product-workspace.js';
import type { ImageProviderPort, ProviderExecutionResult } from '../src/creation/providers/creation-provider.types.js';
import { FakeDeployer, FakeEngine, FakeMockups, FakePlanning, FakeTester, FetchVerifier } from './_product_builder_fakes.js';

const ME: Identity = { tenantId: 'ten_ad', ownerId: 'usr_ad' };
const OTHER: Identity = { tenantId: 'ten_ad', ownerId: 'usr_other' };
const REQUEST = 'Build me a customer management website with customer records, search and a dashboard.';
const deployers: FakeDeployer[] = [];

function rig(mockups: FakeMockups[], options: { advisor?: RouteAdvisor | null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-pba-'));
  const store = new ProductProjectStore({ dir });
  const approvals = new ActionApprovalStore();
  const history = new RouteHistoryStore({ dir: path.join(dir, 'history') });
  const ledger = new RouteOutcomeLedger({ dir: path.join(dir, 'ledger') });
  const slept: number[] = [];
  const engine = new FakeEngine();
  const deployer = new FakeDeployer(); deployers.push(deployer);
  const make = () => new ProductBuilderService({
    store, workspaces: new ProductWorkspaceStore(path.join(dir, 'workspaces')), approvals, planning: new FakePlanning(), mockups, engine, tester: new FakeTester(), deployers: [deployer], verifier: new FetchVerifier(),
    adaptive: { planner: new RecoveryPlanner({ advisor: options.advisor ?? null }), history, ledger, sleep: async (ms) => { slept.push(ms); } },
  });
  const svc = make();
  const toMockupStep = async (identity = ME) => {
    let p = svc.createProject(identity, { request: REQUEST, locale: 'en', requestId: 'req_ad' });
    p = await svc.advance(p.projectId, identity);
    return svc.decide(p.projectId, identity, 'PLAN', 'APPROVE', 'req_ad');
  };
  return { dir, store, approvals, history, ledger, slept, svc, make, toMockupStep };
}

const google = () => { const m = new FakeMockups('google', 'google'); m.outcome = 'QUOTA'; return m; };
const openai = () => new FakeMockups('openai', 'openai');
const unconfigured = (id: string) => { const m = new FakeMockups(id, id); m.isAvailable = false; return m; };

describe('image quota recovery: the goal outlives the provider', () => {
  it('classifies the failure, discovers the other image routes, filters what is not really available, ranks the rest, and stops for the person because the company changes - nothing was sent anywhere else', async () => {
    const g = google(); const o = openai(); const nim = unconfigured('nvidia-nim'); const local = unconfigured('local-gpu');
    const r = rig([g, o, nim, local]);
    const p = await r.toMockupStep();

    assert.equal(p.state, 'BLOCKED');
    assert.deepEqual([p.blocker?.code, p.blocker?.need, p.blocker?.blockedAt], ['IMAGE_QUOTA_EXCEEDED', 'QUOTA', 'MOCKUP_GENERATING']);
    const recovery = p.recovery!;
    assert.equal(recovery.failureClass, 'QUOTA_EXHAUSTED');
    assert.deepEqual([recovery.retry, recovery.fallback], ['NEVER', 'ALLOWED']);
    assert.equal(recovery.decision, 'SWITCH_ROUTE');
    assert.equal(recovery.requiresApproval, true);
    assert.equal(recovery.rankedBy, 'DETERMINISTIC');
    // ALTERNATIVE_DISCOVERY + ELIGIBILITY_FILTERING: the two unconfigured routes are not offered; the one that is really available is
    assert.deepEqual(recovery.options.map((x) => x.providerId), ['openai']);
    assert.deepEqual(recovery.options[0].changes.map((c) => c.kind).sort(), ['COST_UNKNOWN', 'NEW_THIRD_PARTY_RECEIVES_DATA']);
    assert.equal(recovery.options[0].costKnown, false);
    // the exhausted account was called once, never again; no other route was touched without the person
    assert.deepEqual([g.calls, o.calls, nim.calls, local.calls], [1, 0, 0, 0]);
    assert.equal(p.mockups, null, 'no picture was invented');
    // the ledger now knows: the next goal does not start by calling the exhausted account
    assert.ok(r.ledger.quotaExhaustedAt(routeIdOf('IMAGE_GENERATION', 'google', null)));
    // ROUTE_HISTORY: persistent, in order, with the normalized class and what the planner decided
    const view = r.svc.viewOf(p);
    assert.deepEqual(view.routeHistory.map((a) => [a.provider, a.outcome, a.failureClass]), [['google', 'FAILED', 'QUOTA_EXHAUSTED']]);
    assert.deepEqual([view.routeHistory[0].decision?.action, view.routeHistory[0].decision?.rankedBy], ['SWITCH_ROUTE', 'DETERMINISTIC']);
    assert.deepEqual(view.routeHistory[0].materialChanges.sort(), ['COST_UNKNOWN', 'NEW_THIRD_PARTY_RECEIVES_DATA']);
  });

  it('the person approves the other route: the approval is recorded through the Approval Authority bound to that route and its terms, the pictures are made, VERIFIED, stored, and the project reaches the design decision', async () => {
    const g = google(); const o = openai();
    const r = rig([g, o]);
    let p = await r.toMockupStep();
    p = await r.svc.resolveBlocker(p.projectId, ME, { mockupProviderId: 'openai', requestId: 'req_ad' });
    assert.equal(p.state, 'DESIGN_PENDING_APPROVAL');
    assert.equal(o.calls, 1);
    assert.deepEqual(p.mockups!.items.map((m) => [m.providerId, m.mimeType, m.width, m.height]), [['openai', 'image/png', 480, 300], ['openai', 'image/png', 480, 300], ['openai', 'image/png', 480, 300]]);
    assert.ok(p.mockups!.items.every((m) => /^[0-9a-f]{64}$/.test(m.sha256) && m.bytes > 0));
    assert.equal(p.recovery ?? null, null, 'nothing is waiting on a route decision any more');
    assert.equal(p.mockupProviderId, 'openai', 'later regenerations use the route that worked');

    const history = r.svc.viewOf(p).routeHistory;
    assert.deepEqual(history.map((a) => [a.provider, a.outcome]), [['google', 'FAILED'], ['openai', 'APPROVED'], ['openai', 'SUCCEEDED']]);
    const approvalId = history[1].approvalId!;
    const approval = r.approvals.get(approvalId, ME.tenantId, ME.ownerId)!;
    assert.deepEqual([approval.toolId, approval.status], [ROUTE_SWITCH_TOOL_ID, 'CONSUMED']);
    assert.equal(approval.canonicalPayload.toRouteId, routeIdOf('IMAGE_GENERATION', 'openai', null));
    assert.equal(approval.canonicalPayload.fromRouteId, routeIdOf('IMAGE_GENERATION', 'google', null));
    assert.deepEqual((approval.canonicalPayload.changes as string[]).slice().sort(), ['COST_UNKNOWN', 'NEW_THIRD_PARTY_RECEIVES_DATA']);
    assert.equal((approval.canonicalPayload.terms as { vendorId: string }).vendorId, 'openai');
    assert.ok(approval.usedAt && approval.executionId, 'used exactly once');
    assert.equal(r.approvals.get(approvalId, OTHER.tenantId, OTHER.ownerId), undefined, 'nobody else can see or use it');
  });

  it('a route that is not eligible cannot be chosen into eligibility: unconfigured, unknown, too sensitive - each is refused with the reason, and nothing is approved', async () => {
    const g = google(); const o = openai(); const off = unconfigured('nvidia-nim');
    const strict = new FakeMockups('strict-vendor', 'strict-vendor', 'S0');   // may receive only the lowest-sensitivity data; the plan is personal (S1)
    const r = rig([g, o, off, strict]);
    const p = await r.toMockupStep();
    await assert.rejects(() => r.svc.resolveBlocker(p.projectId, ME, { mockupProviderId: 'nvidia-nim', requestId: 'x' }), (e: any) => e.code === 'PRODUCT_ROUTE_NOT_ELIGIBLE' && /not configured/.test(e.message));
    await assert.rejects(() => r.svc.resolveBlocker(p.projectId, ME, { mockupProviderId: 'strict-vendor', requestId: 'x' }), (e: any) => e.code === 'PRODUCT_ROUTE_NOT_ELIGIBLE' && /sensitivity/.test(e.message));
    await assert.rejects(() => r.svc.resolveBlocker(p.projectId, ME, { mockupProviderId: 'nobody', requestId: 'x' }), (e: any) => e.code === 'PRODUCT_MOCKUP_PROVIDER_UNKNOWN');
    assert.deepEqual([r.svc.get(p.projectId, ME)!.state, o.calls, off.calls, strict.calls], ['BLOCKED', 0, 0, 0]);
    assert.equal(r.svc.viewOf(r.svc.get(p.projectId, ME)!).routeHistory.filter((a) => a.outcome === 'APPROVED').length, 0);
    assert.deepEqual(p.recovery!.options.map((x) => x.providerId), ['openai']);
  });

  it('nothing eligible: the project says exactly what is missing and stays resumable; once the cause is fixed the same route works again', async () => {
    const g = google();
    const r = rig([g, unconfigured('openai'), unconfigured('nvidia-nim')]);
    let p = await r.toMockupStep();
    const recovery = p.recovery!;
    assert.deepEqual([recovery.decision, recovery.abortReason], ['ABORT', 'NO_AUTHORIZED_ROUTE']);
    assert.deepEqual(recovery.missing.map((m) => m.provider).sort(), ['nvidia-nim', 'openai']);
    assert.ok(recovery.missing.every((m) => m.reasons.includes('NOT_CONFIGURED')));
    assert.equal(p.state, 'BLOCKED');
    // the restart keeps all of it
    const again = r.make().get(p.projectId, ME)!;
    assert.deepEqual([again.state, again.recovery?.abortReason], ['BLOCKED', 'NO_AUTHORIZED_ROUTE']);
    // the quota comes back: "I sorted it out" starts a new round on the same route, with a fresh budget
    g.outcome = 'OK';
    p = await r.svc.resolveBlocker(p.projectId, ME, { requestId: 'x' });
    assert.equal(p.state, 'DESIGN_PENDING_APPROVAL');
    assert.equal(g.calls, 2);
    assert.equal(r.ledger.quotaExhaustedAt(routeIdOf('IMAGE_GENERATION', 'google', null)), null, 'a success clears the quota mark');
    assert.deepEqual(r.svc.viewOf(p).routeHistory.map((a) => [a.provider, a.outcome]), [['google', 'FAILED'], ['google', 'SUCCEEDED']]);
  });

  it('a refusal (the provider declined the content) is not routed around: no alternative is offered and choosing one is refused', async () => {
    const g = new FakeMockups('google', 'google'); g.outcome = 'REFUSED';
    const o = openai();
    const r = rig([g, o]);
    const p = await r.toMockupStep();
    assert.equal(p.recovery!.failureClass, 'PERMISSION_DENIED');
    assert.deepEqual([p.recovery!.decision, p.recovery!.abortReason, p.recovery!.options.length], ['ABORT', 'PERMISSION_DENIED', 0]);
    await assert.rejects(() => r.svc.resolveBlocker(p.projectId, ME, { mockupProviderId: 'openai', requestId: 'x' }), (e: any) => e.code === 'PRODUCT_ROUTE_SWITCH_FORBIDDEN');
    assert.equal(o.calls, 0);
  });

  it('a request whose outcome is unknown (sent, no answer) is never duplicated or moved elsewhere until the person reconciles it', async () => {
    const g = new FakeMockups('google', 'google'); g.outcome = 'UNCERTAIN';
    const o = openai();
    const r = rig([g, o]);
    let p = await r.toMockupStep();
    assert.equal(p.recovery!.failureClass, 'UNKNOWN_OUTCOME');
    assert.deepEqual([p.recovery!.decision, p.recovery!.fallback, g.calls, o.calls], ['RECONCILE_FIRST', 'AFTER_RECONCILIATION', 1, 0]);
    // neither "try again" nor "use another" is possible before the person says what they found
    await assert.rejects(() => r.svc.resolveBlocker(p.projectId, ME, { requestId: 'x' }), (e: any) => e.code === 'PRODUCT_RECONCILIATION_REQUIRED');
    await assert.rejects(() => r.svc.resolveBlocker(p.projectId, ME, { mockupProviderId: 'openai', requestId: 'x' }), (e: any) => e.code === 'PRODUCT_RECONCILIATION_REQUIRED');
    assert.deepEqual([g.calls, o.calls], [1, 0]);
    p = await r.svc.resolveBlocker(p.projectId, ME, { mockupProviderId: 'openai', reconciliation: 'NOT_STARTED', requestId: 'x' });
    assert.equal(p.state, 'DESIGN_PENDING_APPROVAL');
    assert.deepEqual([g.calls, o.calls], [1, 1]);
    const earlier = r.history.get(`${p.projectId}.mockups.1.r0`, ME.tenantId, ME.ownerId)!;
    assert.equal(earlier.reconciliation?.outcome, 'CONFIRMED_NOT_STARTED', 'what the person found is part of the record');
  });

  it('a short outage is retried once on the same route (nothing is billed for it), then the work carries on - no approval, no switch', async () => {
    const g = new FakeMockups('google', 'google'); g.outcome = 'TRANSIENT'; g.transientFailures = 1;
    const r = rig([g, openai()]);
    const p = await r.toMockupStep();
    assert.equal(p.state, 'DESIGN_PENDING_APPROVAL');
    assert.equal(g.calls, 2);
    assert.deepEqual(r.slept, [1500]);
    assert.deepEqual(r.svc.viewOf(p).routeHistory.map((a) => [a.provider, a.outcome, a.failureClass]), [['google', 'RETRYING', 'PROVIDER_UNAVAILABLE'], ['google', 'SUCCEEDED', null]]);
  });

  it('an outage that persists is not retried without end: one retry, then the person is asked about the other route', async () => {
    const g = new FakeMockups('google', 'google'); g.outcome = 'TRANSIENT'; g.transientFailures = 99;
    const o = openai();
    const r = rig([g, o]);
    const p = await r.toMockupStep();
    assert.equal(g.calls, 2, 'one try and one retry, not more');
    assert.deepEqual([p.state, p.recovery!.decision, p.recovery!.options.map((x) => x.providerId)], ['BLOCKED', 'SWITCH_ROUTE', ['openai']]);
    assert.equal(o.calls, 0);
  });
});

describe('the advisor (JEV) ranks only what is eligible - and is optional', () => {
  const advisorOf = (answer: unknown | (() => Promise<unknown>), configured = true): RouteAdvisor => new RouteAdvisor({ provider: 'sim', configured: () => configured, advise: async () => (typeof answer === 'function' ? (answer as () => Promise<unknown>)() : answer) } as RouteAdvisorPort);

  it('a confident recommendation reorders the options; the person is still asked; the history says who ranked', async () => {
    const r = rig([google(), openai(), new FakeMockups('nvidia-nim', 'nvidia')], { advisor: advisorOf({ recommendedRouteId: routeIdOf('IMAGE_GENERATION', 'nvidia-nim', null), confidence: 0.9 }) });
    const p = await r.toMockupStep();
    assert.deepEqual([p.recovery!.rankedBy, p.recovery!.options.map((o) => o.providerId), p.recovery!.requiresApproval], ['ADVISOR', ['nvidia-nim', 'openai'], true]);
    assert.deepEqual(p.recovery!.advisor, { provider: 'sim', effect: 'REORDER', confidence: 0.9 });
    assert.equal(r.svc.viewOf(p).routeHistory[0].decision?.advisor, 'sim:REORDER');
  });

  it('a recommendation for a route that is not eligible is no advice: the deterministic order stands', async () => {
    const r = rig([google(), openai(), unconfigured('nvidia-nim')], { advisor: advisorOf({ recommendedRouteId: routeIdOf('IMAGE_GENERATION', 'nvidia-nim', null), confidence: 1 }) });
    const p = await r.toMockupStep();
    assert.deepEqual([p.recovery!.options.map((o) => o.providerId), p.recovery!.rankedBy], [['openai'], 'DETERMINISTIC_FALLBACK']);
  });

  it('an advisor that is down changes nothing except that the fallback is named', async () => {
    const r = rig([google(), openai()], { advisor: advisorOf(async () => { throw new Error('503'); }) });
    const p = await r.toMockupStep();
    assert.deepEqual([p.state, p.recovery!.rankedBy, p.recovery!.options.map((o) => o.providerId)], ['BLOCKED', 'DETERMINISTIC_FALLBACK', ['openai']]);
  });

  it('an advisor that says "ask the person" can only add a question', async () => {
    const r = rig([google(), openai()], { advisor: advisorOf({ recommendedRouteId: 'ASK_PERSON', confidence: 0.95 }) });
    const p = await r.toMockupStep();
    assert.deepEqual([p.recovery!.decision, p.recovery!.requiresApproval, p.recovery!.options.map((o) => o.providerId)], ['ASK_PERSON', true, ['openai']]);
  });
});

describe('the real adapter verifies the bytes: a "200" that is not an image is a failure of the goal, not a picture', () => {
  class Scripted implements ImageProviderPort {
    public calls = 0;
    constructor(public readonly providerId: string, private readonly makeResult: () => ProviderExecutionResult<{ imageBuffer?: Buffer; mimeType: string }>) {}
    getStatus() { return 'AVAILABLE' as const; }
    getCapabilities() { return { textToImage: true, imageToImage: false, editingInpainting: false, referenceImageConditioning: false, transparentBackground: false, textRendering: false, supportedAspectRatios: ['16:9'], maxReferenceImages: 0 }; }
    async generateImage() { this.calls += 1; return this.makeResult() as ProviderExecutionResult<{ imageUrl?: string; imageBuffer?: Buffer; mimeType: string }>; }
  }
  const completed = (buffer: Buffer, mime = 'image/png') => (): ProviderExecutionResult<{ imageBuffer?: Buffer; mimeType: string }> => ({ status: 'COMPLETED', output: { imageBuffer: buffer, mimeType: mime }, metadata: { providerId: 'p', createdAt: 'now' } });

  it('an error page is VERIFICATION_FAILED and is not kept; the other route is offered; the real image it makes is stored with its REAL type and size, not the claimed ones', async () => {
    const { STAND_IN_PNG } = await import('./_product_builder_fakes.js');
    const bad = new Scripted('google', completed(Buffer.from('<html><body>Please sign in to continue to the service.</body></html>'.repeat(4)), 'image/png'));
    const good = new Scripted('openai', completed(STAND_IN_PNG, 'image/jpeg'));   // mislabelled as jpeg: the real type wins
    // the REAL mockup adapter over scripted providers, described by the real catalog (so the vendors, their terms and their data limits are the ones NAgex declares)
    const mockups = [bad, good].map((p) => new ImageProviderMockupAdapter(p, '16:9', { route: () => describeImageRoute(p) }));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-pba-real-'));
    const svc = new ProductBuilderService({
      store: new ProductProjectStore({ dir }), workspaces: new ProductWorkspaceStore(path.join(dir, 'ws')), approvals: new ActionApprovalStore(), planning: new FakePlanning(), mockups,
      engine: null, tester: null, deployers: [], verifier: null, adaptive: { history: new RouteHistoryStore({ dir: path.join(dir, 'h') }), sleep: async () => undefined },
    });
    let p = svc.createProject(ME, { request: REQUEST, locale: 'en', requestId: 'x' });
    p = await svc.advance(p.projectId, ME);
    p = await svc.decide(p.projectId, ME, 'PLAN', 'APPROVE', 'x');
    assert.equal(p.state, 'BLOCKED');
    assert.deepEqual([p.blocker?.code, p.recovery?.failureClass, p.recovery?.options.map((o) => o.providerId)], ['IMAGE_VERIFICATION_FAILED', 'VERIFICATION_FAILED', ['openai']]);
    assert.equal(bad.calls, 1, 'a chargeable result that failed verification is not repeated');
    assert.equal(p.mockups, null, 'the error page was not stored as a mockup');
    p = await svc.resolveBlocker(p.projectId, ME, { mockupProviderId: 'openai', requestId: 'x' });
    assert.equal(p.state, 'DESIGN_PENDING_APPROVAL');
    assert.equal(good.calls, 3, 'three pictures, one request each');
    assert.deepEqual(p.mockups!.items.map((m) => [m.providerId, m.mimeType, m.width, m.height]), Array(3).fill(['openai', 'image/png', 480, 300]));
  });
});
