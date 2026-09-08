// NAgex Trust & Safety Layer — PreExecutionSafetyGate (TS-4)
// Directive: docs/NAgex_Trust_and_Safety_Layer_Development_Directive_20260908.md

import { SafetyEngine } from './safety.engine.js';
import { ActionSafetyContext, SafetyDecision } from './safety.types.js';

export class PreExecutionSafetyGate {
  private static instance: PreExecutionSafetyGate;
  private engine: SafetyEngine;

  constructor(engine?: SafetyEngine) {
    this.engine = engine || SafetyEngine.getInstance();
  }

  public static getInstance(): PreExecutionSafetyGate {
    if (!PreExecutionSafetyGate.instance) {
      PreExecutionSafetyGate.instance = new PreExecutionSafetyGate();
    }
    return PreExecutionSafetyGate.instance;
  }

  /**
   * Pre-execution safety check right before tool/provider execution (TS-4, Directive Section 6).
   * Hard Rule: R3/R4 actions CANNOT be overridden by user approval (Directive Section 17).
   */
  public async evaluateAction(context: ActionSafetyContext): Promise<SafetyDecision> {
    const tenantId = context.tenantId || 'usr_default';
    const userId = context.userId || 'usr_default';
    const intentDecision = context.intentDecision;

    // Hard Override Check: If the intent decision was R3 or R4, user approval CANNOT override it.
    if (intentDecision && (intentDecision.riskLevel === 'R3' || intentDecision.riskLevel === 'R4')) {
      return {
        ...intentDecision,
        decisionId: `sdec_gate_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        executionAllowed: false,
        userFacingExplanation:
          'Execution blocked: Prohibited or Critical safety risk cannot be overridden by approval.',
        reasonCodes: [...intentDecision.reasonCodes, 'PRE_EXECUTION_OVERRIDE_PREVENTED'],
      };
    }

    // Inspect tool payload & arguments directly
    const capabilityId = context.capabilityId || context.actionType || '';
    const toolArgs = context.toolArguments || {};
    const payloadStr = JSON.stringify(toolArgs);
    const recipient = context.targetRecipient || toolArgs.to || toolArgs.recipient || '';

    // Action-specific Safety Checks:
    // 1. Phishing / Credential Harvesting payload via Gmail or Messaging capability
    if (
      (capabilityId.includes('email') || capabilityId.includes('gmail') || capabilityId.includes('message')) &&
      (/\b(login verify|password update required|credential steal|fake auth link)\b/i.test(payloadStr) ||
        /\b(phish)\b/i.test(payloadStr))
    ) {
      return {
        decisionId: `sdec_gate_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        tenantId,
        userId,
        riskLevel: 'R3',
        categories: ['CYBER_ABUSE', 'DECEPTIVE_FRAUD' as any],
        responseMode: 'REFUSE',
        responseAllowed: false,
        planningAllowed: false,
        executionAllowed: false,
        requiresActionApproval: true,
        requiresHumanReview: true,
        enforcementRecommendation: 'WARN',
        reasonCodes: ['PRE_EXECUTION_PHISHING_PAYLOAD_BLOCKED'],
        userFacingExplanation: 'Execution blocked: Phishing or credential harvesting payload detected.',
        policyVersion: intentDecision?.policyVersion || 'NAGEX_TS_POLICY_V1',
        classifierVersion: intentDecision?.classifierVersion || 'NAGEX_RULE_CLASSIFIER_V1',
        createdAt: new Date().toISOString(),
      };
    }

    // 2. Destructive Malicious Intrusion or System Command Injection
    if (
      capabilityId.includes('browser') ||
      capabilityId.includes('exec') ||
      capabilityId.includes('terminal')
    ) {
      if (/(rm -rf \/|format c:|curl .* \| bash|wget .* \| sh|chmod 777 \/etc)/i.test(payloadStr)) {
        return {
          decisionId: `sdec_gate_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          tenantId,
          userId,
          riskLevel: 'R3',
          categories: ['CYBER_ABUSE'],
          responseMode: 'REFUSE',
          responseAllowed: false,
          planningAllowed: false,
          executionAllowed: false,
          requiresActionApproval: true,
          requiresHumanReview: true,
          enforcementRecommendation: 'WARN',
          reasonCodes: ['PRE_EXECUTION_DESTRUCTIVE_COMMAND_BLOCKED'],
          userFacingExplanation: 'Execution blocked: Destructive system command execution prohibited.',
          policyVersion: intentDecision?.policyVersion || 'NAGEX_TS_POLICY_V1',
          classifierVersion: intentDecision?.classifierVersion || 'NAGEX_RULE_CLASSIFIER_V1',
          createdAt: new Date().toISOString(),
        };
      }
    }

    // If intent decision exists and was R2 (Restricted), enforce strict approval gate
    if (intentDecision && intentDecision.riskLevel === 'R2') {
      return {
        ...intentDecision,
        decisionId: `sdec_gate_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        executionAllowed: true, // Allowed subject to human approval
        requiresActionApproval: true,
      };
    }

    // Default: Action evaluation passes
    return (
      intentDecision || {
        decisionId: `sdec_gate_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        tenantId,
        userId,
        riskLevel: 'R0',
        categories: [],
        responseMode: 'NORMAL',
        responseAllowed: true,
        planningAllowed: true,
        executionAllowed: true,
        requiresActionApproval: false,
        requiresHumanReview: false,
        enforcementRecommendation: 'NONE',
        reasonCodes: ['PRE_EXECUTION_SAFETY_PASS'],
        userFacingExplanation: 'Action cleared for execution.',
        policyVersion: 'NAGEX_TS_POLICY_V1',
        classifierVersion: 'NAGEX_RULE_CLASSIFIER_V1',
        createdAt: new Date().toISOString(),
      }
    );
  }
}
