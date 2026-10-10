export const SCENARIO_CATEGORIES = [
  'MESSAGING',
  'EMAIL',
  'CALENDAR',
  'RESEARCH',
  'REPORT',
  'DOCUMENT',
  'SLIDES',
  'IMAGE',
  'VIDEO',
  'ARTIFACT_CREATION',
  'RESERVATION',
  'TRAVEL',
  'RIDE_HAILING',
  'COMMERCE',
  'PAYMENT',
  'PERSONAL_ROUTINE',
  'BACKGROUND',
  'CONDITION_WATCH',
  'MULTI_DEVICE',
  'MULTIMODAL',
  'SECURITY',
  'FAILURE_RECOVERY',
  'CROSS_CAPABILITY',
] as const;

export type ScenarioCategory = typeof SCENARIO_CATEGORIES[number];

export const SCENARIO_RISK_LEVELS = [
  'L0_READ_ONLY',
  'L1_CREATE',
  'L2_REVERSIBLE_ACTION',
  'L3_EXTERNAL_COMMUNICATION',
  'L4_RESERVATION_TRANSACTION',
  'L5_MONETARY_HIGH_CONSEQUENCE',
] as const;

export type ScenarioRiskLevel = typeof SCENARIO_RISK_LEVELS[number];

export type ScenarioExecutionMode =
  | 'FOREGROUND'
  | 'BACKGROUND'
  | 'BACKGROUND_WITH_FOREGROUND_APP_ACTIVATION';

export type ScenarioTestMode = 'SIMULATION' | 'SANDBOX' | 'REAL';

export type ScenarioInputModality =
  | 'TEXT'
  | 'VOICE'
  | 'IMAGE'
  | 'VIDEO'
  | 'SCREEN'
  | 'FILE'
  | 'SHARE'
  | 'CLIPBOARD'
  | 'EMAIL_EVENT'
  | 'CALENDAR_EVENT'
  | 'SYSTEM_EVENT'
  | 'MULTIMODAL';

export type ScenarioOriginDevice = 'DESKTOP' | 'MOBILE' | 'WEB' | 'ANDROID' | 'IOS' | 'SYSTEM';

export type ScenarioStatus =
  | 'PASS'
  | 'FAIL'
  | 'BLOCKED_USER_INTERACTION'
  | 'WAITING_FOR_PRECONDITION'
  | 'OUTCOME_UNVERIFIED'
  | 'SKIPPED';

export type ScenarioEvidenceType =
  | 'API_RESPONSE'
  | 'UI_TREE'
  | 'SCREENSHOT_VISION'
  | 'FILE_ARTIFACT'
  | 'MESSAGE_OUTBOUND'
  | 'RESERVATION_CONFIRMATION'
  | 'CALENDAR_EVENT'
  | 'REPORT_ARTIFACT'
  | 'BROWSER_EVIDENCE'
  | 'SIMULATION_TRACE';

export interface ScenarioEvidenceRef {
  evidenceId: string;
  scenarioId: string;
  runId: string;
  evidenceType: ScenarioEvidenceType;
  observedAt: string;
  summary: string;
  redacted: true;
  commandId?: string;
  executionId?: string;
  approvalId?: string;
  deviceId?: string;
  artifactRef?: string;
}

export interface ScenarioStageRequirements {
  intentResolved?: boolean;
  targetResolved?: boolean;
  approvalGranted?: boolean;
  executionStarted?: boolean;
  executionDispatched?: boolean;
  outcomeObserved?: boolean;
  outcomeVerified?: boolean;
  cleanupVerified?: boolean;
  contextRestored?: boolean;
}

export interface ScenarioDefinition {
  scenarioId: string;
  version: string;
  title: string;
  category: ScenarioCategory;
  riskLevel: ScenarioRiskLevel;
  userIntent: string;
  inputModalities?: ScenarioInputModality[];
  originDevice?: ScenarioOriginDevice;
  originSurface?: string;
  initialContext: Record<string, unknown>;
  availableMemory?: string[];
  activeApp?: string | null;
  connectedDevices?: string[];
  requiredCapabilities: string[];
  preferredRoutes: string[];
  targetResolution?: string;
  routeResolution?: string;
  approvalPolicy: 'NONE' | 'IF_RISK_REQUIRES' | 'ALWAYS';
  approvalRequirement?: string;
  executionGoal?: string;
  verificationGoal?: string;
  cleanupGoal?: string;
  recoveryCases?: string[];
  hardStopCases?: string[];
  performanceTarget?: string;
  modes?: ScenarioTestMode[];
  ruleCoverage?: string[];
  preconditions: string[];
  expectedResolution: Record<string, unknown>;
  executionSteps: string[];
  verificationRules: string[];
  cleanupRules: string[];
  recoveryRules: string[];
  hardStopRules: string[];
  performanceTargets: {
    approvalVisibleP50Ms?: number;
    approvalVisibleP95Ms?: number;
    totalMs?: number;
  };
  testMode: ScenarioTestMode;
  realWorldExecutionAllowed: boolean;
  expectedOutcome: string;
  passCriteria: ScenarioStageRequirements;
  supportedExecutionModes: ScenarioExecutionMode[];
  contextVariants: string[];
}

export interface ScenarioRunTelemetry {
  intent_resolution_ms: number;
  target_resolution_ms: number;
  route_resolution_ms: number;
  approval_surface_ms: number;
  execution_start_ms: number;
  navigation_ms: number;
  action_ms: number;
  verification_ms: number;
  cleanup_ms: number;
  total_ms: number;
}

export interface ScenarioRunResult {
  scenarioId: string;
  runId: string;
  startedAt: string;
  completedAt: string | null;
  intentResolved: boolean;
  targetResolved: boolean;
  approvalRequired: boolean;
  approvalGranted: boolean;
  executionStarted: boolean;
  executionDispatched: boolean;
  outcomeObserved: boolean;
  outcomeVerified: boolean;
  cleanupStarted: boolean;
  cleanupVerified: boolean;
  contextRestored: boolean;
  status: ScenarioStatus;
  failureCode: string | null;
  evidence: ScenarioEvidenceRef[];
  telemetry: ScenarioRunTelemetry;
  mode: ScenarioTestMode;
  executionMode: ScenarioExecutionMode;
  commandId?: string;
  executionId?: string;
  approvalId?: string;
  deviceId?: string;
}

export interface ScenarioRunContext {
  mode: ScenarioTestMode;
  executionMode?: ScenarioExecutionMode;
  runId?: string;
  approvalGranted?: boolean;
  availablePreconditions?: string[];
  simulate?: Partial<ScenarioStageRequirements> & {
    targetAmbiguous?: boolean;
    payloadMismatch?: boolean;
    wrongProvider?: boolean;
    wrongConversation?: boolean;
    unexpectedTerms?: boolean;
    duplicateConsequentialRisk?: boolean;
    authorityMismatch?: boolean;
    networkInterruption?: boolean;
    deviceReconnect?: boolean;
    runtimeRestart?: boolean;
  };
  deviceId?: string;
}
