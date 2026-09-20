export type ModelTaskKind =
  | 'CHAT'
  | 'RESEARCH_SYNTHESIS'
  | 'PLAN'
  | 'STRUCTURED_EXTRACTION'
  | 'DAILY_BRIEF'
  | 'MEETING_PREP'
  | 'PERSPECTIVE_ANALYSIS'
  | 'PERSPECTIVE_SYNTHESIS';

export interface ModelRoutingContext {
  taskKind: ModelTaskKind;
  requiresJson: boolean;
  requiresEvidenceGrounding?: boolean;
  latencyPreference?: 'LOW' | 'NORMAL';
  requestId: string;
}

export interface ModelProviderCapabilities {
  provider: string;
  supportsJsonMode: boolean;
  supportsGeneralChat: boolean;
  supportsStructuredExtraction: boolean;
}

export type ModelRoutingReasonCode =
  | 'TASK_SUPPORTED'
  | 'JSON_MODE_REQUIRED'
  | 'PROVIDER_LIVE'
  | 'PROVIDER_CONFIGURED'
  | 'PROVIDER_DEGRADED_DEPRIORITIZED'
  | 'CONFIGURED_PRIORITY'
  | 'EXPLICIT_OVERRIDE';

export interface ModelRoutingDecision {
  taskKind: ModelTaskKind;
  selectedProvider: string;
  fallbackProviders: string[];
  reasonCodes: string[];
}
