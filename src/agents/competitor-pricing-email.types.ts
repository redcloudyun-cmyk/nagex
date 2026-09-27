// R23.6E — Competitor Pricing Monitor + Email canonical scenario types.
//
// This is the ONE scenario-specific domain module R23.6E adds (Decision 1 —
// no generic cross-step binding engine, no generic workflow DSL). It exists
// deliberately outside src/agent/ (singular) — that directory (agent.executor.ts,
// multi-agent.orchestrator.ts, tool.invoker.ts) is untouched legacy bootstrap
// scaffolding: a separate PDP-based authorization model ('agent:execute'
// against a nonexistent Agent resource registry) that has never been wired
// into server_web.ts/create-nagex-application.ts and shares no code with the
// real approval/execution chain (ActionApprovalStore,
// GoogleCapabilityExecutionPipeline, ExecutingTaskRunner) this scenario
// actually reuses. Building on it would resurrect unrelated bootstrap code
// per AGENTS.md's explicit warning; R23.6E's own module is named plural
// (src/agents/) specifically to avoid being confused with it.

// ── Run status (Section 15 / Phase B) ───────────────────────────────────
// Deliberately small and explicit — no existing status model (TaskStatus is
// scheduling/trigger-oriented; TaskProgress is free-text only, per the
// Phase A audit) already captures this one interactive run's phases.
export type E2EAgentRunStatus =
  | 'RESEARCHING'
  | 'REPORT_READY'
  | 'DRAFT_CREATED'
  | 'APPROVAL_REQUIRED'
  | 'APPROVED'
  | 'SEND_ATTEMPTED'
  | 'SENT_CONFIRMED'
  | 'FAILED'
  | 'BLOCKED';

// Section 23 — failure/block reasons. Never exposed to the user as a raw
// code (Section 24); only used internally / in Activity+Audit detail.
export type E2EAgentFailureReason =
  | 'RESEARCH_UNAVAILABLE'
  | 'EVIDENCE_INSUFFICIENT'
  | 'BASELINE_NOT_FOUND'
  | 'NOT_COMPARABLE'
  | 'MODEL_UNAVAILABLE'
  | 'DRAFT_FAILED'
  | 'APPROVAL_REJECTED'
  | 'PAYLOAD_DRIFT'
  | 'CREDENTIAL_UNAVAILABLE'
  | 'SEND_FAILED'
  | 'SEND_UNCONFIRMED'
  | 'RECIPIENT_INVALID'
  | 'APPROVAL_EXPIRED';

export interface CompetitorPricingResearchRequest {
  tenantId: string;
  ownerId: string;
  requestId: string;
  competitor: string;
  targetUrl?: string;
  recipientEmail?: string;
}

// ── Untrusted evidence (Decision 3) ─────────────────────────────────────
// Deliberately NOT the shared research/evidence-pack.types.ts EvidenceSource
// — that type has no trust-provenance field, and per Decision 3 this stays
// a local, mandatory typed wrapper for R23.6E only. Every EvidencePack
// result and every Browser result MUST cross this boundary before entering
// comparison/synthesis/action preparation; nothing downstream may read a
// raw EvidenceSource or a raw Browser snapshot directly.
export type UntrustedEvidenceSourceKind = 'WEB' | 'BROWSER' | 'EXTERNAL_API';

export interface UntrustedEvidenceTrust {
  level: 'UNTRUSTED_EXTERNAL';
  source: UntrustedEvidenceSourceKind;
  canGrantPermission: false;
  canApproveAction: false;
  canAuthorizeCredentialUse: false;
  canOverridePolicy: false;
  canWritePersistentMemory: false;
}

// trust is NOT optional — see untrusted-evidence.normalizer.ts, the only
// place allowed to construct one of these.
export interface UntrustedPricingEvidence {
  sourceUrl: string;
  retrievedAt: string;
  title: string;
  excerpt: string;
  planName: string | null;
  price: number | null;
  currency: string | null;
  billingPeriod: string | null;
  region: string | null;
  taxIncluded: boolean | null;
  trust: UntrustedEvidenceTrust;
}

// ── Baseline / comparison (Decision 4, 5, 6) ────────────────────────────
export interface CompetitorPricingBaselineRecord {
  baselineId: string;
  tenantId: string;
  ownerId: string;
  competitor: string;
  dimensionKey: string;
  planName: string | null;
  currency: string | null;
  billingPeriod: string | null;
  region: string | null;
  taxIncluded: boolean | null;
  price: number;
  sourceUrl: string;
  retrievedAt: string;
  verifiedAt: string;
  createdAt: string;
}

export type PricingChangeReason = 'NO_BASELINE' | 'NOT_DIRECTLY_COMPARABLE';

export interface PricingChange {
  current: UntrustedPricingEvidence;
  previous: CompetitorPricingBaselineRecord | null;
  comparable: boolean;
  reason?: PricingChangeReason;
  absoluteChange?: number;
  percentChange?: number;
}

// ── Draft payload (Phase D) ────────────────────────────────────────────
// R23.6E deliberately never calls Gmail's own create_draft API (that tool
// is itself approval-gated in this codebase, and a second, hidden
// server-side approval for an internal step would be exactly the kind of
// silent self-approval the product forbids). "DRAFT_CREATED" here means an
// internal, immutable, email-ready payload persisted on the run record —
// the SAME payload gmail.send_email's real, human-facing approval binds to
// (Section 8/9). Local to this module (never GmailComposePayload —
// gmail.client.ts's internal type — module-private, zero external
// consumers by design).
export interface CompetitorPricingDraftPayload {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
}

// ── Run record ───────────────────────────────────────────────────────────
export interface CompetitorPricingRunRecord {
  runId: string;
  tenantId: string;
  ownerId: string;
  requestId: string;
  competitor: string;
  targetUrl: string | null;
  recipientEmail: string | null;
  status: E2EAgentRunStatus;
  failureReason: E2EAgentFailureReason | null;
  evidence: UntrustedPricingEvidence[];
  change: PricingChange | null;
  reportSubject: string | null;
  reportBody: string | null;
  // Frozen at DRAFT_CREATED (Section 10) — nothing in Phase D writes to
  // this again after APPROVAL_REQUIRED is reached; Phase E's payload-drift
  // protection is what detects any later attempted mutation.
  draftPayload: CompetitorPricingDraftPayload | null;
  draftId: string | null;
  approvalId: string | null;
  executionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export function isE2EAgentRunStatus(value: unknown): value is E2EAgentRunStatus {
  return value === 'RESEARCHING' || value === 'REPORT_READY' || value === 'DRAFT_CREATED'
    || value === 'APPROVAL_REQUIRED' || value === 'APPROVED' || value === 'SEND_ATTEMPTED'
    || value === 'SENT_CONFIRMED' || value === 'FAILED' || value === 'BLOCKED';
}
