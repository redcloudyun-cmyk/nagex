export type ModelTaskKind =
  | 'CHAT'
  | 'RESEARCH_SYNTHESIS'
  | 'DOCUMENT_SYNTHESIS'
  | 'PLAN'
  | 'STRUCTURED_EXTRACTION'
  | 'DAILY_BRIEF'
  | 'MEETING_PREP'
  | 'PERSPECTIVE_ANALYSIS'
  | 'PERSPECTIVE_SYNTHESIS'
  | 'FORECAST_ANALYSIS'
  | 'FORECAST_SYNTHESIS';

export interface ModelRoutingContext {
  taskKind: ModelTaskKind;
  requiresJson: boolean;
  requiresEvidenceGrounding?: boolean;
  latencyPreference?: 'LOW' | 'NORMAL';
  requestId: string;
}

// The capability names NAgex reasons about for a model. A value is evidence, not marketing:
//   SUPPORTED   exercised by an automated test against the adapter (a fake endpoint) AND/OR a recorded real call
//   UNVERIFIED  declared/expected, but no test evidence yet — the router never relies on it for a hard guarantee
//   UNSUPPORTED the provider/model is known not to do it
export type ModelCapabilityName =
  | 'CHAT_COMPLETION'
  | 'REASONING'
  | 'PLANNING'
  | 'RESEARCH_SYNTHESIS'
  | 'TOOL_USE'
  | 'STRUCTURED_OUTPUT'
  | 'LONG_CONTEXT';
export type CapabilityEvidence = 'SUPPORTED' | 'UNVERIFIED' | 'UNSUPPORTED';

export interface ModelProviderCapabilities {
  provider: string;
  supportsJsonMode: boolean;
  supportsGeneralChat: boolean;
  supportsStructuredExtraction: boolean;
  // When present, the provider takes part in AUTOMATIC routing only for these tasks. An explicit, allowed provider override
  // is unaffected. Absent = every task the boolean capabilities allow (the behavior of every pre-existing provider).
  eligibleTaskKinds?: ModelTaskKind[];
  // Evidence-graded capability declaration (see ModelCapabilityName). Informational for routing; asserted by tests.
  declared?: Partial<Record<ModelCapabilityName, CapabilityEvidence>>;
}

export type ModelRoutingReasonCode =
  | 'TASK_SUPPORTED'
  | 'JSON_MODE_REQUIRED'
  | 'PROVIDER_LIVE'
  | 'PROVIDER_CONFIGURED'
  | 'PROVIDER_DEGRADED_DEPRIORITIZED'
  | 'CONFIGURED_PRIORITY'
  | 'TASK_PREFERRED_PROVIDER'
  | 'EXPLICIT_OVERRIDE';

export interface ModelRoutingDecision {
  taskKind: ModelTaskKind;
  selectedProvider: string;
  fallbackProviders: string[];
  reasonCodes: string[];
  // The provider the routing table prefers for this task, whether or not it is configured/eligible/selected; null if none.
  preferredProvider?: string | null;
}

// Per-task provider preference (ordered). A preference ranks a provider first for that task; it never makes an
// unconfigured, incapable or out-of-scope provider eligible, and it never overrides an explicit provider choice.
export type TaskProviderPreferences = Partial<Record<ModelTaskKind, string[]>>;
