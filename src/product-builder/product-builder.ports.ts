// The seams of the Product Builder. Each external capability sits behind a port so a provider is replaceable (planning model, image provider, coding engine, test runner, deployment target) and so
// the state machine and its approvals never depend on one vendor. A port that cannot do its job reports WHY in a typed way (a credential, a quota, an authorization, a sandbox, an engine) and the
// project ends in BLOCKED with that reason - there is no silent fallback to a different provider and no pretend result.
import type { BlockerNeed, BuildPlan, DeploymentRecord, DeployTarget, DesignSpec, MockupItem, ProductPlan, SiteCheck, TestReport } from './product-builder.types.js';
export type { DeployTarget } from './product-builder.types.js';
import type { GeneratedFile } from './product-workspace.js';

export interface PlanningPort {
  draftPlan(input: { request: string; locale: 'en' | 'ko'; previous: ProductPlan | null; feedback: string | null; requestId: string }): Promise<ProductPlan>;
  draftDesign(input: { plan: ProductPlan; mockups: MockupItem[]; locale: 'en' | 'ko'; previous: DesignSpec | null; feedback: string | null; requestId: string }): Promise<DesignSpec>;
  draftBuildPlan(input: { plan: ProductPlan; design: DesignSpec; engine: { id: string; kind: string; available: boolean }; deployTarget: { provider: string; kind: string; configured: boolean }; locale: 'en' | 'ko'; previous: BuildPlan | null; feedback: string | null; requestId: string }): Promise<BuildPlan>;
}

export type MockupOutcome =
  | { ok: true; images: Array<{ caption: string; mimeType: string; data: Buffer }> }
  | { ok: false; code: string; need: BlockerNeed; message: string };

/** Visual mockups of the product: REAL generated images. An implementation must not return placeholder pictures as if they were generated. */
export interface MockupPort {
  readonly providerId: string;
  available(): boolean;
  generate(input: { plan: ProductPlan; count: number; feedback: string | null; requestId: string }): Promise<MockupOutcome>;
}

export type ImplementOutcome =
  | { ok: true; files: GeneratedFile[]; note?: string }
  | { ok: false; code: string; need: BlockerNeed; message: string };

/** Produces the files of the product from the approved plan, design and build plan. It never runs anything: the files are data. */
export interface CodingEnginePort {
  readonly engineId: string;
  readonly kind: string;
  available(): boolean;
  implement(input: { plan: ProductPlan; design: DesignSpec; buildPlan: BuildPlan; previousFiles: GeneratedFile[] | null; repairHints: string[]; requestId: string }): Promise<ImplementOutcome>;
}

/** Runs a product in an isolated browser whose network is limited to the product itself. `source` is the workspace (before preview) or a deployed address (after deployment). */
export interface SiteTesterPort {
  readonly isolation: string;
  run(input: { source: { dir: string } | { url: string }; checks: SiteCheck[]; widths: number[]; screenshotsDir: string | null }): Promise<TestReport>;
}

export type DeployOutcome =
  | { ok: true; deployId: string; url: string }
  // `uncertain`: the request may have been accepted although no answer arrived. It is NEVER retried blindly (a second site could be created, and billed).
  | { ok: false; code: string; need: BlockerNeed; message: string; uncertain?: boolean };

export interface DeployPort {
  readonly adapterId: string;
  readonly provider: string;
  configured(): boolean;
  describeTarget(appName: string): DeployTarget;
  deploy(input: { workspaceDir: string; files: Array<{ path: string; bytes: number }>; target: DeployTarget; requestId: string }): Promise<DeployOutcome>;
}

export interface DeployVerifierPort {
  /** "deployed" is only ever reported after this: the address answers, the expected content is there, the smoke checks pass */
  verify(input: { url: string; marker: string; checks: SiteCheck[] }): Promise<NonNullable<DeploymentRecord['verification']>>;
}
