// AI Product Builder - the WORKFLOW: a persistent, resumable state machine with four human gates, driven through scripted stand-ins for every external capability (tests/_product_builder_fakes.ts).
// What this pins: nothing runs before its gate; every approval is bound to the version and hash of what the person saw and is used once; a change redoes what depended on it; anything that cannot be
// done for lack of a credential / quota / authorization / sandbox / engine ends BLOCKED with the reason (and a different authorized image provider can be chosen); an uncertain deployment is never
// repeated; "deployed" needs the address to answer with this build; ownership is absolute; a restart resumes. The planning model, image provider, coding engine and hosting account are NOT exercised
// here - they are separate live checks, reported on their own.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { ActionApprovalStore } from '../src/governance/action-approval.store.js';
import { ProductBuilderService, stampIndexHtml, type Identity } from '../src/product-builder/product-builder.service.js';
import { ProductProjectStore } from '../src/product-builder/product-builder.store.js';
import { ProductWorkspaceStore, WORKSPACE_LIMITS, checkWorkspacePath } from '../src/product-builder/product-workspace.js';
import { ALLOWED_TRANSITIONS, GATE_STATE, isAllowedTransition, type ProductProjectRecord, type ProjectGate, type ProjectState } from '../src/product-builder/product-builder.types.js';
import { FakeDeployer, FakeEngine, FakeMockups, FakePlanning, FakeTester, FetchVerifier, siteFiles } from './_product_builder_fakes.js';

const ME: Identity = { tenantId: 'ten_pb', ownerId: 'usr_pb' };
const OTHER: Identity = { tenantId: 'ten_pb', ownerId: 'usr_other' };
const REQUEST = 'Build me a customer management website with customer records, search and a dashboard, and put it online.';
const deployers: FakeDeployer[] = [];
after(async () => { for (const d of deployers) await d.close(); });

function rig(options: { mockups?: FakeMockups[]; engine?: FakeEngine | null; tester?: FakeTester | null; deployer?: FakeDeployer | null; verifier?: FetchVerifier | null; planning?: FakePlanning | null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-pb-'));
  const store = new ProductProjectStore({ dir });
  const workspaces = new ProductWorkspaceStore(path.join(dir, 'workspaces'));
  const approvals = new ActionApprovalStore();
  const planning = options.planning === undefined ? new FakePlanning() : options.planning;
  const mockups = options.mockups ?? [new FakeMockups()];
  const engine = options.engine === undefined ? new FakeEngine() : options.engine;
  const tester = options.tester === undefined ? new FakeTester() : options.tester;
  const deployer = options.deployer === undefined ? new FakeDeployer() : options.deployer;
  if (deployer) deployers.push(deployer);
  const verifier = options.verifier === undefined ? new FetchVerifier() : options.verifier;
  const make = () => new ProductBuilderService({ store, workspaces, approvals, planning, mockups, engine, tester, deployers: deployer ? [deployer] : [], verifier, maxRepairAttempts: 2 });
  const svc = make();
  const create = async (identity = ME) => svc.createProject(identity, { request: REQUEST, locale: 'en', requestId: 'req_pb' });
  const toGate = async (gate: ProjectGate): Promise<ProductProjectRecord> => {
    let p = await create();
    p = await svc.advance(p.projectId, ME);
    const order: ProjectGate[] = ['PLAN', 'DESIGN', 'BUILD'];
    for (const g of order) {
      if (p.state === GATE_STATE[gate]) return p;
      p = await svc.decide(p.projectId, ME, g, 'APPROVE', 'req_pb');
    }
    return p;
  };
  return { dir, store, workspaces, approvals, planning, mockups, engine, tester, deployer, verifier, svc, make, create, toGate };
}

const states = (p: ProductProjectRecord): ProjectState[] => p.history.map((h) => h.state);

describe('the whole way, with a person at every gate', () => {
  it('request -> plan -> [gate 1] -> mockups + design -> [gate 2] -> build plan -> [gate 3] -> implement -> test -> preview -> [gate 4] -> deploy -> verified', async () => {
    const r = rig();
    let p = await r.create();
    assert.equal(p.state, 'REQUIREMENTS_DRAFT');
    assert.deepEqual([r.mockups[0].calls, r.engine!.calls.length, r.tester!.runs, r.deployer!.calls], [0, 0, 0, 0], 'nothing has run');

    p = await r.svc.advance(p.projectId, ME);
    assert.equal(p.state, 'PLAN_PENDING_APPROVAL');
    assert.equal(p.plan?.version, 1);
    assert.equal(r.svc.approvalStatus(p, 'PLAN'), 'PENDING');
    assert.deepEqual([r.mockups[0].calls, r.engine!.calls.length, r.deployer!.calls], [0, 0, 0], 'no mockups, no code, no hosting before the plan is approved');
    p = await r.svc.advance(p.projectId, ME);
    assert.equal(p.state, 'PLAN_PENDING_APPROVAL', 'waiting is stable: advancing again does not approve anything');

    p = await r.svc.decide(p.projectId, ME, 'PLAN', 'APPROVE', 'req_pb');
    assert.equal(p.state, 'DESIGN_PENDING_APPROVAL');
    assert.equal(r.mockups[0].calls, 1);
    assert.equal(p.mockups?.items.length, 3);
    assert.ok(p.mockups!.items.every((m) => m.providerId === 'mock-image-provider' && m.bytes > 0));
    assert.equal(p.design?.version, 1);
    assert.equal(r.engine!.calls.length, 0, 'still no code: the build gate has not been passed');

    p = await r.svc.decide(p.projectId, ME, 'DESIGN', 'APPROVE', 'req_pb');
    assert.equal(p.state, 'BUILD_PLAN_PENDING_APPROVAL');
    // what is true is NAgex's to say: the model's invented engine, framework, database and host are replaced by what exists
    assert.equal(p.buildPlan?.content.engine.id, 'mock-engine');
    assert.match(p.buildPlan!.content.framework, /Static HTML/);
    assert.match(p.buildPlan!.content.database, /None/);
    assert.equal(p.buildPlan?.content.deployTarget.provider, 'mock-host');
    assert.equal(r.engine!.calls.length, 0, 'still no code');

    p = await r.svc.decide(p.projectId, ME, 'BUILD', 'APPROVE', 'req_pb');
    assert.equal(p.state, 'PREVIEW_READY');
    assert.equal(r.engine!.calls.length, 1);
    assert.equal(r.tester!.runs, 1);
    assert.equal(p.test?.passed, true);
    assert.ok(p.workspace!.files.some((f) => f.path === 'index.html'));
    const index = r.workspaces.read(p.projectId, p.workspace!.workspaceId, 'index.html')!.toString('utf8');
    assert.ok(index.includes(`<meta name="nagex-build" content="${p.workspace!.marker}">`), 'NAgex stamped the build marker itself');
    assert.equal(r.deployer!.calls, 0, 'nothing is deployed before the deploy gate');

    p = r.svc.requestDeploy(p.projectId, ME, { requestId: 'req_pb', appName: 'Customer Hub' });
    assert.equal(p.state, 'DEPLOY_PENDING_APPROVAL');
    assert.equal(p.deploy?.appName, 'customer-hub');
    assert.equal(p.deploy?.target.exposure, 'PUBLIC');
    assert.equal(r.deployer!.calls, 0, 'asking to deploy deploys nothing');

    p = await r.svc.decide(p.projectId, ME, 'DEPLOY', 'APPROVE', 'req_pb');
    assert.equal(p.state, 'DEPLOYED_VERIFIED');
    assert.equal(r.deployer!.calls, 1);
    assert.ok(p.deploy?.url?.startsWith('http://127.0.0.1:'));
    assert.deepEqual([p.deploy?.verification?.reachable, p.deploy?.verification?.markerFound, p.deploy?.verification?.smokePassed], [true, true, true]);
    assert.ok(p.deploy?.verifiedAt);

    // the proof that nothing past a gate ran without it
    assert.deepEqual(p.passedGates.map((g) => g.gate), ['PLAN', 'DESIGN', 'BUILD', 'DEPLOY']);
    for (const gate of ['PLAN', 'DESIGN', 'BUILD', 'DEPLOY'] as ProjectGate[]) assert.equal(r.svc.approvalStatus(p, gate), 'CONSUMED', `${gate} approval was used exactly once`);
    const order = states(p);
    for (const [a, b] of [['PLAN_PENDING_APPROVAL', 'PLAN_APPROVED'], ['PLAN_APPROVED', 'MOCKUP_GENERATING'], ['DESIGN_PENDING_APPROVAL', 'DESIGN_APPROVED'], ['BUILD_PLAN_PENDING_APPROVAL', 'BUILD_APPROVED'], ['BUILD_APPROVED', 'IMPLEMENTING'], ['IMPLEMENTING', 'TESTING'], ['TESTING', 'PREVIEW_READY'], ['DEPLOY_PENDING_APPROVAL', 'DEPLOYING'], ['DEPLOYING', 'DEPLOYED_VERIFIED']] as Array<[ProjectState, ProjectState]>) {
      assert.ok(order.indexOf(a) >= 0 && order.indexOf(b) > order.indexOf(a), `${a} before ${b}`);
    }
    // a finished project stays finished
    assert.equal(r.svc.cancel(p.projectId, ME, 'req_pb').state, 'DEPLOYED_VERIFIED');
  });
});

describe('approvals are bound to what the person saw', () => {
  it('declining a gate does not move the project; changes make a NEW version that needs a NEW approval, and the old approval can never be used', async () => {
    const r = rig();
    let p = await r.create();
    p = await r.svc.advance(p.projectId, ME);
    const first = p.approvals.PLAN!.approvalId;
    p = await r.svc.decide(p.projectId, ME, 'PLAN', 'DECLINE', 'req_pb');
    assert.equal(p.state, 'PLAN_PENDING_APPROVAL');
    assert.equal(r.svc.approvalStatus(p, 'PLAN'), 'REJECTED');
    assert.equal(r.mockups[0].calls, 0);

    p = await r.svc.revise(p.projectId, ME, 'PLAN', 'add an invoices page', 'req_pb');
    assert.equal(p.state, 'PLAN_PENDING_APPROVAL');
    assert.equal(p.plan?.version, 2);
    assert.match(p.plan!.content.summary, /added|changed: add an invoices page/);
    assert.notEqual(p.approvals.PLAN!.approvalId, first, 'a new approval for the new version');
    assert.equal(p.approvals.PLAN!.version, 2);
    // the first approval is dead
    assert.throws(() => r.approvals.approve(first, ME.tenantId, ME.ownerId), (e: any) => ['APPROVAL_NOT_PENDING', 'APPROVAL_NOT_FOUND'].includes(e.code));
  });

  it('an approval given to version 1 does not carry over to version 2 even if it was already granted when the change came', async () => {
    const r = rig();
    let p = await r.create();
    p = await r.svc.advance(p.projectId, ME);
    const v1 = p.approvals.PLAN!.approvalId;
    r.approvals.approve(v1, ME.tenantId, ME.ownerId);             // the person approved version 1 (through the normal approvals API)...
    p = await r.svc.revise(p.projectId, ME, 'PLAN', 'also a reports page', 'req_pb'); // ...and the plan changed before NAgex acted on it
    p = await r.svc.advance(p.projectId, ME);
    assert.equal(p.state, 'PLAN_PENDING_APPROVAL', 'version 2 still waits for ITS approval');
    assert.equal(r.svc.approvalStatus(p, 'PLAN'), 'PENDING');
    assert.equal(r.mockups[0].calls, 0);
    p = await r.svc.decide(p.projectId, ME, 'PLAN', 'APPROVE', 'req_pb');
    assert.equal(p.state, 'DESIGN_PENDING_APPROVAL');
    assert.equal(p.passedGates[0].version, 2);
  });

  it('a stored artifact that no longer matches the approval it was approved under is not moved past: a fresh approval is requested for what exists now', async () => {
    const r = rig();
    let p = await r.create();
    p = await r.svc.advance(p.projectId, ME);
    r.approvals.approve(p.approvals.PLAN!.approvalId, ME.tenantId, ME.ownerId);
    const stored = r.store.getOwned(p.projectId, ME.tenantId, ME.ownerId)!;
    stored.plan = { ...stored.plan!, version: 2, hash: 'f'.repeat(64) };    // the plan changed behind the approval's back
    r.store.save(stored);
    p = await r.svc.advance(p.projectId, ME);
    assert.equal(p.state, 'PLAN_PENDING_APPROVAL');
    assert.ok(p.history.some((h) => h.event === 'APPROVAL_STALE'));
    assert.equal(p.passedGates.length, 0, 'no gate was passed on a stale approval');
    assert.equal(r.mockups[0].calls, 0);
    assert.equal(p.approvals.PLAN!.version, 2, 'a new approval for version 2');
  });

  it('a change at the build plan can reach back to the plan: everything after it is redone and every later approval is withdrawn', async () => {
    const r = rig();
    let p = await r.toGate('BUILD');
    assert.equal(p.state, 'BUILD_PLAN_PENDING_APPROVAL');
    const designApproval = p.passedGates.find((g) => g.gate === 'DESIGN')!;
    assert.equal(designApproval.version, 1);
    p = await r.svc.revise(p.projectId, ME, 'PLAN', 'make it a booking site instead', 'req_pb');
    assert.equal(p.state, 'PLAN_PENDING_APPROVAL');
    assert.equal(p.plan?.version, 2);
    assert.equal(p.design, null, 'the design that depended on the old plan is dropped');
    assert.equal(p.buildPlan, null);
    assert.equal(p.passedGates.length, 0, 'every gate must be passed again');
    assert.equal(r.engine!.calls.length, 0);
  });

  it('changes asked for at a gate the project is not at (or a later one) are refused', async () => {
    const r = rig();
    const p = await r.create();
    await r.svc.advance(p.projectId, ME);
    await assert.rejects(() => r.svc.revise(p.projectId, ME, 'DESIGN', 'bigger buttons', 'req_pb'), (e: any) => e.code === 'PRODUCT_GATE_NOT_WAITING');
    await assert.rejects(() => r.svc.decide(p.projectId, ME, 'BUILD', 'APPROVE', 'req_pb'), (e: any) => e.code === 'PRODUCT_GATE_NOT_WAITING');
    await assert.rejects(() => r.svc.revise(p.projectId, ME, 'PLAN', '   ', 'req_pb'), (e: any) => e.code === 'PRODUCT_FEEDBACK_REQUIRED');
  });
});

describe('what cannot be done ends BLOCKED with the reason - never a pretend result', () => {
  it('image quota: the project is blocked with the exact reason, and continues only when the person chooses another AUTHORIZED provider', async () => {
    const quota = new FakeMockups('image-provider-a'); quota.outcome = 'QUOTA';
    const other = new FakeMockups('image-provider-b');
    const r = rig({ mockups: [quota, other] });
    // the first provider that is available is used: a, which is out of quota
    let p = await r.create();
    p = await r.svc.advance(p.projectId, ME);
    p = await r.svc.decide(p.projectId, ME, 'PLAN', 'APPROVE', 'req_pb');
    assert.equal(p.state, 'BLOCKED');
    assert.equal(p.blocker?.need, 'QUOTA');
    assert.equal(p.blocker?.code, 'IMAGE_QUOTA_EXCEEDED');
    assert.equal(p.blocker?.blockedAt, 'MOCKUP_GENERATING');
    assert.deepEqual(p.recovery!.options.map((o) => o.providerId), ['image-provider-b'], 'the person is told another provider exists');
    assert.equal(p.mockups, null, 'no mockups were invented');
    assert.equal(other.calls, 0, 'NAgex did not switch provider on its own');
    assert.equal(r.engine!.calls.length, 0);

    await assert.rejects(() => r.svc.resolveBlocker(p.projectId, ME, { mockupProviderId: 'not-a-provider', requestId: 'req_pb' }), (e: any) => e.code === 'PRODUCT_MOCKUP_PROVIDER_UNKNOWN');
    p = await r.svc.resolveBlocker(p.projectId, ME, { mockupProviderId: 'image-provider-b', requestId: 'req_pb' });
    assert.equal(p.state, 'DESIGN_PENDING_APPROVAL');
    assert.equal(other.calls, 1);
    assert.ok(p.mockups!.items.every((m) => m.providerId === 'image-provider-b'));
  });

  it('no image provider at all, an unconfigured one, or one that returns nothing: blocked, no placeholder pictures', async () => {
    for (const [label, mockups, code] of [
      ['none', [] as FakeMockups[], 'NO_IMAGE_PROVIDER'],
      ['unconfigured', (() => { const m = new FakeMockups(); m.isAvailable = false; return [m]; })(), 'IMAGE_PROVIDER_UNAVAILABLE'],
      ['empty', (() => { const m = new FakeMockups(); m.outcome = 'EMPTY'; return [m]; })(), 'NO_MOCKUPS_RETURNED'],
    ] as Array<[string, FakeMockups[], string]>) {
      const r = rig({ mockups });
      let p = await r.create();
      p = await r.svc.advance(p.projectId, ME);
      p = await r.svc.decide(p.projectId, ME, 'PLAN', 'APPROVE', 'req_pb');
      assert.equal(p.state, 'BLOCKED', label);
      assert.equal(p.blocker?.code, code, label);
      assert.equal(p.mockups, null, label);
      assert.equal(p.design, null, `${label}: no design without mockups`);
    }
  });

  it('no coding engine / an unavailable one / no isolated test runner: blocked at the right step, nothing built or run', async () => {
    const a = rig({ engine: null });
    let p = await a.toGate('BUILD');
    p = await a.svc.decide(p.projectId, ME, 'BUILD', 'APPROVE', 'req_pb');
    assert.deepEqual([p.state, p.blocker?.code, p.blocker?.need, p.blocker?.blockedAt], ['BLOCKED', 'NO_CODING_ENGINE', 'ENGINE', 'IMPLEMENTING']);
    assert.match(p.buildPlan!.content.credentialsNeeded.join(' '), /coding engine/i, 'the build plan said so before the person approved it');

    const unavailable = new FakeEngine(); unavailable.isAvailable = false;
    const b = rig({ engine: unavailable });
    p = await b.toGate('BUILD');
    p = await b.svc.decide(p.projectId, ME, 'BUILD', 'APPROVE', 'req_pb');
    assert.equal(p.blocker?.code, 'CODING_ENGINE_UNAVAILABLE');
    assert.equal(unavailable.calls.length, 0);

    const c = rig({ tester: null });
    p = await c.toGate('BUILD');
    p = await c.svc.decide(p.projectId, ME, 'BUILD', 'APPROVE', 'req_pb');
    assert.deepEqual([p.state, p.blocker?.code, p.blocker?.need], ['BLOCKED', 'NO_ISOLATED_TEST_RUNNER', 'SANDBOX']);
    assert.ok(p.workspace, 'the files exist but were never run');
  });

  it('no hosting account: deployment cannot even be asked for; the preview still works; nothing is deployed', async () => {
    const r = rig({ deployer: null });
    let p = await r.toGate('BUILD');
    p = await r.svc.decide(p.projectId, ME, 'BUILD', 'APPROVE', 'req_pb');
    assert.equal(p.state, 'PREVIEW_READY');
    assert.throws(() => r.svc.requestDeploy(p.projectId, ME, { requestId: 'req_pb' }), (e: any) => e.code === 'PRODUCT_DEPLOY_NOT_CONFIGURED');
    const unconfigured = new FakeDeployer(); unconfigured.isConfigured = false;
    const s = rig({ deployer: unconfigured });
    p = await s.toGate('BUILD');
    p = await s.svc.decide(p.projectId, ME, 'BUILD', 'APPROVE', 'req_pb');
    assert.throws(() => s.svc.requestDeploy(p.projectId, ME, { requestId: 'req_pb' }), (e: any) => e.code === 'PRODUCT_DEPLOY_NOT_CONFIGURED');
    assert.equal(unconfigured.calls, 0);
  });

  it('a failing check sends the product back to the engine with what failed (bounded); a product that still fails is FAILED and is never previewed or deployed', async () => {
    const repaired = rig();
    repaired.tester!.results = [false, true];
    let p = await repaired.toGate('BUILD');
    p = await repaired.svc.decide(p.projectId, ME, 'BUILD', 'APPROVE', 'req_pb');
    assert.equal(p.state, 'PREVIEW_READY');
    assert.equal(repaired.engine!.calls.length, 2);
    assert.ok(repaired.engine!.calls[1].hadPrevious && repaired.engine!.calls[1].repairHints.length > 0, 'the second attempt was told what failed');

    const hopeless = rig();
    hopeless.tester!.results = [false];
    p = await hopeless.toGate('BUILD');
    p = await hopeless.svc.decide(p.projectId, ME, 'BUILD', 'APPROVE', 'req_pb');
    assert.equal(p.state, 'FAILED');
    assert.equal(p.failure?.code, 'TESTS_FAILED');
    assert.equal(hopeless.engine!.calls.length, 3, 'one build and two repairs');
    assert.throws(() => hopeless.svc.requestDeploy(p.projectId, ME, { requestId: 'req_pb' }), (e: any) => e.code === 'PRODUCT_NOT_READY_FOR_DEPLOY');
  });

  it('a build that produces no index.html, an escaping path or an oversized file fails the project with the reason', async () => {
    for (const [label, files, code] of [
      ['no index', () => [{ path: 'app.js', content: 'x' }], 'NO_INDEX_HTML'],
      ['traversal', () => [...siteFiles(), { path: '../evil.js', content: 'x' }], 'WORKSPACE_PATH_TRAVERSAL'],
      ['huge', () => [...siteFiles(), { path: 'big.js', content: 'x'.repeat(WORKSPACE_LIMITS.maxFileBytes + 1) }], 'WORKSPACE_FILE_TOO_LARGE'],
    ] as Array<[string, () => Array<{ path: string; content: string }>, string]>) {
      const engine = new FakeEngine(); engine.files = files;
      const r = rig({ engine });
      let p = await r.toGate('BUILD');
      p = await r.svc.decide(p.projectId, ME, 'BUILD', 'APPROVE', 'req_pb');
      assert.equal(p.state, 'FAILED', label);
      assert.equal(p.failure?.code, code, label);
      assert.equal(r.tester!.runs, 0, `${label}: nothing was tested or run`);
    }
  });

  it('a planning model that is down or keeps giving unusable answers BLOCKS the step (it does not end the project), and the person can try again', async () => {
    const down = rig();
    down.planning!.failWith = Object.assign(new Error('the model could not be reached'), { code: 'PRODUCT_PLANNER_UNAVAILABLE' });
    let p = await down.create();
    p = await down.svc.advance(p.projectId, ME);
    assert.deepEqual([p.state, p.blocker?.code, p.blocker?.need, p.blocker?.blockedAt], ['BLOCKED', 'PLANNER_UNAVAILABLE', 'CONFIGURATION', 'REQUIREMENTS_DRAFT']);
    assert.equal(p.plan, null, 'no plan was invented');
    down.planning!.failWith = null;
    p = await down.svc.resolveBlocker(p.projectId, ME, { requestId: 'req_pb' });
    assert.equal(p.state, 'PLAN_PENDING_APPROVAL');

    const garbage = rig();
    garbage.planning!.failWith = Object.assign(new Error('not a plan'), { code: 'PRODUCT_PLAN_INVALID' });
    p = await garbage.create();
    p = await garbage.svc.advance(p.projectId, ME);
    assert.deepEqual([p.state, p.blocker?.code, p.blocker?.need], ['BLOCKED', 'PLANNER_OUTPUT_INVALID', 'PERSON']);
  });

  it('a change request whose redraft fails changes NOTHING: the earlier version and its approval still stand', async () => {
    const r = rig();
    let p = await r.create();
    p = await r.svc.advance(p.projectId, ME);
    const before = { version: p.plan!.version, hash: p.plan!.hash, approvalId: p.approvals.PLAN!.approvalId };
    r.planning!.failWith = Object.assign(new Error('down'), { code: 'PRODUCT_PLANNER_UNAVAILABLE' });
    await assert.rejects(() => r.svc.revise(p.projectId, ME, 'PLAN', 'add invoices', 'req_pb'), (e: any) => e.code === 'PRODUCT_PLANNER_UNAVAILABLE');
    p = r.svc.get(p.projectId, ME)!;
    assert.deepEqual([p.state, p.plan!.version, p.plan!.hash, p.approvals.PLAN!.approvalId], ['PLAN_PENDING_APPROVAL', before.version, before.hash, before.approvalId]);
    assert.equal(r.svc.approvalStatus(p, 'PLAN'), 'PENDING', 'the approval was not withdrawn');
    r.planning!.failWith = null;
    p = await r.svc.decide(p.projectId, ME, 'PLAN', 'APPROVE', 'req_pb');
    assert.equal(p.state, 'DESIGN_PENDING_APPROVAL', 'the original plan can still be approved');
  });

  it('when only the design draft fails, the pictures that were already made are kept and NOT made (or paid for) again', async () => {
    const r = rig();
    r.planning!.failDesign = Object.assign(new Error('down'), { code: 'PRODUCT_PLANNER_UNAVAILABLE' });
    let p = await r.create();
    p = await r.svc.advance(p.projectId, ME);
    p = await r.svc.decide(p.projectId, ME, 'PLAN', 'APPROVE', 'req_pb');
    assert.deepEqual([p.state, p.blocker?.code, r.mockups[0].calls, p.mockups?.items.length], ['BLOCKED', 'PLANNER_UNAVAILABLE', 1, 3]);
    r.planning!.failDesign = null;
    p = await r.svc.resolveBlocker(p.projectId, ME, { requestId: 'req_pb' });
    assert.equal(p.state, 'DESIGN_PENDING_APPROVAL');
    assert.equal(r.mockups[0].calls, 1, 'the image provider was called once in total');
  });
});

describe('deployment: sent once, verified before it is called deployed', () => {
  async function toDeployGate(r: ReturnType<typeof rig>): Promise<ProductProjectRecord> {
    let p = await r.toGate('BUILD');
    p = await r.svc.decide(p.projectId, ME, 'BUILD', 'APPROVE', 'req_pb');
    return r.svc.requestDeploy(p.projectId, ME, { requestId: 'req_pb' });
  }

  it('the address must answer with THIS build: a provider that accepts the files but serves something else is FAILED, not "deployed"', async () => {
    const wrong = new FakeDeployer(); wrong.mode = 'WRONG_CONTENT';
    const r = rig({ deployer: wrong });
    let p = await toDeployGate(r);
    p = await r.svc.decide(p.projectId, ME, 'DEPLOY', 'APPROVE', 'req_pb');
    assert.equal(p.state, 'FAILED');
    assert.equal(p.failure?.code, 'DEPLOY_NOT_VERIFIED');
    assert.equal(p.deploy?.verification?.markerFound, false);
    assert.ok(p.deploy?.url, 'the address is kept so the person can look');
    assert.equal(p.deploy?.verifiedAt, null);

    const smoke = rig(); smoke.verifier!.smoke = false;
    p = await toDeployGate(smoke);
    p = await smoke.svc.decide(p.projectId, ME, 'DEPLOY', 'APPROVE', 'req_pb');
    assert.equal(p.state, 'FAILED', 'a page that fails its smoke checks is not "deployed"');

    const none = rig({ verifier: null });
    p = await toDeployGate(none);
    p = await none.svc.decide(p.projectId, ME, 'DEPLOY', 'APPROVE', 'req_pb');
    assert.deepEqual([p.state, p.blocker?.code], ['BLOCKED', 'NO_DEPLOY_VERIFIER'], 'no way to verify = not reported as deployed');
  });

  it('an uncertain outcome is never retried: blocked for the person, and resuming does not send a second deployment', async () => {
    const flaky = new FakeDeployer(); flaky.mode = 'UNCERTAIN';
    const r = rig({ deployer: flaky });
    let p = await toDeployGate(r);
    p = await r.svc.decide(p.projectId, ME, 'DEPLOY', 'APPROVE', 'req_pb');
    assert.deepEqual([p.state, p.blocker?.code, p.blocker?.need], ['BLOCKED', 'DEPLOY_STATE_UNCERTAIN', 'PERSON']);
    assert.equal(flaky.calls, 1);
    p = await r.svc.resolveBlocker(p.projectId, ME, { requestId: 'req_pb' });
    assert.equal(p.state, 'BLOCKED');
    assert.equal(p.blocker?.code, 'DEPLOY_STATE_UNCERTAIN');
    assert.equal(flaky.calls, 1, 'NOT sent a second time');
  });

  it('a refusal by the hosting provider (credentials) is a block with its reason; the deployment gate approval stays consumed (a new approval is a new request)', async () => {
    const refused = new FakeDeployer(); refused.mode = 'REFUSED';
    const r = rig({ deployer: refused });
    let p = await toDeployGate(r);
    p = await r.svc.decide(p.projectId, ME, 'DEPLOY', 'APPROVE', 'req_pb');
    assert.deepEqual([p.state, p.blocker?.code, p.blocker?.need], ['BLOCKED', 'HOST_REFUSED', 'AUTHORIZATION']);
    assert.equal(r.svc.approvalStatus(p, 'DEPLOY'), 'CONSUMED');
  });

  it('the deployment approval is bound to the exact target AND files: a different app name is a different approval; declining sends nothing', async () => {
    const r = rig();
    let p = await toDeployGate(r);
    const first = p.approvals.DEPLOY!;
    p = r.svc.requestDeploy(p.projectId, ME, { requestId: 'req_pb', appName: 'another-name' });
    assert.notEqual(p.approvals.DEPLOY!.approvalId, first.approvalId);
    assert.notEqual(p.approvals.DEPLOY!.hash, first.hash, 'a different target is a different hash');
    assert.throws(() => r.approvals.approve(first.approvalId, ME.tenantId, ME.ownerId), (e: any) => e.code === 'APPROVAL_NOT_PENDING', 'the earlier request can no longer be approved');
    p = await r.svc.decide(p.projectId, ME, 'DEPLOY', 'DECLINE', 'req_pb');
    assert.equal(p.state, 'DEPLOY_PENDING_APPROVAL');
    assert.equal(r.deployer!.calls, 0, 'declined: nothing sent');
    p = await r.svc.revise(p.projectId, ME, 'DEPLOY', 'use another name', 'req_pb');
    assert.equal(p.state, 'PREVIEW_READY');
    assert.equal(r.deployer!.calls, 0);
  });
});

describe('persistence, ownership and the rules of the machine', () => {
  it('a project belongs to one person: everyone else gets "no such project" for every action', async () => {
    const r = rig();
    let p = await r.create();
    p = await r.svc.advance(p.projectId, ME);
    assert.equal(r.svc.get(p.projectId, OTHER), null);
    assert.deepEqual(r.svc.list(OTHER), []);
    assert.equal(r.svc.list(ME).length, 1);
    for (const act of [
      () => r.svc.advance(p.projectId, OTHER),
      () => r.svc.decide(p.projectId, OTHER, 'PLAN', 'APPROVE', 'req'),
      () => r.svc.revise(p.projectId, OTHER, 'PLAN', 'x', 'req'),
      () => r.svc.cancel(p.projectId, OTHER, 'req'),
      () => r.svc.requestDeploy(p.projectId, OTHER, { requestId: 'req' }),
      () => r.svc.resolveBlocker(p.projectId, OTHER, { requestId: 'req' }),
    ]) await assert.rejects(async () => act(), (e: any) => e.code === 'PRODUCT_PROJECT_NOT_FOUND');
    assert.equal(r.svc.get(p.projectId, { tenantId: 'ten_elsewhere', ownerId: ME.ownerId }), null, 'another tenant too');
    assert.equal(r.svc.get(p.projectId, ME)?.state, 'PLAN_PENDING_APPROVAL', 'nothing happened to it');
  });

  it('it survives a restart: a project that was in the middle of a step is taken up again; a deployment that may have been sent is not', async () => {
    const r = rig();
    let p = await r.toGate('BUILD');
    // simulate a crash while implementing: the record says IMPLEMENTING and the build gate was passed
    r.approvals.approve(p.approvals.BUILD!.approvalId, ME.tenantId, ME.ownerId);
    const record = r.store.getOwned(p.projectId, ME.tenantId, ME.ownerId)!;
    r.store.save(record);
    const fresh = r.make();
    assert.ok(fresh.recoverAfterRestart() >= 1);
    for (let i = 0; i < 100 && fresh.isRunning(p.projectId); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    p = fresh.get(p.projectId, ME)!;
    assert.equal(p.state, 'PREVIEW_READY', 'the approved build went on after the restart');

    // a deployment that had been started (sending recorded) but whose outcome is unknown
    p = fresh.requestDeploy(p.projectId, ME, { requestId: 'req' });
    const sending = r.store.getOwned(p.projectId, ME.tenantId, ME.ownerId)!;
    sending.state = 'DEPLOYING';
    sending.deploy!.startedAt = new Date().toISOString();
    r.store.save(sending);
    const again = r.make();
    again.recoverAfterRestart();
    p = again.get(p.projectId, ME)!;
    assert.deepEqual([p.state, p.blocker?.code], ['BLOCKED', 'DEPLOY_STATE_UNCERTAIN']);
    assert.equal(r.deployer!.calls, 0, 'never sent (again) after a restart');
  });

  it('an approval granted somewhere else (the approvals inbox) is carried on by the next look - and approving again afterwards is harmless', async () => {
    const r = rig();
    let p = await r.create();
    p = await r.svc.advance(p.projectId, ME);
    r.approvals.approve(p.approvals.PLAN!.approvalId, ME.tenantId, ME.ownerId);   // approved in the inbox; nothing was running
    assert.equal(r.svc.get(p.projectId, ME)!.state, 'PLAN_PENDING_APPROVAL', 'a read of the record alone moves nothing');
    const seen = r.svc.view(p.projectId, ME)!;
    assert.equal(seen.running, true, 'looking at the project carries the approved gate on');
    for (let i = 0; i < 100 && r.svc.isRunning(p.projectId); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(r.svc.get(p.projectId, ME)!.state, 'DESIGN_PENDING_APPROVAL');
    assert.equal(r.mockups[0].calls, 1);
    // the same decision pressed again on a project that already moved is a refusal, not a second run
    await assert.rejects(() => r.svc.decide(p.projectId, ME, 'PLAN', 'APPROVE', 'req_pb'), (e: any) => e.code === 'PRODUCT_GATE_NOT_WAITING');
    // and approved in the inbox but never carried on, pressing Approve in the product just continues (no "already approved" error)
    const q = await r.create();
    const waiting = await r.svc.advance(q.projectId, ME);
    r.approvals.approve(waiting.approvals.PLAN!.approvalId, ME.tenantId, ME.ownerId);
    const moved = await r.svc.decide(q.projectId, ME, 'PLAN', 'APPROVE', 'req_pb');
    assert.equal(moved.state, 'DESIGN_PENDING_APPROVAL');
    assert.equal(r.svc.view('pbp_000000000000aaaa', ME), null, 'another project id is simply absent');
  });

  it('a person has at most five unfinished products; a finished or cancelled one frees a place; other people are unaffected', async () => {
    const r = rig();
    const made: string[] = [];
    for (let i = 0; i < 5; i += 1) made.push((await r.create()).projectId);
    await assert.rejects(async () => r.create(), (e: any) => e.code === 'PRODUCT_TOO_MANY_ACTIVE');
    r.svc.cancel(made[0], ME, 'req');
    assert.equal((await r.create()).state, 'REQUIREMENTS_DRAFT', 'a cancelled product no longer counts');
    assert.equal((await r.create(OTHER)).state, 'REQUIREMENTS_DRAFT', 'someone else has their own allowance');
  });

  it('cancelling withdraws every waiting approval', async () => {
    const r = rig();
    let p = await r.create();
    p = await r.svc.advance(p.projectId, ME);
    const approvalId = p.approvals.PLAN!.approvalId;
    p = r.svc.cancel(p.projectId, ME, 'req');
    assert.equal(p.state, 'CANCELLED');
    assert.throws(() => r.approvals.approve(approvalId, ME.tenantId, ME.ownerId), (e: any) => e.code === 'APPROVAL_NOT_PENDING');
    p = await r.svc.advance(p.projectId, ME);
    assert.equal(p.state, 'CANCELLED');
  });

  it('the machine only makes the moves it lists; nothing leaves a terminal state; no state skips a gate', () => {
    for (const terminal of ['DEPLOYED_VERIFIED', 'FAILED', 'CANCELLED'] as ProjectState[]) assert.deepEqual(ALLOWED_TRANSITIONS[terminal], []);
    assert.equal(isAllowedTransition('PLAN_PENDING_APPROVAL', 'IMPLEMENTING'), false);
    assert.equal(isAllowedTransition('DESIGN_PENDING_APPROVAL', 'BUILD_APPROVED'), false);
    assert.equal(isAllowedTransition('PREVIEW_READY', 'DEPLOYING'), false, 'deploying is reached only through the deploy gate');
    assert.equal(isAllowedTransition('BUILD_PLAN_PENDING_APPROVAL', 'IMPLEMENTING'), false, 'implementing is reached only through the build gate');
    assert.equal(isAllowedTransition('PLAN_APPROVED', 'IMPLEMENTING'), false);
    for (const [gate, state] of Object.entries(GATE_STATE)) {
      const approved = { PLAN: 'PLAN_APPROVED', DESIGN: 'DESIGN_APPROVED', BUILD: 'BUILD_APPROVED', DEPLOY: 'DEPLOYING' }[gate]!;
      assert.equal(isAllowedTransition(state, approved as ProjectState), true, `${gate}: pending -> approved is the only way forward`);
    }
  });

  it('the requests are validated and the capability report is truthful', async () => {
    const r = rig();
    assert.throws(() => r.svc.createProject(ME, { request: '   ', locale: 'en', requestId: 'req' }), (e: any) => e.code === 'PRODUCT_REQUEST_REQUIRED');
    assert.throws(() => r.svc.createProject(ME, { request: 'x'.repeat(4001), locale: 'en', requestId: 'req' }), (e: any) => e.code === 'PRODUCT_REQUEST_TOO_LONG');
    const none = rig({ planning: null });
    assert.throws(() => none.svc.createProject(ME, { request: REQUEST, locale: 'en', requestId: 'req' }), (e: any) => e.code === 'PRODUCT_BUILDER_UNAVAILABLE');
    assert.deepEqual(r.svc.capability(), {
      available: true, planning: true, mockups: [{ providerId: 'mock-image-provider', available: true }], engine: { id: 'mock-engine', kind: 'one-shot static generator (test double)', available: true },
      tester: { isolation: 'scripted test double' }, deployers: [{ adapterId: 'mock-hosting', provider: 'mock-host', configured: true }], verifier: true,
    });
    assert.deepEqual(none.svc.capability().available, false);
  });
});

describe('the workspace: generated files are data, written only if every one of them is plain, small, relative and allowed', () => {
  it('paths: relative, plain segments, allowed extensions only', () => {
    for (const ok of ['index.html', 'css/site.css', 'js/app.js', 'img/logo.svg', 'data/seed.json']) assert.equal(checkWorkspacePath(ok).ok, true, ok);
    const code = (p: unknown) => { const c = checkWorkspacePath(p); return c.ok ? 'OK' : c.code; };
    assert.equal(code(''), 'PATH_EMPTY');
    assert.equal(code(undefined), 'PATH_EMPTY');
    assert.equal(code('/etc/passwd'), 'PATH_NOT_RELATIVE');
    assert.equal(code('C:\\x.html'), 'PATH_NOT_RELATIVE');
    assert.equal(code('a\\b.html'), 'PATH_NOT_RELATIVE');
    assert.equal(code('../x.html'), 'PATH_TRAVERSAL');
    assert.equal(code('a/../b.html'), 'PATH_TRAVERSAL');
    assert.equal(code('./x.html'), 'PATH_TRAVERSAL');
    assert.equal(code('.env'), 'PATH_SEGMENT_INVALID');
    assert.equal(code('a b.html'), 'PATH_SEGMENT_INVALID');
    assert.equal(code('run.sh'), 'EXTENSION_NOT_ALLOWED');
    assert.equal(code('package.json.exe'), 'EXTENSION_NOT_ALLOWED');
    assert.equal(code('install.bat'), 'EXTENSION_NOT_ALLOWED');
    assert.equal(code('x'.repeat(130) + '.html'), 'PATH_TOO_LONG');
  });

  it('a set is written whole or not at all (count, size, duplicates), and reading never leaves the workspace', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-pbw-'));
    const workspaces = new ProductWorkspaceStore(dir);
    const { workspaceId } = workspaces.create('pbp_0123456789abcdef');
    const projectId = 'pbp_0123456789abcdef';
    const written = workspaces.write(projectId, workspaceId, siteFiles());
    assert.equal(written.ok, true);
    assert.equal(workspaces.read(projectId, workspaceId, 'index.html')?.toString('utf8').includes('<title>Customers</title>'), true);
    assert.equal(workspaces.read(projectId, workspaceId, '../../etc/passwd'), null);
    assert.equal(workspaces.read(projectId, workspaceId, 'nope.html'), null);
    const second = workspaces.create(projectId).workspaceId;
    const bad = (files: Array<{ path: string; content: string }>) => { const r = workspaces.write(projectId, second, files); return r.ok ? 'OK' : r.code; };
    assert.equal(bad([]), 'NO_FILES');
    assert.equal(bad(Array.from({ length: 41 }, (_, i) => ({ path: `f${i}.txt`, content: 'x' }))), 'TOO_MANY_FILES');
    assert.equal(bad([{ path: 'a.html', content: 'x' }, { path: 'A.html', content: 'y' }]), 'DUPLICATE_PATH');
    assert.equal(bad(Array.from({ length: 6 }, (_, i) => ({ path: `f${i}.txt`, content: 'x'.repeat(380_000) }))), 'WORKSPACE_TOO_LARGE');
    assert.equal(bad([{ path: 'ok.html', content: 'fine' }, { path: 'run.sh', content: 'rm -rf /' }]), 'EXTENSION_NOT_ALLOWED');
    assert.equal(fs.existsSync(path.join(dir, projectId, second, 'ok.html')), false, 'nothing of a rejected set was written');
    assert.throws(() => workspaces.dirFor('../x', 'ws_0123456789abcdef'), /INVALID_WORKSPACE_ID/);
  });

  it('the build marker is stamped into the page by NAgex, in the head when there is one', () => {
    assert.equal(stampIndexHtml('<html><head><title>x</title></head><body></body></html>', 'm1'), '<html><head><title>x</title><meta name="nagex-build" content="m1">\n</head><body></body></html>');
    assert.equal(stampIndexHtml('<p>no head</p>', 'm2'), '<meta name="nagex-build" content="m2">\n<p>no head</p>');
  });
});
