import { generateResourceId, getCurrentISOString } from '../common/utils.js';
import { NagexError } from '../common/errors.js';
import { evaluateScenarioRiskPolicy } from './scenario-risk-policy.js';
import type {
  ScenarioDefinition,
  ScenarioEvidenceRef,
  ScenarioExecutionMode,
  ScenarioRunContext,
  ScenarioRunResult,
  ScenarioRunTelemetry,
  ScenarioStageRequirements,
  ScenarioStatus,
} from './scenario.types.js';
import { assertScenarioDefinition } from './scenario.validation.js';

const ZERO_TELEMETRY: ScenarioRunTelemetry = {
  intent_resolution_ms: 0,
  target_resolution_ms: 0,
  route_resolution_ms: 0,
  approval_surface_ms: 0,
  execution_start_ms: 0,
  navigation_ms: 0,
  action_ms: 0,
  verification_ms: 0,
  cleanup_ms: 0,
  total_ms: 0,
};

export interface ScenarioRunnerOptions {
  now?: () => number;
  nowIso?: () => string;
}

export class ScenarioRunner {
  private readonly runs = new Map<string, ScenarioRunResult>();
  private readonly now: () => number;
  private readonly nowIso: () => string;

  constructor(options: ScenarioRunnerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.nowIso = options.nowIso ?? getCurrentISOString;
  }

  public getRun(runId: string): ScenarioRunResult | undefined {
    return this.runs.get(runId);
  }

  public async run(definition: ScenarioDefinition, context: ScenarioRunContext): Promise<ScenarioRunResult> {
    const scenario = assertScenarioDefinition(definition, `scenario_${definition?.scenarioId || 'unknown'}`);
    const startMs = this.now();
    const existing = context.runId ? this.runs.get(context.runId) : undefined;
    const run = existing ?? this.createRun(scenario, context);
    this.runs.set(run.runId, run);

    if (context.mode === 'REAL' && !scenario.realWorldExecutionAllowed) {
      return this.finish(run, 'SKIPPED', 'REAL_EXECUTION_NOT_ALLOWED', startMs);
    }
    if (context.executionMode && !scenario.supportedExecutionModes.includes(context.executionMode)) {
      return this.finish(run, 'SKIPPED', 'EXECUTION_MODE_UNSUPPORTED', startMs);
    }

    const hardStop = this.detectHardStop(context);
    if (hardStop) return this.finish(run, 'FAIL', hardStop, startMs);

    const missingPreconditions = scenario.preconditions.filter((p) => !(context.availablePreconditions ?? []).includes(p));
    if (missingPreconditions.length > 0) {
      run.failureCode = `MISSING_PRECONDITION:${missingPreconditions.join(',')}`;
      run.status = 'WAITING_FOR_PRECONDITION';
      run.telemetry.total_ms = this.elapsed(startMs);
      return run;
    }

    const risk = evaluateScenarioRiskPolicy(scenario);
    run.approvalRequired = risk.approvalRequired;
    run.intentResolved = true;
    run.targetResolved = true;
    run.telemetry.intent_resolution_ms = 1;
    run.telemetry.target_resolution_ms = 1;
    run.telemetry.route_resolution_ms = 1;
    this.addEvidence(run, 'SIMULATION_TRACE', 'Intent, target, and route resolved against scenario definition.', context);

    if (risk.approvalRequired && !context.approvalGranted) {
      run.telemetry.approval_surface_ms = 1;
      run.approvalId = run.approvalId ?? generateResourceId('apr');
      this.addEvidence(run, 'API_RESPONSE', 'Approval surface prepared; waiting for human approval.', { ...context, approvalGranted: false });
      run.status = 'BLOCKED_USER_INTERACTION';
      run.failureCode = 'APPROVAL_REQUIRED';
      run.telemetry.total_ms = this.elapsed(startMs);
      return run;
    }

    if (risk.approvalRequired) {
      run.telemetry.approval_surface_ms = 1;
      run.approvalId = run.approvalId ?? generateResourceId('apr');
      this.addEvidence(run, 'API_RESPONSE', 'Human approval granted and bound to this scenario run.', context);
    }

    run.approvalGranted = risk.approvalRequired ? true : context.approvalGranted === true;
    run.executionStarted = true;
    run.executionDispatched = true;
    run.commandId = run.commandId ?? generateResourceId('cmd');
    run.executionId = run.executionId ?? generateResourceId('exe');
    run.deviceId = context.deviceId;
    run.telemetry.execution_start_ms = 1;
    run.telemetry.navigation_ms = context.executionMode === 'BACKGROUND' ? 0 : 1;
    run.telemetry.action_ms = 1;
    this.addEvidence(run, this.primaryEvidenceType(scenario), 'Execution attempt completed in declared test mode.', context);

    const simulated = context.simulate ?? {};
    const expected = this.mergeExpected(scenario.passCriteria, simulated);
    run.outcomeObserved = expected.outcomeObserved === true;
    run.outcomeVerified = expected.outcomeVerified === true;
    run.telemetry.verification_ms = 1;
    if (run.outcomeObserved) this.addEvidence(run, 'SIMULATION_TRACE', 'Outcome observation recorded.', context);
    if (run.outcomeVerified) this.addEvidence(run, this.verificationEvidenceType(scenario), 'Verified outcome evidence recorded.', context);

    run.cleanupStarted = risk.cleanupRequired;
    run.cleanupVerified = expected.cleanupVerified === true || !risk.cleanupRequired;
    run.contextRestored = expected.contextRestored === true || !risk.cleanupRequired;
    run.telemetry.cleanup_ms = risk.cleanupRequired ? 1 : 0;
    if (run.cleanupVerified) this.addEvidence(run, 'SIMULATION_TRACE', 'Cleanup and context restore verified.', context);

    const missing = this.missingPassCriteria(scenario.passCriteria, run);
    if (missing.length > 0) {
      const status: ScenarioStatus = missing.includes('outcomeVerified') ? 'OUTCOME_UNVERIFIED' : 'FAIL';
      return this.finish(run, status, `MISSING_PASS_CRITERIA:${missing.join(',')}`, startMs);
    }
    return this.finish(run, 'PASS', null, startMs);
  }

  private createRun(scenario: ScenarioDefinition, context: ScenarioRunContext): ScenarioRunResult {
    return {
      scenarioId: scenario.scenarioId,
      runId: generateResourceId('sct'),
      startedAt: this.nowIso(),
      completedAt: null,
      intentResolved: false,
      targetResolved: false,
      approvalRequired: false,
      approvalGranted: false,
      executionStarted: false,
      executionDispatched: false,
      outcomeObserved: false,
      outcomeVerified: false,
      cleanupStarted: false,
      cleanupVerified: false,
      contextRestored: false,
      status: 'WAITING_FOR_PRECONDITION',
      failureCode: null,
      evidence: [],
      telemetry: { ...ZERO_TELEMETRY },
      mode: context.mode,
      executionMode: context.executionMode ?? 'FOREGROUND',
      deviceId: context.deviceId,
    };
  }

  private detectHardStop(context: ScenarioRunContext): string | null {
    const simulate = context.simulate ?? {};
    if (simulate.targetAmbiguous) return 'TARGET_AMBIGUITY';
    if (simulate.payloadMismatch) return 'PAYLOAD_MISMATCH';
    if (simulate.wrongProvider) return 'WRONG_PROVIDER';
    if (simulate.wrongConversation) return 'WRONG_CONVERSATION';
    if (simulate.unexpectedTerms) return 'UNEXPECTED_PRICE_OR_TERMS';
    if (simulate.duplicateConsequentialRisk) return 'DUPLICATE_CONSEQUENTIAL_RISK';
    if (simulate.authorityMismatch) return 'SECURITY_AUTHORITY_MISMATCH';
    return null;
  }

  private mergeExpected(required: ScenarioStageRequirements, simulated: ScenarioRunContext['simulate']): ScenarioStageRequirements {
    return {
      intentResolved: true,
      targetResolved: true,
      approvalGranted: true,
      executionStarted: true,
      executionDispatched: true,
      outcomeObserved: required.outcomeObserved !== false,
      outcomeVerified: required.outcomeVerified !== false,
      cleanupVerified: required.cleanupVerified !== false,
      contextRestored: required.contextRestored !== false,
      ...simulated,
    };
  }

  private missingPassCriteria(criteria: ScenarioStageRequirements, run: ScenarioRunResult): string[] {
    const missing: string[] = [];
    const map: Record<keyof ScenarioStageRequirements, boolean> = {
      intentResolved: run.intentResolved,
      targetResolved: run.targetResolved,
      approvalGranted: run.approvalGranted || !run.approvalRequired,
      executionStarted: run.executionStarted,
      executionDispatched: run.executionDispatched,
      outcomeObserved: run.outcomeObserved,
      outcomeVerified: run.outcomeVerified,
      cleanupVerified: run.cleanupVerified,
      contextRestored: run.contextRestored,
    };
    for (const [key, required] of Object.entries(criteria) as [keyof ScenarioStageRequirements, boolean][]) {
      if (required && !map[key]) missing.push(key);
    }
    return missing;
  }

  private primaryEvidenceType(scenario: ScenarioDefinition): ScenarioEvidenceRef['evidenceType'] {
    if (scenario.category === 'MESSAGING') return 'MESSAGE_OUTBOUND';
    if (scenario.category === 'CALENDAR') return 'CALENDAR_EVENT';
    if (scenario.category === 'RESEARCH') return 'BROWSER_EVIDENCE';
    if (scenario.category === 'REPORT' || scenario.category === 'ARTIFACT_CREATION') return 'REPORT_ARTIFACT';
    if (scenario.category === 'RESERVATION') return 'RESERVATION_CONFIRMATION';
    return 'SIMULATION_TRACE';
  }

  private verificationEvidenceType(scenario: ScenarioDefinition): ScenarioEvidenceRef['evidenceType'] {
    if (scenario.category === 'REPORT' || scenario.category === 'ARTIFACT_CREATION') return 'FILE_ARTIFACT';
    return this.primaryEvidenceType(scenario);
  }

  private addEvidence(run: ScenarioRunResult, evidenceType: ScenarioEvidenceRef['evidenceType'], summary: string, context: ScenarioRunContext): void {
    run.evidence.push({
      evidenceId: generateResourceId('bev'),
      scenarioId: run.scenarioId,
      runId: run.runId,
      evidenceType,
      observedAt: this.nowIso(),
      summary,
      redacted: true,
      commandId: run.commandId,
      executionId: run.executionId,
      approvalId: run.approvalId,
      deviceId: context.deviceId ?? run.deviceId,
    });
  }

  private finish(run: ScenarioRunResult, status: ScenarioStatus, failureCode: string | null, startMs: number): ScenarioRunResult {
    run.status = status;
    run.failureCode = failureCode;
    run.completedAt = status === 'WAITING_FOR_PRECONDITION' || status === 'BLOCKED_USER_INTERACTION' ? null : this.nowIso();
    run.telemetry.total_ms = this.elapsed(startMs);
    return run;
  }

  private elapsed(startMs: number): number {
    return Math.max(0, this.now() - startMs);
  }
}
