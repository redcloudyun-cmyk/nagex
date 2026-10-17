// AI Product Builder - the states, the gates and the records of a project that goes from a request to a verified deployment, step by step, with the person deciding at four gates.
//
//   REQUIREMENTS -> PLAN -> [Gate 1: PLAN approved] -> VISUAL MOCKUPS (real images) -> DESIGN SPEC -> [Gate 2: DESIGN approved] -> BUILD PLAN -> [Gate 3: BUILD approved]
//   -> IMPLEMENT (isolated workspace) -> TEST -> PREVIEW -> [Gate 4: DEPLOY approved] -> DEPLOY -> VERIFY
//
// Nothing is built before Gate 3 and nothing is deployed before Gate 4. Every gate approval is bound to the VERSION and HASH of what the person saw: changing the plan, the design, the build plan or
// the deployment target after approval creates a new version and needs a new approval (through the same Approval Authority every other consequential action uses - there is no second approval engine).
// The state is persistent and resumable. A step that cannot be done for lack of a credential, a quota, an authorization or a sandbox ends in BLOCKED with the exact reason - never in a pretend result.
import crypto from 'node:crypto';
import type { FailureClass, FallbackRule, RetryRule } from '../adaptive/failure-taxonomy.js';

export type ProjectState =
  | 'REQUIREMENTS_DRAFT'
  | 'PLAN_PENDING_APPROVAL'
  | 'PLAN_APPROVED'
  | 'MOCKUP_GENERATING'
  | 'DESIGN_PENDING_APPROVAL'
  | 'DESIGN_APPROVED'
  | 'BUILD_PLAN_PENDING_APPROVAL'
  | 'BUILD_APPROVED'
  | 'IMPLEMENTING'
  | 'TESTING'
  | 'PREVIEW_READY'
  | 'DEPLOY_PENDING_APPROVAL'
  | 'DEPLOYING'
  | 'DEPLOYED_VERIFIED'
  | 'FAILED'
  | 'BLOCKED'
  | 'CANCELLED';

export type ProjectGate = 'PLAN' | 'DESIGN' | 'BUILD' | 'DEPLOY';

export const GATE_STATE: Readonly<Record<ProjectGate, ProjectState>> = Object.freeze({
  PLAN: 'PLAN_PENDING_APPROVAL',
  DESIGN: 'DESIGN_PENDING_APPROVAL',
  BUILD: 'BUILD_PLAN_PENDING_APPROVAL',
  DEPLOY: 'DEPLOY_PENDING_APPROVAL',
});

export const GATE_TOOL_ID: Readonly<Record<ProjectGate, string>> = Object.freeze({
  PLAN: 'product.plan.approve',
  DESIGN: 'product.design.approve',
  BUILD: 'product.build.approve',
  DEPLOY: 'product.deploy.approve',
});

export const GATE_ORDER: readonly ProjectGate[] = Object.freeze(['PLAN', 'DESIGN', 'BUILD', 'DEPLOY'] as ProjectGate[]);

export const TERMINAL_STATES: ReadonlySet<ProjectState> = new Set<ProjectState>(['DEPLOYED_VERIFIED', 'FAILED', 'CANCELLED']);

/** The only moves the state machine makes. Anything else is refused (and recorded), never silently applied. */
export const ALLOWED_TRANSITIONS: Readonly<Record<ProjectState, readonly ProjectState[]>> = Object.freeze({
  REQUIREMENTS_DRAFT: ['PLAN_PENDING_APPROVAL', 'BLOCKED', 'FAILED', 'CANCELLED'],
  PLAN_PENDING_APPROVAL: ['PLAN_PENDING_APPROVAL', 'PLAN_APPROVED', 'BLOCKED', 'FAILED', 'CANCELLED'],
  PLAN_APPROVED: ['MOCKUP_GENERATING', 'BLOCKED', 'FAILED', 'CANCELLED'],
  MOCKUP_GENERATING: ['DESIGN_PENDING_APPROVAL', 'BLOCKED', 'FAILED', 'CANCELLED'],
  DESIGN_PENDING_APPROVAL: ['DESIGN_PENDING_APPROVAL', 'DESIGN_APPROVED', 'PLAN_PENDING_APPROVAL', 'MOCKUP_GENERATING', 'BLOCKED', 'FAILED', 'CANCELLED'],
  DESIGN_APPROVED: ['BUILD_PLAN_PENDING_APPROVAL', 'BLOCKED', 'FAILED', 'CANCELLED'],
  BUILD_PLAN_PENDING_APPROVAL: ['BUILD_PLAN_PENDING_APPROVAL', 'BUILD_APPROVED', 'DESIGN_PENDING_APPROVAL', 'PLAN_PENDING_APPROVAL', 'MOCKUP_GENERATING', 'BLOCKED', 'FAILED', 'CANCELLED'],
  BUILD_APPROVED: ['IMPLEMENTING', 'BLOCKED', 'FAILED', 'CANCELLED'],
  IMPLEMENTING: ['TESTING', 'BLOCKED', 'FAILED', 'CANCELLED'],
  TESTING: ['PREVIEW_READY', 'IMPLEMENTING', 'BLOCKED', 'FAILED', 'CANCELLED'],
  PREVIEW_READY: ['DEPLOY_PENDING_APPROVAL', 'IMPLEMENTING', 'BLOCKED', 'FAILED', 'CANCELLED'],
  DEPLOY_PENDING_APPROVAL: ['DEPLOY_PENDING_APPROVAL', 'DEPLOYING', 'PREVIEW_READY', 'BLOCKED', 'FAILED', 'CANCELLED'],
  DEPLOYING: ['DEPLOYED_VERIFIED', 'BLOCKED', 'FAILED', 'CANCELLED'],
  DEPLOYED_VERIFIED: [],
  FAILED: [],
  // a blocked project goes back to the step that was blocked once the person has resolved the blocker
  BLOCKED: ['REQUIREMENTS_DRAFT', 'PLAN_PENDING_APPROVAL', 'MOCKUP_GENERATING', 'DESIGN_PENDING_APPROVAL', 'DESIGN_APPROVED', 'BUILD_PLAN_PENDING_APPROVAL', 'IMPLEMENTING', 'TESTING', 'DEPLOYING', 'FAILED', 'CANCELLED'],
  CANCELLED: [],
});

export type BlockerNeed = 'CREDENTIAL' | 'QUOTA' | 'AUTHORIZATION' | 'SANDBOX' | 'ENGINE' | 'CONFIGURATION' | 'PERSON';

export interface ProjectBlocker {
  code: string;
  need: BlockerNeed;
  /** what is missing and what the person can do, in a plain sentence (never a secret, never a stack) */
  message: string;
  /** the state to go back to when the blocker is resolved */
  blockedAt: ProjectState;
}

// ---- the artifacts the person approves -----------------------------------------------------------------------------------------------------------------------------------------------------

export interface ProductPlan {
  summary: string;
  audience: string;
  pages: Array<{ id: string; title: string; purpose: string }>;
  features: Array<{ id: string; title: string; detail: string }>;
  dataModel: Array<{ entity: string; fields: string[] }>;
  nonGoals: string[];
  assumptions: string[];
  openQuestions: string[];
}

export interface MockupItem {
  mockupId: string;
  caption: string;
  providerId: string;
  mimeType: string;
  fileName: string;
  bytes: number;
  sha256: string;
  /** read from the image itself when it was verified */
  width?: number;
  height?: number;
}

/** One route the work could move to, as the person is shown it: who they are, what changes, what it costs (or that nobody knows). */
export interface RouteOptionView {
  routeId: string;
  providerId: string;
  label: string;
  vendorId: string;
  processing: string;
  rank: number;
  changes: Array<{ kind: string; detail: string }>;
  costKnown: boolean;
  usd: number | null;
}

/**
 * What the adaptive planner decided when a route failed and the work could not simply carry on: the failure by normalized class, the routes that are eligible (in order, and who ordered them), what is
 * missing when none is, and whether the person's decision is needed. It is advice to the person and a record for the audit trail; it grants nothing.
 */
export interface RecoveryProposal {
  goalId: string;
  at: string;
  failureClass: FailureClass;
  retry: RetryRule;
  fallback: FallbackRule;
  decision: 'SWITCH_ROUTE' | 'ASK_PERSON' | 'ABORT' | 'RECONCILE_FIRST';
  requiresApproval: boolean;
  rankedBy: 'DETERMINISTIC' | 'ADVISOR' | 'DETERMINISTIC_FALLBACK' | null;
  advisor: { provider: string; effect: string; confidence: number } | null;
  options: RouteOptionView[];
  missing: Array<{ provider: string; label: string; reasons: string[] }>;
  abortReason: string | null;
  failedRouteId: string;
  failedProvider: string;
}

export interface DesignSpec {
  layout: string;
  typography: { heading: string; body: string; scale: string };
  colors: Record<string, string>;
  components: string[];
  navigation: string;
  responsive: { breakpoints: string[]; notes: string };
  states: string[];
}

/**
 * What a test run can check - a small, closed, deterministic vocabulary (a free-text "check that the page is nice" cannot be executed and is never accepted). NAgex always adds its own built-in
 * checks (the page loads, no console errors, no external requests, no sideways scrolling at each width); a plan only adds checks from this list.
 */
export type SiteCheck =
  | { id: string; description: string; kind: 'TEXT_PRESENT'; text: string }
  | { id: string; description: string; kind: 'ELEMENT_PRESENT'; selector: string }
  // typing `query` into the field narrows a list: `expectText` stays visible and `hideText` (when given) disappears
  | { id: string; description: string; kind: 'SEARCH_FILTERS'; inputSelector: string; query: string; expectText: string; hideText?: string };

export interface BuildPlan {
  engine: { id: string; kind: string; note: string };
  framework: string;
  database: string;
  deployTarget: { provider: string; kind: string };
  costEstimate: { usd: number | null; note: string };
  credentialsNeeded: string[];
  steps: string[];
  testChecks: SiteCheck[];
}

/** Everything the person approves at Gate 4: where, under what name, how exposed, at what cost, with which secrets, which database, how to undo. */
export interface DeployTarget {
  provider: string;
  adapterId: string;
  appName: string;
  account: string | null;
  exposure: 'PUBLIC';
  costLimitUsd: number | null;
  envSecretNames: string[];
  database: string;
  rollback: string;
}

export interface VersionedArtifact<T> {
  version: number;
  hash: string;
  content: T;
  createdAt: string;
}

export interface GateApproval {
  approvalId: string;
  gate: ProjectGate;
  /** the artifact version and hash the approval is bound to */
  version: number;
  hash: string;
  requestedAt: string;
  consumedAt: string | null;
}

export interface WorkspaceFile { path: string; bytes: number; sha256: string }

export interface TestCheckResult { id: string; description: string; passed: boolean; detail: string }
export interface TestReport {
  ranAt: string;
  passed: boolean;
  checks: TestCheckResult[];
  screenshots: Array<{ width: number; fileName: string }>;
  consoleErrors: string[];
  blockedRequests: number;
}

export interface DeploymentRecord {
  adapterId: string;
  provider: string;
  appName: string;
  /** what the person is asked to approve at Gate 4 (the whole target, in the clear) */
  target: DeployTarget;
  /** the hash of the exact deployment target AND files the person approved */
  targetHash: string;
  deployId: string | null;
  url: string | null;
  startedAt: string | null;
  verifiedAt: string | null;
  verification: { reachable: boolean; status: number | null; markerFound: boolean; smokePassed: boolean; checkedAt: string } | null;
}

export interface ProjectEvent { at: string; event: string; state: ProjectState; note?: string }

export interface ProductProjectRecord {
  projectId: string;
  tenantId: string;
  ownerId: string;
  title: string;
  /** the person's own words */
  request: string;
  locale: 'en' | 'ko';
  state: ProjectState;
  blocker: ProjectBlocker | null;
  failure: { code: string; message: string; at: ProjectState } | null;
  plan: VersionedArtifact<ProductPlan> | null;
  mockups: { version: number; items: MockupItem[]; createdAt: string } | null;
  design: (VersionedArtifact<DesignSpec> & { basedOnMockupVersion: number | null }) | null;
  buildPlan: VersionedArtifact<BuildPlan> | null;
  approvals: Partial<Record<ProjectGate, GateApproval>>;
  /** gates the person has passed, with the version approved (the proof that nothing past a gate ran without it) */
  passedGates: Array<{ gate: ProjectGate; version: number; hash: string; at: string }>;
  workspace: { workspaceId: string; builtFrom: { planHash: string; designHash: string; buildPlanHash: string }; files: WorkspaceFile[]; builtAt: string; /** stamped into index.html by NAgex: what a deployed copy must contain */ marker: string } | null;
  test: TestReport | null;
  deploy: DeploymentRecord | null;
  history: ProjectEvent[];
  /** the image provider the person chose after a block (otherwise the first one that is available) */
  mockupProviderId?: string | null;
  feedbackForMockups?: string | null;
  /** why the pictures could not simply be made, and what the person can decide (set while BLOCKED at the mockup step) */
  recovery?: RecoveryProposal | null;
  /** every time the person resolves a blocker at the mockup step a new round of attempts begins (a fresh attempt budget); earlier rounds stay in the history */
  mockupRound?: number;
  /** extra fields bound into each gate's approval payload, kept so the approval is checked against exactly what it was requested for */
  gateExtras?: Partial<Record<ProjectGate, Record<string, unknown>>>;
  repairAttempts?: number;
  createdAt: string;
  updatedAt: string;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().filter((k) => record[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(',')}}`;
}

export function artifactHash(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

export function isAllowedTransition(from: ProjectState, to: ProjectState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}
