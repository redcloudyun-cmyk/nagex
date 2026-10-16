// ProductBuilderService - the persistent, resumable state machine of "build me a product and put it online", with the person deciding at four gates.
//
// Rules this file enforces (and tests/product_builder_workflow.test.ts proves):
//   * Gate approvals go through the ONE Approval Authority (ActionApprovalStore); each is bound to the version AND hash of what the person saw, and is consumed exactly once. A changed plan / design /
//     build plan / deployment target is a new version and needs a new approval; an approval for an older version can never move the project forward.
//   * Nothing is implemented before the BUILD gate is passed for the CURRENT build plan; nothing is deployed before the DEPLOY gate is passed for the CURRENT target and files.
//   * Every step that cannot run for lack of a credential, a quota, an authorization, a sandbox or an engine ends in BLOCKED with that reason (and is resumed by the person, who may choose a
//     different authorized mockup provider). No silent provider switch, no placeholder result.
//   * "Deployed" is reported only after the address answers, the expected content is there and the smoke checks pass. An uncertain deployment is never retried blindly.
//   * Generated files are never executed on this host (see product-workspace.ts).
//   * Every method is scoped to (tenantId, ownerId): someone else's project is as absent as one that never existed.
import fs from 'node:fs';
import path from 'node:path';
import { NagexError } from '../common/errors.js';
import type { ActionApprovalStore } from '../governance/action-approval.store.js';
import type { AuditLogger } from '../governance/audit.logger.js';
import { generateResourceId } from '../common/utils.js';
import { ProductProjectStore } from './product-builder.store.js';
import { ProductWorkspaceStore, WORKSPACE_LIMITS, contentTypeFor, type GeneratedFile } from './product-workspace.js';
import type { CodingEnginePort, DeployPort, DeployVerifierPort, MockupPort, PlanningPort, SiteTesterPort } from './product-builder.ports.js';
import {
  GATE_ORDER, GATE_STATE, GATE_TOOL_ID, TERMINAL_STATES, artifactHash, isAllowedTransition,
  type BlockerNeed, type BuildPlan, type DesignSpec, type GateApproval, type MockupItem, type ProductPlan, type ProductProjectRecord, type ProjectGate, type ProjectState, type VersionedArtifact,
} from './product-builder.types.js';

export interface Identity { tenantId: string; ownerId: string }

export interface ProductBuilderDeps {
  store: ProductProjectStore;
  workspaces: ProductWorkspaceStore;
  approvals: ActionApprovalStore;
  planning: PlanningPort | null;
  mockups: MockupPort[];
  engine: CodingEnginePort | null;
  tester: SiteTesterPort | null;
  deployers: DeployPort[];
  verifier: DeployVerifierPort | null;
  audit?: AuditLogger;
  now?: () => Date;
  mockupCount?: number;
  maxRepairAttempts?: number;
  /** the viewport widths the isolated test run looks at */
  testWidths?: number[];
}

const MAX_REQUEST_CHARS = 4000;
const MAX_FEEDBACK_CHARS = 2000;
// a person's unfinished products at one time: every one of them can spend model and image calls, so there is a ceiling
const MAX_OPEN_PROJECTS = 5;

function fail(code: string, category: 'VALIDATION' | 'NOT_FOUND' | 'CONFLICT' | 'POLICY', message: string, requestId = 'product-builder'): never {
  throw new NagexError({ code, category, message, request_id: requestId });
}

export class ProductBuilderService {
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly now: () => Date;
  private readonly mockupCount: number;
  private readonly maxRepairAttempts: number;
  private readonly testWidths: number[];

  constructor(private readonly deps: ProductBuilderDeps) {
    this.now = deps.now ?? (() => new Date());
    this.mockupCount = deps.mockupCount ?? 3;
    this.maxRepairAttempts = deps.maxRepairAttempts ?? 2;
    this.testWidths = deps.testWidths ?? [1280, 768, 390];
  }

  // ---- what exists (truthful) -----------------------------------------------------------------------------------------------------------------------------------------------------------------

  public capability(): {
    available: boolean;
    planning: boolean;
    mockups: Array<{ providerId: string; available: boolean }>;
    engine: { id: string; kind: string; available: boolean } | null;
    tester: { isolation: string } | null;
    deployers: Array<{ adapterId: string; provider: string; configured: boolean }>;
    verifier: boolean;
  } {
    return {
      available: Boolean(this.deps.planning),
      planning: Boolean(this.deps.planning),
      mockups: this.deps.mockups.map((m) => ({ providerId: m.providerId, available: m.available() })),
      engine: this.deps.engine ? { id: this.deps.engine.engineId, kind: this.deps.engine.kind, available: this.deps.engine.available() } : null,
      tester: this.deps.tester ? { isolation: this.deps.tester.isolation } : null,
      deployers: this.deps.deployers.map((d) => ({ adapterId: d.adapterId, provider: d.provider, configured: d.configured() })),
      verifier: Boolean(this.deps.verifier),
    };
  }

  // ---- projects -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

  public createProject(identity: Identity, input: { request: string; locale: 'en' | 'ko'; requestId: string }): ProductProjectRecord {
    const request = String(input.request ?? '').trim();
    if (!request) fail('PRODUCT_REQUEST_REQUIRED', 'VALIDATION', 'Say what you want built.', input.requestId);
    if (request.length > MAX_REQUEST_CHARS) fail('PRODUCT_REQUEST_TOO_LONG', 'VALIDATION', `Keep the request under ${MAX_REQUEST_CHARS} characters.`, input.requestId);
    if (!this.deps.planning) fail('PRODUCT_BUILDER_UNAVAILABLE', 'POLICY', 'No planning model is available, so a product cannot be planned.', input.requestId);
    const open = this.deps.store.listOwned(identity.tenantId, identity.ownerId).filter((r) => !TERMINAL_STATES.has(r.state)).length;
    if (open >= MAX_OPEN_PROJECTS) fail('PRODUCT_TOO_MANY_ACTIVE', 'CONFLICT', `You already have ${MAX_OPEN_PROJECTS} unfinished products. Finish or cancel one first.`, input.requestId);
    const at = this.stamp();
    const record: ProductProjectRecord = {
      projectId: generateResourceId('pbp'), tenantId: identity.tenantId, ownerId: identity.ownerId,
      title: this.titleFrom(request), request, locale: input.locale === 'ko' ? 'ko' : 'en',
      state: 'REQUIREMENTS_DRAFT', blocker: null, failure: null,
      plan: null, mockups: null, design: null, buildPlan: null, approvals: {}, passedGates: [], workspace: null, test: null, deploy: null,
      history: [{ at, event: 'PROJECT_CREATED', state: 'REQUIREMENTS_DRAFT' }], createdAt: at, updatedAt: at,
    };
    this.deps.store.save(record);
    this.audit('product_builder.created', record, input.requestId);
    return record;
  }

  public get(projectId: string, identity: Identity): ProductProjectRecord | null {
    return this.deps.store.getOwned(projectId, identity.tenantId, identity.ownerId);
  }

  public list(identity: Identity): ProductProjectRecord[] {
    return this.deps.store.listOwned(identity.tenantId, identity.ownerId);
  }

  /** What the person's screen reads. A gate whose approval was granted somewhere else (the approvals inbox) while nothing was running is carried on here, so a decision is never lost on the way. */
  public view(projectId: string, identity: Identity): ProjectView | null {
    const record = this.get(projectId, identity);
    if (!record) return null;
    const gate = GATE_ORDER.find((g) => GATE_STATE[g] === record.state);
    if (gate && !this.inFlight.has(projectId) && this.approvalStatus(record, gate) === 'APPROVED') this.kick(projectId);
    return this.viewOf(record);
  }

  /** The current approval status of a gate, read from the Approval Authority (never trusted from the project record). */
  public approvalStatus(record: ProductProjectRecord, gate: ProjectGate): 'NONE' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'CONSUMED' | 'EXPIRED' {
    const gateApproval = record.approvals[gate];
    if (!gateApproval) return 'NONE';
    const live = this.deps.approvals.get(gateApproval.approvalId, record.tenantId, record.ownerId);
    return live ? live.status : 'EXPIRED';
  }

  // ---- running --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

  /** Fire and forget (one run per project at a time): used by the HTTP layer, which answers at once and lets the person watch the state. */
  public kick(projectId: string): void {
    if (this.inFlight.has(projectId)) return;
    const run = this.runUntilStop(projectId).catch((error) => {
      this.audit('product_builder.run_error', this.deps.store.listAll().find((r) => r.projectId === projectId) ?? null, 'product-builder', error instanceof Error ? error.message.slice(0, 120) : 'unknown');
    }).finally(() => { this.inFlight.delete(projectId); });
    this.inFlight.set(projectId, run);
  }

  /** Runs every automatic step that can run now and returns when the project waits for the person, is blocked, or has ended. */
  public async advance(projectId: string, identity: Identity): Promise<ProductProjectRecord> {
    if (!this.get(projectId, identity)) fail('PRODUCT_PROJECT_NOT_FOUND', 'NOT_FOUND', 'No such project.');
    const existing = this.inFlight.get(projectId);
    if (existing) await existing;
    else {
      const run = this.runUntilStop(projectId).finally(() => { this.inFlight.delete(projectId); });
      this.inFlight.set(projectId, run);
      await run;
    }
    return this.get(projectId, identity)!;
  }

  public isRunning(projectId: string): boolean {
    return this.inFlight.has(projectId);
  }

  /** After a restart: whatever was in the middle of a step is taken up again - except a deployment, whose outcome is uncertain and is never repeated blindly. */
  public recoverAfterRestart(): number {
    let resumed = 0;
    for (const record of this.deps.store.listAll()) {
      if (TERMINAL_STATES.has(record.state) || record.state === 'CANCELLED') continue;
      if (record.state === 'DEPLOYING' && record.deploy && !record.deploy.deployId) {
        this.block(record, 'DEPLOY_STATE_UNCERTAIN', 'PERSON', 'The server restarted while the deployment was being sent. NAgex cannot tell whether the provider created it, and will not send it a second time. Check your hosting account, then tell NAgex how to continue.', 'DEPLOYING');
        continue;
      }
      this.kick(record.projectId);
      resumed += 1;
    }
    return resumed;
  }

  // ---- the person's decisions -----------------------------------------------------------------------------------------------------------------------------------------------------------

  /** Approve or decline the gate the project is waiting at. Approving runs the approval through the Approval Authority and moves on; declining leaves the project waiting for changes. */
  public async decide(projectId: string, identity: Identity, gate: ProjectGate, decision: 'APPROVE' | 'DECLINE', requestId: string, options: { wait?: boolean } = {}): Promise<ProductProjectRecord> {
    const record = this.requireOwned(projectId, identity);
    if (record.state !== GATE_STATE[gate]) fail('PRODUCT_GATE_NOT_WAITING', 'CONFLICT', 'This project is not waiting for that decision.', requestId);
    const gateApproval = record.approvals[gate];
    if (!gateApproval) fail('PRODUCT_GATE_NOT_WAITING', 'CONFLICT', 'There is nothing to approve here.', requestId);
    if (decision === 'DECLINE') {
      this.deps.approvals.reject(gateApproval.approvalId, identity.tenantId, identity.ownerId, requestId);
      this.event(record, 'GATE_DECLINED', `${gate}`);
      this.deps.store.save(record);
      this.audit('product_builder.gate_declined', record, requestId, gate);
      return record;
    }
    // already approved elsewhere (the approvals inbox): nothing to approve again, the project just carries on
    if (this.approvalStatus(record, gate) !== 'APPROVED') this.deps.approvals.approve(gateApproval.approvalId, identity.tenantId, identity.ownerId, requestId);
    this.audit('product_builder.gate_approved', record, requestId, gate);
    // over HTTP the answer is immediate and the person watches the project move; in a test (or a script) the caller can wait for it to stop
    if (options.wait === false) { this.kick(projectId); return this.requireOwned(projectId, identity); }
    return this.advance(projectId, identity);
  }

  /** Changes asked for at a gate: the artifact is redrafted as a NEW version, every approval and result that depended on the old one is dropped, and the person approves again. */
  public async revise(projectId: string, identity: Identity, gate: ProjectGate, feedback: string, requestId: string, options: { wait?: boolean } = {}): Promise<ProductProjectRecord> {
    const record = this.requireOwned(projectId, identity);
    const note = String(feedback ?? '').trim().slice(0, MAX_FEEDBACK_CHARS);
    if (!note) fail('PRODUCT_FEEDBACK_REQUIRED', 'VALIDATION', 'Say what to change.', requestId);
    // changes can be asked for at the decision the project is waiting at, or at an earlier one (the plan, from the build plan): everything that depended on it is then redone
    const waitingAt = GATE_ORDER.find((g) => GATE_STATE[g] === record.state);
    if (!waitingAt || GATE_ORDER.indexOf(gate) > GATE_ORDER.indexOf(waitingAt) || (waitingAt === 'DEPLOY' && gate !== 'DEPLOY')) fail('PRODUCT_GATE_NOT_WAITING', 'CONFLICT', 'Changes can only be asked for at a decision the project is waiting for, or an earlier one.', requestId);
    if (!this.deps.planning) fail('PRODUCT_BUILDER_UNAVAILABLE', 'POLICY', 'No planning model is available.', requestId);
    try {
      if (gate === 'PLAN') {
        await this.draftPlan(record, note, requestId, () => { this.supersedeApproval(record, 'PLAN'); this.dropFrom(record, 'PLAN'); });
      } else if (gate === 'DESIGN') {
        this.supersedeApproval(record, 'DESIGN');
        this.dropFrom(record, 'DESIGN');
        record.feedbackForMockups = note;
        this.transition(record, 'MOCKUP_GENERATING', 'DESIGN_CHANGES_REQUESTED', note.slice(0, 160));
        this.deps.store.save(record);
      } else if (gate === 'BUILD') {
        await this.draftBuildPlan(record, note, requestId, () => { this.supersedeApproval(record, 'BUILD'); this.dropFrom(record, 'BUILD'); });
      } else {
        this.supersedeApproval(record, 'DEPLOY');
        // a change to the deployment target is a new target: the person asks for deployment again with the new name
        this.event(record, 'DEPLOY_TARGET_CHANGE_REQUESTED', note.slice(0, 160));
        this.dropFrom(record, 'DEPLOY');
        this.transition(record, 'PREVIEW_READY', 'DEPLOY_TARGET_CHANGE_REQUESTED');
        this.deps.store.save(record);
        return record;
      }
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      // the planning model could not redraft: nothing was changed, the earlier version and its approval stand, and the person can ask again
      if (code === 'PRODUCT_PLANNER_UNAVAILABLE') fail('PRODUCT_PLANNER_UNAVAILABLE', 'POLICY', 'The planning model could not be reached, so your change was not applied. Nothing was changed: ask again in a moment.', requestId);
      if (code === 'PRODUCT_PLAN_INVALID') fail('PRODUCT_PLAN_INVALID', 'VALIDATION', 'The planning model did not give a usable answer for that change. Nothing was changed: try wording it differently.', requestId);
      this.failProject(record, 'REVISION_FAILED', error);
      return record;
    }
    if (gate === 'DESIGN' && options.wait === false) { this.kick(projectId); return this.requireOwned(projectId, identity); }
    return gate === 'DESIGN' ? this.advance(projectId, identity) : (this.deps.store.getOwned(projectId, identity.tenantId, identity.ownerId) as ProductProjectRecord);
  }

  /** From a finished preview, ask to put it online: the person is shown exactly where, under what name, how exposed, at what limit - and approves or declines (Gate 4). */
  public requestDeploy(projectId: string, identity: Identity, input: { adapterId?: string; appName?: string; requestId: string }): ProductProjectRecord {
    const record = this.requireOwned(projectId, identity);
    if (record.state !== 'PREVIEW_READY' && record.state !== 'DEPLOY_PENDING_APPROVAL') fail('PRODUCT_NOT_READY_FOR_DEPLOY', 'CONFLICT', 'There is no tested preview to deploy yet.', input.requestId);
    if (!record.workspace || !record.test?.passed) fail('PRODUCT_NOT_READY_FOR_DEPLOY', 'CONFLICT', 'Only a product whose tests passed can be deployed.', input.requestId);
    const deployer = this.pickDeployer(record, input.adapterId);
    if (!deployer) fail('PRODUCT_DEPLOY_NOT_CONFIGURED', 'POLICY', 'No hosting account is connected to NAgex, so nothing can be deployed. The preview still works.', input.requestId);
    const appName = this.safeAppName(input.appName, record.title);
    const target = deployer.describeTarget(appName);
    const filesHash = artifactHash(record.workspace.files.map((f) => [f.path, f.sha256]));
    const targetHash = artifactHash({ target, filesHash });
    if (record.state === 'DEPLOY_PENDING_APPROVAL') this.supersedeApproval(record, 'DEPLOY');
    const version = (record.deploy ? 1 : 0) + (record.approvals.DEPLOY ? record.approvals.DEPLOY.version : 0) + 1;
    record.deploy = { adapterId: deployer.adapterId, provider: deployer.provider, appName, targetHash, deployId: null, url: null, startedAt: null, verifiedAt: null, verification: null, target };
    this.requestGateApproval(record, 'DEPLOY', version, targetHash, { target, filesHash });
    this.transition(record, 'DEPLOY_PENDING_APPROVAL', 'DEPLOY_REQUESTED', `${deployer.adapterId}:${appName}`);
    this.deps.store.save(record);
    this.audit('product_builder.deploy_requested', record, input.requestId, deployer.adapterId);
    return record;
  }

  public cancel(projectId: string, identity: Identity, requestId: string): ProductProjectRecord {
    const record = this.requireOwned(projectId, identity);
    if (TERMINAL_STATES.has(record.state) || record.state === 'CANCELLED') return record;
    for (const gate of Object.keys(record.approvals) as ProjectGate[]) this.supersedeApproval(record, gate);
    this.transition(record, 'CANCELLED', 'CANCELLED_BY_PERSON');
    this.deps.store.save(record);
    this.audit('product_builder.cancelled', record, requestId);
    return record;
  }

  /** The person has resolved a blocker (a credential, a quota, a choice of provider...): the blocked step runs again. */
  public async resolveBlocker(projectId: string, identity: Identity, input: { mockupProviderId?: string; requestId: string; wait?: boolean }): Promise<ProductProjectRecord> {
    const record = this.requireOwned(projectId, identity);
    if (record.state !== 'BLOCKED' || !record.blocker) fail('PRODUCT_NOT_BLOCKED', 'CONFLICT', 'This project is not blocked.', input.requestId);
    if (input.mockupProviderId) {
      if (!this.deps.mockups.some((m) => m.providerId === input.mockupProviderId)) fail('PRODUCT_MOCKUP_PROVIDER_UNKNOWN', 'VALIDATION', 'That image provider is not one NAgex can use.', input.requestId);
      record.mockupProviderId = input.mockupProviderId;
    }
    const back = record.blocker.blockedAt;
    record.blocker = null;
    this.transition(record, back, 'BLOCKER_RESOLVED_BY_PERSON');
    this.deps.store.save(record);
    if (input.wait === false) { this.kick(projectId); return this.requireOwned(projectId, identity); }
    return this.advance(projectId, identity);
  }

  // ---- the loop -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

  private async runUntilStop(projectId: string): Promise<void> {
    for (let guard = 0; guard < 60; guard += 1) {
      const record = this.deps.store.listAll().find((r) => r.projectId === projectId);
      if (!record) return;
      try {
        switch (record.state) {
          case 'REQUIREMENTS_DRAFT': await this.draftPlan(record, null, 'product-builder'); continue;
          case 'PLAN_PENDING_APPROVAL': case 'DESIGN_PENDING_APPROVAL': case 'BUILD_PLAN_PENDING_APPROVAL': case 'DEPLOY_PENDING_APPROVAL': {
            const gate = (Object.keys(GATE_STATE) as ProjectGate[]).find((g) => GATE_STATE[g] === record.state)!;
            if (this.approvalStatus(record, gate) === 'APPROVED') { this.passGate(record, gate); continue; }
            return;
          }
          case 'PLAN_APPROVED': this.transition(record, 'MOCKUP_GENERATING', 'PLAN_APPROVED_NEXT_MOCKUPS'); this.deps.store.save(record); continue;
          case 'MOCKUP_GENERATING': await this.makeMockupsAndDesign(record); continue;
          case 'DESIGN_APPROVED': await this.draftBuildPlan(record, null, 'product-builder'); continue;
          case 'BUILD_APPROVED': this.transition(record, 'IMPLEMENTING', 'BUILD_APPROVED_NEXT_IMPLEMENT'); this.deps.store.save(record); continue;
          case 'IMPLEMENTING': await this.implement(record); continue;
          case 'TESTING': await this.test(record); continue;
          case 'DEPLOYING': await this.deploy(record); continue;
          default: return; // PREVIEW_READY waits for the person; BLOCKED / FAILED / CANCELLED / DEPLOYED_VERIFIED are stopped
        }
      } catch (error) {
        this.handleStepError(record, error);
        return;
      }
    }
  }

  /** A model that is down or kept giving unusable answers, or a missing test browser, does not end the project: it is BLOCKED at the step, with the reason, and resumes when the person says so. */
  private handleStepError(record: ProductProjectRecord, error: unknown): void {
    const code = (error as { code?: unknown } | null)?.code;
    const resumable = new Set<ProjectState>(['REQUIREMENTS_DRAFT', 'MOCKUP_GENERATING', 'DESIGN_APPROVED', 'IMPLEMENTING', 'TESTING']);
    if (resumable.has(record.state)) {
      if (code === 'PRODUCT_PLANNER_UNAVAILABLE') return this.block(record, 'PLANNER_UNAVAILABLE', 'CONFIGURATION', 'The planning model could not be reached, so this step was not done. Nothing was lost: try again in a moment.', record.state);
      if (code === 'PRODUCT_PLAN_INVALID') return this.block(record, 'PLANNER_OUTPUT_INVALID', 'PERSON', 'The planning model did not give a usable answer. Try again, or change the request.', record.state);
      if (code === 'SITE_TESTER_UNAVAILABLE') return this.block(record, 'NO_ISOLATED_TEST_RUNNER', 'SANDBOX', 'The isolated browser used to test the product is not available here, so the product was not run. NAgex does not run generated code outside an isolated environment.', 'TESTING');
    }
    this.failProject(record, 'STEP_FAILED', error);
  }

  // ---- steps ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

  /** `beforeApply` runs only after the model has answered: a change request whose redraft fails leaves the project (and its approvals) exactly as it was. */
  private async draftPlan(record: ProductProjectRecord, feedback: string | null, requestId: string, beforeApply?: () => void): Promise<void> {
    const planning = this.deps.planning;
    if (!planning) return this.block(record, 'PLANNING_UNAVAILABLE', 'CONFIGURATION', 'No planning model is available, so the plan could not be written.', record.state === 'REQUIREMENTS_DRAFT' ? 'REQUIREMENTS_DRAFT' : 'PLAN_PENDING_APPROVAL');
    const content = await planning.draftPlan({ request: record.request, locale: record.locale, previous: record.plan?.content ?? null, feedback, requestId });
    beforeApply?.();
    const version = (record.plan?.version ?? 0) + 1;
    record.plan = this.versioned(content, version);
    // what approving the plan sets going is part of what is approved: the pictures are made by this provider, this many
    this.requestGateApproval(record, 'PLAN', version, record.plan.hash, { mockups: { count: this.mockupCount, providerId: this.mockupProvider(record)?.providerId ?? null } });
    this.transition(record, 'PLAN_PENDING_APPROVAL', feedback ? 'PLAN_REVISED' : 'PLAN_DRAFTED', `v${version}`);
    this.deps.store.save(record);
  }

  private mockupProvider(record: ProductProjectRecord): MockupPort | null {
    const chosen = record.mockupProviderId ? this.deps.mockups.find((m) => m.providerId === record.mockupProviderId) : null;
    return chosen ?? this.deps.mockups.find((m) => m.available()) ?? this.deps.mockups[0] ?? null;
  }

  private async makeMockupsAndDesign(record: ProductProjectRecord): Promise<void> {
    const planning = this.deps.planning;
    if (!planning || !record.plan) return this.block(record, 'PLAN_MISSING', 'PERSON', 'There is no approved plan to design from.', 'MOCKUP_GENERATING');
    const feedback = record.feedbackForMockups ?? null;
    // mockups that were already generated for this plan and not yet designed from (the design draft failed after the pictures were made) are reused: pictures are not made - or paid for - twice
    const reuse = record.mockups !== null && record.design === null && !feedback;
    let items: MockupItem[];
    let version: number;
    if (reuse) {
      items = record.mockups!.items;
      version = record.mockups!.version;
    } else {
      const provider = this.mockupProvider(record);
      if (!provider) return this.block(record, 'NO_IMAGE_PROVIDER', 'CONFIGURATION', 'No image provider is set up, so visual mockups cannot be made. NAgex does not draw placeholder pictures instead.', 'MOCKUP_GENERATING');
      if (!provider.available()) return this.block(record, 'IMAGE_PROVIDER_UNAVAILABLE', 'CREDENTIAL', `The image provider (${provider.providerId}) is not set up, so visual mockups cannot be made.${this.otherProvidersNote(provider)}`, 'MOCKUP_GENERATING');
      const outcome = await provider.generate({ plan: record.plan.content, count: this.mockupCount, feedback, requestId: 'product-builder' });
      if (!outcome.ok) return this.block(record, outcome.code, outcome.need, `${outcome.message}${this.otherProvidersNote(provider)}`, 'MOCKUP_GENERATING');
      if (outcome.images.length === 0) return this.block(record, 'NO_MOCKUPS_RETURNED', 'PERSON', 'The image provider returned no pictures.', 'MOCKUP_GENERATING');
      version = (record.mockups?.version ?? 0) + 1;
      items = outcome.images.map((image, index) => {
        const mockupId = `mk_${version}_${index + 1}`;
        const fileName = `${mockupId}.${image.mimeType.includes('png') ? 'png' : image.mimeType.includes('jpeg') ? 'jpg' : 'img'}`;
        this.deps.store.writeMockup(record.projectId, fileName, image.data);
        return { mockupId, caption: image.caption.slice(0, 200), providerId: provider.providerId, mimeType: image.mimeType, fileName, bytes: image.data.length, sha256: artifactHash(image.data.toString('base64')) };
      });
      record.mockups = { version, items, createdAt: this.stamp() };
      record.feedbackForMockups = null;
      this.deps.store.save(record);   // the pictures exist now: a failure while drafting the design must not lose them
    }
    const content = await planning.draftDesign({ plan: record.plan.content, mockups: items, locale: record.locale, previous: record.design?.content ?? null, feedback, requestId: 'product-builder' });
    const designVersion = (record.design?.version ?? 0) + 1;
    record.design = { ...this.versioned(content, designVersion), basedOnMockupVersion: version };
    this.requestGateApproval(record, 'DESIGN', designVersion, record.design.hash, { planHash: record.plan.hash, mockupVersion: version });
    this.transition(record, 'DESIGN_PENDING_APPROVAL', 'MOCKUPS_AND_DESIGN_READY', `mockups v${version}, design v${designVersion}`);
    this.deps.store.save(record);
  }

  private async draftBuildPlan(record: ProductProjectRecord, feedback: string | null, requestId: string, beforeApply?: () => void): Promise<void> {
    const planning = this.deps.planning;
    if (!planning || !record.plan || !record.design) return this.block(record, 'DESIGN_MISSING', 'PERSON', 'There is no approved design to plan the build from.', record.state === 'BUILD_PLAN_PENDING_APPROVAL' ? 'BUILD_PLAN_PENDING_APPROVAL' : 'DESIGN_APPROVED');
    const engine = this.deps.engine;
    const deployer = this.deps.deployers.find((d) => d.configured()) ?? this.deps.deployers[0] ?? null;
    const drafted = await planning.draftBuildPlan({
      plan: record.plan.content, design: record.design.content,
      engine: { id: engine?.engineId ?? 'none', kind: engine?.kind ?? 'none', available: Boolean(engine?.available()) },
      deployTarget: { provider: deployer?.provider ?? 'none', kind: 'static-hosting', configured: Boolean(deployer?.configured()) },
      locale: record.locale, previous: record.buildPlan?.content ?? null, feedback, requestId,
    });
    beforeApply?.();
    // what is true is NAgex's to say, not the model's: the engine, the hosting target and what the person must connect first
    const credentials = new Set<string>(drafted.credentialsNeeded);
    if (!engine?.available()) credentials.add('A coding engine is not available in this environment');
    if (!deployer?.configured()) credentials.add(`A hosting account (${deployer?.provider ?? 'none connected'})`);
    const content: BuildPlan = {
      ...drafted,
      engine: { id: engine?.engineId ?? 'none', kind: engine?.kind ?? 'none', note: engine?.available() ? 'Writes the files; nothing is executed on this computer.' : 'Not available here: the build step will be blocked.' },
      framework: 'Static HTML, CSS and JavaScript (no build step, no server)',
      database: 'None - the prototype keeps its sample data in the page',
      deployTarget: { provider: deployer?.provider ?? 'none', kind: 'static-hosting' },
      credentialsNeeded: [...credentials],
    };
    const version = (record.buildPlan?.version ?? 0) + 1;
    record.buildPlan = this.versioned(content, version);
    // Gate 3 freezes the scope: this plan, this design, this workspace, these permissions, these limits
    this.requestGateApproval(record, 'BUILD', version, record.buildPlan.hash, {
      planHash: record.plan.hash, designHash: record.design.hash,
      frozen: {
        planVersion: record.plan.version, designVersion: record.design.version, buildPlanVersion: version,
        workspace: { kind: 'isolated workspace of plain files', maxFiles: WORKSPACE_LIMITS.maxFiles, maxFileBytes: WORKSPACE_LIMITS.maxFileBytes, maxTotalBytes: WORKSPACE_LIMITS.maxTotalBytes },
        permissions: ['write the generated files into the isolated workspace', 'run the product in an isolated browser that can reach only itself'],
        notPermitted: ['run generated commands or install anything on this computer', 'reach any other website', 'deploy anything (that needs its own approval later)'],
        limits: { repairAttempts: this.maxRepairAttempts, deployCost: 'nothing is deployed in this step', modelCost: 'uses your configured model provider; NAgex enforces no spending cap' },
      },
    });
    this.transition(record, 'BUILD_PLAN_PENDING_APPROVAL', feedback ? 'BUILD_PLAN_REVISED' : 'BUILD_PLAN_DRAFTED', `v${version}`);
    this.deps.store.save(record);
  }

  private async implement(record: ProductProjectRecord): Promise<void> {
    const engine = this.deps.engine;
    const plan = record.plan; const design = record.design; const buildPlan = record.buildPlan;
    if (!plan || !design || !buildPlan) return this.block(record, 'BUILD_INPUT_MISSING', 'PERSON', 'The approved plan, design or build plan is missing.', 'IMPLEMENTING');
    // nothing is built unless the BUILD gate was passed for exactly this build plan
    const passed = record.passedGates.find((g) => g.gate === 'BUILD' && g.hash === buildPlan.hash && g.version === buildPlan.version);
    if (!passed) return this.failProject(record, 'BUILD_GATE_NOT_PASSED', new Error('The build was about to start without an approval of the current build plan.'));
    if (!engine) return this.block(record, 'NO_CODING_ENGINE', 'ENGINE', 'No coding engine is set up, so the product cannot be built.', 'IMPLEMENTING');
    if (!engine.available()) return this.block(record, 'CODING_ENGINE_UNAVAILABLE', 'ENGINE', `The coding engine (${engine.engineId}) is not available in this environment. Nothing was built.`, 'IMPLEMENTING');
    const previous = record.workspace ? this.readWorkspaceFiles(record) : null;
    const hints = record.test && !record.test.passed ? record.test.checks.filter((c) => !c.passed).map((c) => `${c.description}: ${c.detail}`.slice(0, 300)) : [];
    const outcome = await engine.implement({ plan: plan.content, design: design.content, buildPlan: buildPlan.content, previousFiles: previous, repairHints: hints, requestId: 'product-builder' });
    if (!outcome.ok) return this.block(record, outcome.code, outcome.need, outcome.message, 'IMPLEMENTING');
    if (!outcome.files.some((f) => f.path === 'index.html')) return this.failProject(record, 'NO_INDEX_HTML', new Error('The generated product has no index.html.'));
    // NAgex (not the model) stamps the page with what a deployed copy must contain: the proof that what answers at the address is THIS build
    const marker = `nagex-build-${record.projectId.slice(4, 16)}-${buildPlan.hash.slice(0, 12)}`;
    const stamped = outcome.files.map((f) => (f.path === 'index.html' ? { path: f.path, content: stampIndexHtml(Buffer.isBuffer(f.content) ? f.content.toString('utf8') : String(f.content), marker) } : f));
    const created = this.deps.workspaces.create(record.projectId);
    const written = this.deps.workspaces.write(record.projectId, created.workspaceId, stamped);
    if (!written.ok) { this.deps.workspaces.remove(record.projectId, created.workspaceId); return this.failProject(record, `WORKSPACE_${written.code}`, new Error(written.detail)); }
    if (record.workspace) this.deps.workspaces.remove(record.projectId, record.workspace.workspaceId);
    record.workspace = { workspaceId: created.workspaceId, builtFrom: { planHash: plan.hash, designHash: design.hash, buildPlanHash: buildPlan.hash }, files: written.files, builtAt: this.stamp(), marker };
    record.test = null;
    this.transition(record, 'TESTING', 'IMPLEMENTED', `${written.files.length} files`);
    this.deps.store.save(record);
  }

  private async test(record: ProductProjectRecord): Promise<void> {
    const tester = this.deps.tester;
    const buildPlan = record.buildPlan;
    if (!record.workspace || !buildPlan) return this.block(record, 'NOTHING_TO_TEST', 'PERSON', 'There is nothing to test.', 'TESTING');
    if (!tester) return this.block(record, 'NO_ISOLATED_TEST_RUNNER', 'SANDBOX', 'There is no isolated way to test the product here, so it was not run. NAgex does not run generated code outside an isolated environment.', 'TESTING');
    const dir = this.deps.workspaces.dirFor(record.projectId, record.workspace.workspaceId);
    const screenshotsDir = this.deps.workspaces.shotsDir(record.projectId, record.workspace.workspaceId);
    const report = await tester.run({ source: { dir }, checks: buildPlan.content.testChecks, widths: this.testWidths, screenshotsDir });
    record.test = report;
    if (report.passed) { this.transition(record, 'PREVIEW_READY', 'TESTS_PASSED', `${report.checks.length} checks`); this.deps.store.save(record); return; }
    record.repairAttempts = (record.repairAttempts ?? 0) + 1;
    if (record.repairAttempts <= this.maxRepairAttempts) { this.transition(record, 'IMPLEMENTING', 'TESTS_FAILED_REPAIRING', `attempt ${record.repairAttempts}`); this.deps.store.save(record); return; }
    record.failure = { code: 'TESTS_FAILED', message: 'The product still fails its checks after the repair attempts, so it was not previewed or deployed.', at: record.state };
    this.transition(record, 'FAILED', 'TESTS_FAILED');
    this.deps.store.save(record);
  }

  private pickDeployer(record: ProductProjectRecord, adapterId?: string): DeployPort | null {
    const configured = this.deps.deployers.filter((d) => d.configured());
    if (adapterId) return configured.find((d) => d.adapterId === adapterId) ?? null;
    const preferred = record.buildPlan?.content.deployTarget.provider;
    return configured.find((d) => d.provider === preferred) ?? configured[0] ?? null;
  }

  private async deploy(record: ProductProjectRecord): Promise<void> {
    const deployment = record.deploy;
    if (!deployment || !record.workspace) return this.block(record, 'NOTHING_TO_DEPLOY', 'PERSON', 'There is nothing to deploy.', 'DEPLOYING');
    const passed = record.passedGates.find((g) => g.gate === 'DEPLOY' && g.hash === deployment.targetHash);
    if (!passed) return this.failProject(record, 'DEPLOY_GATE_NOT_PASSED', new Error('A deployment was about to start without an approval of this exact target and these files.'));
    const deployer = this.deps.deployers.find((d) => d.adapterId === deployment.adapterId);
    if (!deployer || !deployer.configured()) return this.block(record, 'DEPLOY_NOT_CONFIGURED', 'CREDENTIAL', 'The hosting account is not connected, so nothing was deployed.', 'DEPLOYING');
    // sending is recorded BEFORE it happens: a crash in between is "uncertain", never "send again"
    if (deployment.startedAt && !deployment.deployId) return this.block(record, 'DEPLOY_STATE_UNCERTAIN', 'PERSON', 'A deployment was already being sent when this stopped. NAgex will not send it a second time; check your hosting account.', 'DEPLOYING');
    deployment.startedAt = this.stamp();
    this.deps.store.save(record);
    const target = record.deploy!.target;
    const outcome = await deployer.deploy({ workspaceDir: this.deps.workspaces.dirFor(record.projectId, record.workspace.workspaceId), files: record.workspace.files, target, requestId: 'product-builder' });
    if (!outcome.ok) {
      if (outcome.uncertain) return this.block(record, 'DEPLOY_STATE_UNCERTAIN', 'PERSON', outcome.message, 'DEPLOYING');
      return this.block(record, outcome.code, outcome.need, outcome.message, 'DEPLOYING');
    }
    deployment.deployId = outcome.deployId;
    deployment.url = outcome.url;
    this.deps.store.save(record);
    const verifier = this.deps.verifier;
    if (!verifier) return this.block(record, 'NO_DEPLOY_VERIFIER', 'CONFIGURATION', 'The deployment was sent but NAgex has no way to check it, so it is not reported as deployed.', 'DEPLOYING');
    const verification = await verifier.verify({ url: outcome.url, marker: record.workspace.marker, checks: record.buildPlan?.content.testChecks ?? [] });
    deployment.verification = verification;
    if (verification.reachable && verification.markerFound && verification.smokePassed) {
      deployment.verifiedAt = verification.checkedAt;
      this.transition(record, 'DEPLOYED_VERIFIED', 'DEPLOYMENT_VERIFIED', outcome.url);
      this.deps.store.save(record);
      this.audit('product_builder.deployed', record, 'product-builder', deployment.adapterId);
      return;
    }
    record.failure = { code: 'DEPLOY_NOT_VERIFIED', message: 'The hosting provider accepted the files, but the address did not answer with the product, so it is not reported as deployed.', at: 'DEPLOYING' };
    this.transition(record, 'FAILED', 'DEPLOYMENT_NOT_VERIFIED');
    this.deps.store.save(record);
  }

  // ---- gates ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

  private versioned<T>(content: T, version: number): VersionedArtifact<T> {
    return { version, hash: artifactHash(content), content, createdAt: this.stamp() };
  }

  private gatePayload(record: ProductProjectRecord, gate: ProjectGate, version: number, hash: string, extra: Record<string, unknown>): Record<string, unknown> {
    return { projectId: record.projectId, gate, version, hash, ...extra };
  }

  private requestGateApproval(record: ProductProjectRecord, gate: ProjectGate, version: number, hash: string, extra: Record<string, unknown>): void {
    this.supersedeApproval(record, gate);
    const approval = this.deps.approvals.request({ toolId: GATE_TOOL_ID[gate], tenantId: record.tenantId, principalId: record.ownerId, payload: this.gatePayload(record, gate, version, hash, extra) });
    const entry: GateApproval = { approvalId: approval.approvalId, gate, version, hash, requestedAt: this.stamp(), consumedAt: null };
    record.approvals[gate] = entry;
    record.gateExtras = { ...(record.gateExtras ?? {}), [gate]: extra };
  }

  /** An approval that is still waiting is withdrawn when what it covered is replaced (it must never be usable for something the person did not see). */
  private supersedeApproval(record: ProductProjectRecord, gate: ProjectGate): void {
    const existing = record.approvals[gate];
    if (!existing || existing.consumedAt) return;
    const live = this.deps.approvals.get(existing.approvalId, record.tenantId, record.ownerId);
    if (live && live.status === 'PENDING') { try { this.deps.approvals.reject(existing.approvalId, record.tenantId, record.ownerId, 'product-builder-supersede'); } catch { /* already decided */ } }
  }

  /** The person approved: consume the approval against the CURRENT artifact (version and hash must still be the ones approved) and move past the gate. */
  private passGate(record: ProductProjectRecord, gate: ProjectGate): void {
    const entry = record.approvals[gate];
    if (!entry) return;
    const artifact = gate === 'PLAN' ? record.plan : gate === 'DESIGN' ? record.design : gate === 'BUILD' ? record.buildPlan : null;
    const currentVersion = gate === 'DEPLOY' ? entry.version : artifact?.version;
    const currentHash = gate === 'DEPLOY' ? entry.hash : artifact?.hash;
    if (currentVersion !== entry.version || currentHash !== entry.hash) {
      // what was approved is not what is current: the approval is useless and a new one is requested for what exists now
      this.event(record, 'APPROVAL_STALE', gate);
      if (artifact) this.requestGateApproval(record, gate, artifact.version, artifact.hash, record.gateExtras?.[gate] ?? {});
      this.deps.store.save(record);
      return;
    }
    const payload = this.gatePayload(record, gate, entry.version, entry.hash, record.gateExtras?.[gate] ?? {});
    try {
      this.deps.approvals.consume(entry.approvalId, record.tenantId, record.ownerId, GATE_TOOL_ID[gate], payload, 'product-builder', `pbgate_${record.projectId}_${gate}_${entry.version}`);
    } catch (error) {
      this.event(record, 'APPROVAL_NOT_USABLE', `${gate}:${error instanceof NagexError ? error.code : 'ERROR'}`);
      this.deps.store.save(record);
      throw error;
    }
    entry.consumedAt = this.stamp();
    record.passedGates.push({ gate, version: entry.version, hash: entry.hash, at: entry.consumedAt });
    const next: Record<ProjectGate, ProjectState> = { PLAN: 'PLAN_APPROVED', DESIGN: 'DESIGN_APPROVED', BUILD: 'BUILD_APPROVED', DEPLOY: 'DEPLOYING' };
    this.transition(record, next[gate], `${gate}_GATE_PASSED`, `v${entry.version}`);
    this.deps.store.save(record);
  }

  /** Everything that depended on the artifact at `from` (and later) is dropped: approvals withdrawn, artifacts and results cleared. */
  private dropFrom(record: ProductProjectRecord, from: ProjectGate): void {
    const order: ProjectGate[] = ['PLAN', 'DESIGN', 'BUILD', 'DEPLOY'];
    for (const gate of order.slice(order.indexOf(from))) {
      this.supersedeApproval(record, gate);
      delete record.approvals[gate];
      record.passedGates = record.passedGates.filter((g) => g.gate !== gate);
    }
    if (from === 'PLAN') { record.mockups = null; record.design = null; }
    if (from === 'PLAN' || from === 'DESIGN') record.design = null;
    if (from !== 'DEPLOY') { record.buildPlan = from === 'BUILD' ? record.buildPlan : null; }
    if (from !== 'DEPLOY') { if (record.workspace) this.deps.workspaces.remove(record.projectId, record.workspace.workspaceId); record.workspace = null; record.test = null; record.repairAttempts = 0; }
    record.deploy = null;
  }

  // ---- what the person sees -------------------------------------------------------------------------------------------------------------------------------------------------------------

  /** The project as the person's screen shows it. Everything here is the stored record or the Approval Authority's own status; nothing is invented and no internal path, key or secret is included. */
  public viewOf(record: ProductProjectRecord): ProjectView {
    const base = `/api/v1/product-builder/projects/${record.projectId}`;
    const gates = {} as ProjectView['gates'];
    for (const gate of GATE_ORDER) {
      const entry = record.approvals[gate];
      gates[gate] = entry ? { status: this.approvalStatus(record, gate), version: entry.version, hash: entry.hash, approvalId: entry.approvalId, extra: record.gateExtras?.[gate] ?? null } : null;
    }
    const waitingFor = GATE_ORDER.find((g) => GATE_STATE[g] === record.state) ?? null;
    return {
      projectId: record.projectId, title: record.title, request: record.request, locale: record.locale, state: record.state,
      createdAt: record.createdAt, updatedAt: record.updatedAt,
      running: this.inFlight.has(record.projectId),
      waitingFor, blocker: record.blocker, failure: record.failure,
      gates,
      passedGates: record.passedGates,
      plan: record.plan,
      mockups: record.mockups ? { version: record.mockups.version, createdAt: record.mockups.createdAt, items: record.mockups.items.map((m) => ({ ...m, url: `${base}/mockups/${m.fileName}` })) } : null,
      design: record.design,
      buildPlan: record.buildPlan,
      workspace: record.workspace ? { files: record.workspace.files.map((f) => ({ path: f.path, bytes: f.bytes })), builtAt: record.workspace.builtAt } : null,
      test: record.test ? { ...record.test, screenshots: record.test.screenshots.map((s) => ({ width: s.width, url: `${base}/screenshots/${s.fileName}` })) } : null,
      repairAttempts: record.repairAttempts ?? 0,
      deploy: record.deploy ? { adapterId: record.deploy.adapterId, provider: record.deploy.provider, appName: record.deploy.appName, target: record.deploy.target, targetHash: record.deploy.targetHash, url: record.deploy.url, startedAt: record.deploy.startedAt, verifiedAt: record.deploy.verifiedAt, verification: record.deploy.verification } : null,
      history: record.history.slice(-40),
      canPreview: Boolean(record.workspace) && ['PREVIEW_READY', 'DEPLOY_PENDING_APPROVAL', 'DEPLOYING', 'DEPLOYED_VERIFIED'].includes(record.state),
      canRequestDeploy: record.state === 'PREVIEW_READY' && Boolean(record.test?.passed) && this.deps.deployers.some((d) => d.configured()),
      deployers: this.deps.deployers.map((d) => ({ adapterId: d.adapterId, provider: d.provider, configured: d.configured() })),
      mockupProviders: this.deps.mockups.map((m) => ({ providerId: m.providerId, available: m.available() })),
      mockupProviderInUse: this.mockupProvider(record)?.providerId ?? null,
    };
  }

  /** A mockup picture, only for its owner and only a file that the project's mockup set names. */
  public readMockup(projectId: string, identity: Identity, fileName: string): { data: Buffer; mimeType: string } | null {
    const record = this.get(projectId, identity);
    const item = record?.mockups?.items.find((m) => m.fileName === fileName);
    if (!record || !item) return null;
    const data = this.deps.store.readMockup(projectId, fileName);
    return data ? { data, mimeType: /^image\/(png|jpeg|webp)$/.test(item.mimeType) ? item.mimeType : 'application/octet-stream' } : null;
  }

  /** A picture of the isolated test run, only for its owner and only one the test report names. */
  public readScreenshot(projectId: string, identity: Identity, fileName: string): Buffer | null {
    const record = this.get(projectId, identity);
    if (!record?.workspace || !record.test?.screenshots.some((s) => s.fileName === fileName) || !/^shot-\d{2,4}\.png$/.test(fileName)) return null;
    try { return fs.readFileSync(path.join(this.deps.workspaces.shotsDir(projectId, record.workspace.workspaceId), fileName)); } catch { return null; }
  }

  /** One file of the CURRENT workspace of a project, for the sandboxed preview. The caller has already verified the signed link for exactly this owner and workspace. */
  public readPreviewFile(projectId: string, tenantId: string, ownerId: string, workspaceId: string, relativePath: string): { data: Buffer; contentType: string } | null {
    const record = this.deps.store.getOwned(projectId, tenantId, ownerId);
    if (!record?.workspace || record.workspace.workspaceId !== workspaceId) return null;
    const rel = relativePath === '' || relativePath.endsWith('/') ? `${relativePath}index.html` : relativePath;
    const data = this.deps.workspaces.read(projectId, workspaceId, rel);
    return data ? { data, contentType: contentTypeFor(rel) } : null;
  }

  /** The workspace id of the project's current build, for minting a preview link (null when there is nothing to preview). */
  public previewWorkspaceId(projectId: string, identity: Identity): string | null {
    const record = this.get(projectId, identity);
    return record?.workspace && this.viewOf(record).canPreview ? record.workspace.workspaceId : null;
  }

  // ---- bookkeeping ----------------------------------------------------------------------------------------------------------------------------------------------------------------------

  private requireOwned(projectId: string, identity: Identity): ProductProjectRecord {
    const record = this.get(projectId, identity);
    if (!record) fail('PRODUCT_PROJECT_NOT_FOUND', 'NOT_FOUND', 'No such project.');
    return record;
  }

  private stamp(): string { return this.now().toISOString(); }

  private event(record: ProductProjectRecord, event: string, note?: string): void {
    record.history.push({ at: this.stamp(), event, state: record.state, ...(note ? { note } : {}) });
  }

  private transition(record: ProductProjectRecord, to: ProjectState, event: string, note?: string): void {
    if (!isAllowedTransition(record.state, to)) throw new Error(`ILLEGAL_TRANSITION ${record.state} -> ${to}`);
    record.state = to;
    record.blocker = to === 'BLOCKED' ? record.blocker : null;
    this.event(record, event, note);
  }

  private block(record: ProductProjectRecord, code: string, need: BlockerNeed, message: string, blockedAt: ProjectState): void {
    record.blocker = { code, need, message: message.slice(0, 600), blockedAt };
    this.transition(record, 'BLOCKED', `BLOCKED:${code}`);
    record.blocker = { code, need, message: message.slice(0, 600), blockedAt };
    this.deps.store.save(record);
    this.audit('product_builder.blocked', record, 'product-builder', code);
  }

  private failProject(record: ProductProjectRecord, code: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    record.failure = { code, message: detail.split('\n')[0].slice(0, 300), at: record.state };
    if (isAllowedTransition(record.state, 'FAILED')) this.transition(record, 'FAILED', `FAILED:${code}`);
    else record.state = 'FAILED';
    this.deps.store.save(record);
    this.audit('product_builder.failed', record, 'product-builder', code);
  }

  private otherProvidersNote(used: MockupPort): string {
    const others = this.deps.mockups.filter((m) => m.providerId !== used.providerId && m.available()).map((m) => m.providerId);
    return others.length > 0 ? ` Another image provider is available (${others.join(', ')}): choose it to continue.` : '';
  }

  private readWorkspaceFiles(record: ProductProjectRecord): GeneratedFile[] | null {
    if (!record.workspace) return null;
    const out: GeneratedFile[] = [];
    for (const file of record.workspace.files) {
      const data = this.deps.workspaces.read(record.projectId, record.workspace.workspaceId, file.path);
      if (data) out.push({ path: file.path, content: data });
    }
    return out;
  }

  private titleFrom(request: string): string {
    const first = request.replace(/\s+/g, ' ').trim().slice(0, 60);
    return first || 'Untitled product';
  }

  private safeAppName(requested: string | undefined, title: string): string {
    const base = String(requested ?? title ?? 'nagex-app').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    return base || 'nagex-app';
  }

  private audit(action: string, record: ProductProjectRecord | null, requestId: string, detail?: string): void {
    try {
      this.deps.audit?.logEvent({
        actor: { type: 'user', id: record?.ownerId ?? 'unknown' }, tenant_id: record?.tenantId ?? 'unknown', action,
        resource: { type: 'ProductProject', id: record?.projectId ?? 'unknown' }, result: 'SUCCESS', request_id: requestId, ...(detail ? { details: { detail } } : {}),
      });
    } catch { /* an audit failure never changes the workflow */ }
  }
}

/** inserts the marker as a meta tag in the head (or at the top when there is no head) */
export function stampIndexHtml(html: string, marker: string): string {
  const tag = `<meta name="nagex-build" content="${marker}">`;
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${tag}\n</head>`);
  return `${tag}\n${html}`;
}

export interface ProjectView {
  projectId: string; title: string; request: string; locale: 'en' | 'ko'; state: ProjectState; createdAt: string; updatedAt: string;
  running: boolean;
  waitingFor: ProjectGate | null;
  blocker: ProductProjectRecord['blocker'];
  failure: ProductProjectRecord['failure'];
  gates: Record<ProjectGate, { status: ReturnType<ProductBuilderService['approvalStatus']>; version: number; hash: string; approvalId: string; extra: Record<string, unknown> | null } | null>;
  passedGates: ProductProjectRecord['passedGates'];
  plan: ProductProjectRecord['plan'];
  mockups: { version: number; createdAt: string; items: Array<MockupItem & { url: string }> } | null;
  design: ProductProjectRecord['design'];
  buildPlan: ProductProjectRecord['buildPlan'];
  workspace: { files: Array<{ path: string; bytes: number }>; builtAt: string } | null;
  test: (Omit<NonNullable<ProductProjectRecord['test']>, 'screenshots'> & { screenshots: Array<{ width: number; url: string }> }) | null;
  repairAttempts: number;
  deploy: Pick<NonNullable<ProductProjectRecord['deploy']>, 'adapterId' | 'provider' | 'appName' | 'target' | 'targetHash' | 'url' | 'startedAt' | 'verifiedAt' | 'verification'> | null;
  history: ProductProjectRecord['history'];
  canPreview: boolean;
  canRequestDeploy: boolean;
  deployers: Array<{ adapterId: string; provider: string; configured: boolean }>;
  mockupProviders: Array<{ providerId: string; available: boolean }>;
  /** the image provider this project's pictures are (or will be) made by: the person's own choice, else the first one that is set up */
  mockupProviderInUse: string | null;
}

// re-exported for tests and routes
export type { ProductPlan, DesignSpec, BuildPlan };
