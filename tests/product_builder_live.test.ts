// AI Product Builder - LIVE check of what only a real provider can show: a REAL model plans, designs and writes the files of a customer management website; the REAL isolated browser tests it; the REAL Google
// image adapter is asked for mockups (and says what it says - on a key without image quota, "no quota").
//
// LIVE_EXTERNAL and opt-in: it runs only with NAGEX_PRODUCT_BUILDER_LIVE=1 AND a fully configured model provider (<PROVIDER>_API_KEY + NAGEX_<PROVIDER>_MODEL). Otherwise the file is SKIPPED with the reason - it
// never substitutes a fake answer and never reports a pass it did not earn. The person's approvals are given by the test itself (it plays the person, through the same Approval Authority); that is automation, not a
// product decision. Nothing is deployed anywhere. The paid-capable calls are the TEXT model calls (free tier on the development key). REAL IMAGE REQUESTS are a separate, explicit authorization: they are made only with
// NAGEX_PRODUCT_BUILDER_LIVE_IMAGES=1 (a provider that answers one can be billed); without it the real image adapter is not in the run and a labelled stand-in provider stands in for it. All content is synthetic text authored here.
// NAGEX_PRODUCT_BUILDER_LIVE_OUT=<dir> writes what happened (summaries, test results, the generated files) for the evidence document.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ActionApprovalStore } from '../src/governance/action-approval.store.js';
import { UnifiedModelRouter } from '../src/model-gateway/unified-model-router.js';
import { createProviders } from '../src/model-gateway/providers.js';
import { GoogleImageAdapter } from '../src/creation/providers/adapters/google-image-adapter.js';
import { GatewayPlanningAdapter } from '../src/product-builder/adapters/gateway-planning.adapter.js';
import { GatewayStaticSiteEngine } from '../src/product-builder/adapters/gateway-static-site.engine.js';
import { ImageProviderMockupAdapter } from '../src/product-builder/adapters/image-provider-mockup.adapter.js';
import { PlaywrightSiteTester } from '../src/product-builder/adapters/playwright-site-tester.js';
import { ProductBuilderService } from '../src/product-builder/product-builder.service.js';
import { ProductProjectStore } from '../src/product-builder/product-builder.store.js';
import { ProductWorkspaceStore } from '../src/product-builder/product-workspace.js';
import { FakeMockups } from './_product_builder_fakes.js';
import { SITE_REQUEST_EN } from './_product_site_fixture.js';

const CONFIGURED = (['OPENAI', 'GEMINI', 'NEBIUS'] as const).filter((p) => process.env[`${p}_API_KEY`] && process.env[`NAGEX_${p}_MODEL`]);
const SKIP_REASON = process.env.NAGEX_PRODUCT_BUILDER_LIVE !== '1' ? 'LIVE_NOT_REQUESTED: set NAGEX_PRODUCT_BUILDER_LIVE=1 to run (it calls a real model)'
  : CONFIGURED.length === 0 ? 'LIVE_DEPENDENCY_UNAVAILABLE: no real model provider is configured (need <PROVIDER>_API_KEY and NAGEX_<PROVIDER>_MODEL)' : false;

describe('Product Builder - live: a real model plans and writes a customer management website, the isolated browser tests it', { skip: SKIP_REASON }, () => {
  it('plan -> (mockups asked of the real image adapter) -> design -> build plan -> real build -> real isolated test -> preview; nothing deployed', { timeout: 900_000 }, async () => {
    const out = process.env.NAGEX_PRODUCT_BUILDER_LIVE_OUT ? path.resolve(process.env.NAGEX_PRODUCT_BUILDER_LIVE_OUT) : null;
    if (out) fs.mkdirSync(out, { recursive: true });
    const log: Record<string, unknown> = { providers: CONFIGURED, startedAt: new Date().toISOString() };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-pb-live-'));
    const router = new UnifiedModelRouter(createProviders());
    const planning = new GatewayPlanningAdapter(router);
    const engine = new GatewayStaticSiteEngine(router);
    const approvals = new ActionApprovalStore();
    const store = new ProductProjectStore({ dir });
    const realImagesAuthorized = process.env.NAGEX_PRODUCT_BUILDER_LIVE_IMAGES === '1';
    const realImages = new ImageProviderMockupAdapter(new GoogleImageAdapter());
    // a labelled stand-in: it is what the journey continues with when the real image adapter is not authorized for this run, or has been blocked
    const standIn = new FakeMockups('stand-in-images-NOT-REAL');
    log.realImageRequestsAuthorized = realImagesAuthorized;
    const svc = new ProductBuilderService({ store, workspaces: new ProductWorkspaceStore(path.join(dir, 'workspaces')), approvals, planning: planning.configured() ? planning : null, mockups: realImagesAuthorized ? [realImages, standIn] : [standIn], engine, tester: new PlaywrightSiteTester(), deployers: [], verifier: null, maxRepairAttempts: 2 });
    const me = { tenantId: 'ten_live', ownerId: 'usr_live' };

    let p = svc.createProject(me, { request: SITE_REQUEST_EN, locale: 'en', requestId: 'live' });
    p = await svc.advance(p.projectId, me);
    assert.equal(p.state, 'PLAN_PENDING_APPROVAL', JSON.stringify(p.blocker ?? p.failure));
    log.plan = p.plan?.content;

    p = await svc.decide(p.projectId, me, 'PLAN', 'APPROVE', 'live');
    log.afterPlanApproval = { state: p.state, blocker: p.blocker, recovery: p.recovery ?? null };
    if (p.state === 'BLOCKED') {
      // the real image adapter said no (no key / no quota / refusal): that is the truthful result; continue with the stand-in the person would have to choose
      assert.equal(p.blocker?.blockedAt, 'MOCKUP_GENERATING');
      p = await svc.resolveBlocker(p.projectId, me, { mockupProviderId: 'stand-in-images-NOT-REAL', requestId: 'live' });
    }
    assert.equal(p.state, 'DESIGN_PENDING_APPROVAL', JSON.stringify(p.blocker ?? p.failure));
    log.design = p.design?.content;
    p = await svc.decide(p.projectId, me, 'DESIGN', 'APPROVE', 'live');
    assert.equal(p.state, 'BUILD_PLAN_PENDING_APPROVAL', JSON.stringify(p.blocker ?? p.failure));
    log.buildPlan = p.buildPlan?.content;
    p = await svc.decide(p.projectId, me, 'BUILD', 'APPROVE', 'live');
    log.final = { state: p.state, blocker: p.blocker, failure: p.failure, repairAttempts: p.repairAttempts ?? 0, test: p.test, files: p.workspace?.files, history: p.history.map((h) => h.event) };
    if (out && p.workspace) {
      const ws = path.join(dir, 'workspaces', p.projectId, p.workspace.workspaceId);
      fs.cpSync(ws, path.join(out, 'site'), { recursive: true });
      const shots = `${ws}.shots`;
      if (fs.existsSync(shots)) fs.cpSync(shots, path.join(out, 'screenshots'), { recursive: true });
    }
    if (out) fs.writeFileSync(path.join(out, 'live-result.json'), JSON.stringify(log, null, 2));
    // the live result is reported as it is: a product that the real model could not get to pass in the allowed attempts is a FAILED project, and that is a legitimate (truthful) outcome to assert separately
    assert.ok(['PREVIEW_READY', 'FAILED'].includes(p.state), `unexpected end state ${p.state}: ${JSON.stringify(p.blocker ?? p.failure)}`);
    assert.equal(p.state, 'PREVIEW_READY', `the real model's site did not pass its own checks: ${JSON.stringify(p.test?.checks.filter((c) => !c.passed))}`);
    assert.equal(p.deploy, null, 'nothing was deployed');
  });
});
