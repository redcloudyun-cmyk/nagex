import type { CommandContext, PolicyEvidence } from './behavioral-rules.types.js';
import type { ScenarioDefinition } from './scenario.types.js';

export function normalizeScenarioCommandContext(scenario: ScenarioDefinition): CommandContext {
  return {
    userIntent: scenario.userIntent,
    inputModalities: scenario.inputModalities && scenario.inputModalities.length ? scenario.inputModalities : ['TEXT'],
    originDevice: scenario.originDevice || 'DESKTOP',
    originSurface: scenario.originSurface || 'NAGEX_HOME',
    executionDevice: scenario.connectedDevices?.[0] || scenario.originDevice || 'DESKTOP',
    backgroundEligible: scenario.supportedExecutionModes.some((mode) => mode.startsWith('BACKGROUND')),
    proactive: scenario.category === 'BACKGROUND' || scenario.category === 'CONDITION_WATCH',
  };
}

export function evidenceFromScenarioPassCriteria(scenario: ScenarioDefinition): PolicyEvidence {
  return {
    targetVerified: scenario.passCriteria.targetResolved !== false,
    payloadVerified: true,
    outcomeObserved: scenario.passCriteria.outcomeObserved !== false,
    outcomeVerified: scenario.passCriteria.outcomeVerified !== false,
    approvalGranted: scenario.approvalPolicy === 'NONE',
    cleanupVerified: scenario.passCriteria.cleanupVerified !== false,
    currentStateObserved: true,
  };
}
