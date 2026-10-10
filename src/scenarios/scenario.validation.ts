import { NagexError } from '../common/errors.js';
import {
  SCENARIO_CATEGORIES,
  SCENARIO_RISK_LEVELS,
  type ScenarioInputModality,
  type ScenarioDefinition,
  type ScenarioExecutionMode,
  type ScenarioOriginDevice,
  type ScenarioTestMode,
} from './scenario.types.js';

const MODES: ReadonlySet<ScenarioTestMode> = new Set(['SIMULATION', 'SANDBOX', 'REAL']);
const EXECUTION_MODES: ReadonlySet<ScenarioExecutionMode> = new Set(['FOREGROUND', 'BACKGROUND', 'BACKGROUND_WITH_FOREGROUND_APP_ACTIVATION']);
const INPUT_MODALITIES: ReadonlySet<ScenarioInputModality> = new Set(['TEXT', 'VOICE', 'IMAGE', 'VIDEO', 'SCREEN', 'FILE', 'SHARE', 'CLIPBOARD', 'EMAIL_EVENT', 'CALENDAR_EVENT', 'SYSTEM_EVENT', 'MULTIMODAL']);
const ORIGIN_DEVICES: ReadonlySet<ScenarioOriginDevice> = new Set(['DESKTOP', 'MOBILE', 'WEB', 'ANDROID', 'IOS', 'SYSTEM']);

export function assertScenarioDefinition(value: unknown, requestId = 'scenario_validate'): ScenarioDefinition {
  if (!value || typeof value !== 'object') {
    throw new NagexError({ code: 'SCENARIO_INVALID_SCHEMA', category: 'VALIDATION', message: 'Scenario definition must be an object.', request_id: requestId });
  }
  const v = value as Record<string, unknown>;
  const requiredStrings = ['scenarioId', 'version', 'title', 'category', 'riskLevel', 'userIntent', 'approvalPolicy', 'testMode', 'expectedOutcome'];
  for (const key of requiredStrings) {
    if (typeof v[key] !== 'string' || !String(v[key]).trim()) {
      throw new NagexError({ code: 'SCENARIO_INVALID_SCHEMA', category: 'VALIDATION', message: `Scenario field ${key} is required.`, request_id: requestId });
    }
  }
  if (!SCENARIO_CATEGORIES.includes(v.category as ScenarioDefinition['category'])) {
    throw new NagexError({ code: 'SCENARIO_INVALID_CATEGORY', category: 'VALIDATION', message: `Unsupported scenario category ${String(v.category)}.`, request_id: requestId });
  }
  if (!SCENARIO_RISK_LEVELS.includes(v.riskLevel as ScenarioDefinition['riskLevel'])) {
    throw new NagexError({ code: 'SCENARIO_INVALID_RISK', category: 'VALIDATION', message: `Unsupported scenario risk ${String(v.riskLevel)}.`, request_id: requestId });
  }
  if (!['NONE', 'IF_RISK_REQUIRES', 'ALWAYS'].includes(String(v.approvalPolicy))) {
    throw new NagexError({ code: 'SCENARIO_INVALID_APPROVAL_POLICY', category: 'VALIDATION', message: 'Scenario approvalPolicy is invalid.', request_id: requestId });
  }
  if (!MODES.has(v.testMode as ScenarioTestMode)) {
    throw new NagexError({ code: 'SCENARIO_INVALID_TEST_MODE', category: 'VALIDATION', message: 'Scenario testMode is invalid.', request_id: requestId });
  }
  if (v.modes !== undefined && (!Array.isArray(v.modes) || !(v.modes as unknown[]).every((mode) => MODES.has(mode as ScenarioTestMode)))) {
    throw new NagexError({ code: 'SCENARIO_INVALID_TEST_MODE', category: 'VALIDATION', message: 'Scenario modes contains an invalid mode.', request_id: requestId });
  }
  if (v.inputModalities !== undefined && (!Array.isArray(v.inputModalities) || !(v.inputModalities as unknown[]).every((mode) => INPUT_MODALITIES.has(mode as ScenarioInputModality)))) {
    throw new NagexError({ code: 'SCENARIO_INVALID_INPUT_MODALITY', category: 'VALIDATION', message: 'inputModalities contains an invalid modality.', request_id: requestId });
  }
  if (v.originDevice !== undefined && !ORIGIN_DEVICES.has(v.originDevice as ScenarioOriginDevice)) {
    throw new NagexError({ code: 'SCENARIO_INVALID_ORIGIN_DEVICE', category: 'VALIDATION', message: 'originDevice is invalid.', request_id: requestId });
  }
  if (typeof v.realWorldExecutionAllowed !== 'boolean') {
    throw new NagexError({ code: 'SCENARIO_INVALID_REAL_POLICY', category: 'VALIDATION', message: 'realWorldExecutionAllowed must be boolean.', request_id: requestId });
  }
  for (const key of ['requiredCapabilities', 'preferredRoutes', 'preconditions', 'executionSteps', 'verificationRules', 'cleanupRules', 'recoveryRules', 'hardStopRules', 'contextVariants']) {
    if (!Array.isArray(v[key]) || !(v[key] as unknown[]).every((item) => typeof item === 'string')) {
      throw new NagexError({ code: 'SCENARIO_INVALID_SCHEMA', category: 'VALIDATION', message: `Scenario field ${key} must be a string array.`, request_id: requestId });
    }
  }
  for (const key of ['availableMemory', 'connectedDevices', 'recoveryCases', 'hardStopCases', 'ruleCoverage']) {
    if (v[key] !== undefined && (!Array.isArray(v[key]) || !(v[key] as unknown[]).every((item) => typeof item === 'string'))) {
      throw new NagexError({ code: 'SCENARIO_INVALID_SCHEMA', category: 'VALIDATION', message: `Scenario field ${key} must be a string array when present.`, request_id: requestId });
    }
  }
  if (!Array.isArray(v.supportedExecutionModes) || !(v.supportedExecutionModes as unknown[]).every((mode) => EXECUTION_MODES.has(mode as ScenarioExecutionMode))) {
    throw new NagexError({ code: 'SCENARIO_INVALID_EXECUTION_MODE', category: 'VALIDATION', message: 'supportedExecutionModes contains an invalid mode.', request_id: requestId });
  }
  if (!v.initialContext || typeof v.initialContext !== 'object' || !v.expectedResolution || typeof v.expectedResolution !== 'object') {
    throw new NagexError({ code: 'SCENARIO_INVALID_SCHEMA', category: 'VALIDATION', message: 'initialContext and expectedResolution must be objects.', request_id: requestId });
  }
  if (!v.performanceTargets || typeof v.performanceTargets !== 'object') {
    throw new NagexError({ code: 'SCENARIO_INVALID_SCHEMA', category: 'VALIDATION', message: 'performanceTargets must be an object.', request_id: requestId });
  }
  if (!v.passCriteria || typeof v.passCriteria !== 'object') {
    throw new NagexError({ code: 'SCENARIO_INVALID_PASS_CRITERIA', category: 'VALIDATION', message: 'passCriteria must be an object.', request_id: requestId });
  }
  return v as unknown as ScenarioDefinition;
}
