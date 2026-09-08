// NAgex Trust & Safety Layer — SafetyEngine (TS-2, TS-3)
// Directive: docs/NAgex_Trust_and_Safety_Layer_Development_Directive_20260908.md

import {
  SafetyCategory,
  SafetyContext,
  SafetyDecision,
  SafetyRiskLevel,
} from './safety.types.js';

export const POLICY_VERSION = 'NAGEX_TS_POLICY_V1';
export const CLASSIFIER_VERSION = 'NAGEX_RULE_CLASSIFIER_V1';

export class SafetyEngine {
  private static instance: SafetyEngine;

  public static getInstance(): SafetyEngine {
    if (!SafetyEngine.instance) {
      SafetyEngine.instance = new SafetyEngine();
    }
    return SafetyEngine.instance;
  }

  /**
   * Evaluate user intent / input context for safety risks (TS-2, TS-3).
   * Dual-use awareness: Distinguishes discussion/academic/defense/fiction from actionable harm.
   * Fail-closed: Returns R3 / executionBlocked if safety analysis fails.
   */
  public async evaluateIntent(context: SafetyContext): Promise<SafetyDecision> {
    const decisionId = `sdec_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const now = new Date().toISOString();
    const tenantId = context?.tenantId || 'usr_default';
    const userId = context?.userId || 'usr_default';

    try {
      if (!context || typeof context !== 'object') {
        throw new Error('SAFETY_CONTEXT_INVALID');
      }
      const input = (context.input || '').trim();
      if (!input) {
        return this.createDecision({
          decisionId,
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
          reasonCodes: ['EMPTY_INPUT'],
          userFacingExplanation: 'Normal processing allowed.',
          now,
        });
      }

      // Check benign contextual indicators (Research, Defense, Education, History, Fiction)
      const isBenignContext = this.detectBenignContext(input);

      // Check R4 Critical Indicators (Imminent serious physical harm with target, plan, means)
      const r4Check = this.evaluateR4Critical(input);
      if (r4Check.isMatch) {
        return this.createDecision({
          decisionId,
          tenantId,
          userId,
          riskLevel: 'R4',
          categories: ['VIOLENCE_PHYSICAL_HARM', 'SELF_HARM_CRISIS'],
          responseMode: 'CRISIS',
          responseAllowed: false,
          planningAllowed: false,
          executionAllowed: false,
          requiresActionApproval: true,
          requiresHumanReview: true,
          enforcementRecommendation: 'ACCOUNT_REVIEW',
          reasonCodes: r4Check.reasons,
          userFacingExplanation:
            'This request involves imminent physical safety risk and cannot be processed.',
          now,
        });
      }

      // Check R3 Prohibited Indicators (Operational serious wrongdoing, targeted harm, criminal facilitation)
      const r3Check = this.evaluateR3Prohibited(input, isBenignContext);
      if (r3Check.isMatch) {
        return this.createDecision({
          decisionId,
          tenantId,
          userId,
          riskLevel: 'R3',
          categories: r3Check.categories,
          responseMode: 'REFUSE',
          responseAllowed: false,
          planningAllowed: false,
          executionAllowed: false,
          requiresActionApproval: true,
          requiresHumanReview: true,
          enforcementRecommendation: 'WARN',
          reasonCodes: r3Check.reasons,
          userFacingExplanation:
            "I can't help carry out that action as it involves prohibited operational harm.",
          now,
        });
      }

      // Check R2 Restricted Indicators (Elevated harm/misuse risk, risky automated financial/legal decisions)
      const r2Check = this.evaluateR2Restricted(input, isBenignContext);
      if (r2Check.isMatch) {
        return this.createDecision({
          decisionId,
          tenantId,
          userId,
          riskLevel: 'R2',
          categories: r2Check.categories,
          responseMode: 'SAFE_COMPLETION',
          responseAllowed: true,
          planningAllowed: true,
          executionAllowed: false, // Requires explicit policy review before execution
          requiresActionApproval: true,
          requiresHumanReview: false,
          reasonCodes: r2Check.reasons,
          userFacingExplanation:
            'This request involves restricted capability and requires heightened safety oversight.',
          now,
        });
      }

      // Check R1 Sensitive Indicators (Controversial / sensitive topics without harmful intent)
      const r1Check = this.evaluateR1Sensitive(input);
      if (r1Check.isMatch) {
        return this.createDecision({
          decisionId,
          tenantId,
          userId,
          riskLevel: 'R1',
          categories: r1Check.categories,
          responseMode: 'LIMITED',
          responseAllowed: true,
          planningAllowed: true,
          executionAllowed: true,
          requiresActionApproval: true,
          requiresHumanReview: false,
          reasonCodes: r1Check.reasons,
          userFacingExplanation:
            'Sensitive subject matter detected; processing with contextual care.',
          now,
        });
      }

      // Default: R0 Normal
      return this.createDecision({
        decisionId,
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
        reasonCodes: ['PASS_R0_NORMAL'],
        userFacingExplanation: 'Normal processing allowed.',
        now,
      });
    } catch (err: any) {
      // Fail-closed rule (Directive Section 12): If safety engine encounters error/outage, fail closed.
      return this.createDecision({
        decisionId,
        tenantId,
        userId,
        riskLevel: 'R3',
        categories: [],
        responseMode: 'REFUSE',
        responseAllowed: false,
        planningAllowed: false,
        executionAllowed: false,
        requiresActionApproval: true,
        requiresHumanReview: true,
        reasonCodes: ['SAFETY_ENGINE_FAIL_CLOSED', err?.message || 'UNKNOWN_ERROR'],
        userFacingExplanation:
          'Safety subsystem unavailable. Consequential action blocked for security.',
        now,
      });
    }
  }

  /**
   * Distinguish research, defense, history, education, journalism, or fiction from malicious operational intent.
   */
  private detectBenignContext(input: string): boolean {
    const benignPatterns = [
      /\b(history of|academic|research|analysis|defensive|defense|penetration test|detection|journalism|article|fiction|novel|study|educational|explanation of)\b/i,
      /\b(how does .* work|what is the concept of|understand the theory|prevent|protect against)\b/i,
    ];
    return benignPatterns.some((pattern) => pattern.test(input));
  }

  /**
   * Evaluate R4 Critical (Imminent physical harm with high specificity).
   */
  private evaluateR4Critical(input: string): { isMatch: boolean; reasons: string[] } {
    const r4Patterns = [
      /\b(plan to (kill|attack|detonate|bomb) (someone|people|target) at [0-9]{1,2}(am|pm)?)\b/i,
      /\b(imminent physical attack|acquired weapons to assault|bomb threat at)\b/i,
    ];

    const match = r4Patterns.some((pattern) => pattern.test(input));
    return {
      isMatch: match,
      reasons: match ? ['R4_IMMINENT_PHYSICAL_HARM'] : [],
    };
  }

  /**
   * Evaluate R3 Prohibited (Operational wrongdoing, targeted threats, phishing, malware deployment, harassment).
   */
  private evaluateR3Prohibited(
    input: string,
    isBenignContext: boolean
  ): { isMatch: boolean; categories: SafetyCategory[]; reasons: string[] } {
    const categories: SafetyCategory[] = [];
    const reasons: string[] = [];

    // Phishing / Credential theft operational action
    if (
      /\b(send|deploy|distribute) (phishing|credential stealing|fake login|malware)\b/i.test(input) ||
      (/\b(steal credentials|harvest passwords|phish)\b/i.test(input) && !isBenignContext)
    ) {
      categories.push('CYBER_ABUSE', 'DECEPTIVE_FRAUD' as any);
      reasons.push('R3_CYBER_ATTACK_PHISHING');
    }

    // Targeted violent threats / extortion
    if (
      /\b(targeted threat|extort|send death threat|harass target|doxx user)\b/i.test(input) &&
      !isBenignContext
    ) {
      categories.push('VIOLENCE_PHYSICAL_HARM', 'HATE_HARASSMENT');
      reasons.push('R3_TARGETED_HARASSMENT_THREAT');
    }

    // Minor exploitation / CSAM
    if (/\b(csam|minor exploitation|child sexual abuse)\b/i.test(input)) {
      categories.push('SEXUAL_EXPLOITATION_MINORS');
      reasons.push('R3_CSAM_EXPLOITATION');
    }

    // Weapons manufacturing operational guide
    if (/\b(manufacture explosive|make improvised bomb|create nerve agent)\b/i.test(input) && !isBenignContext) {
      categories.push('VIOLENCE_PHYSICAL_HARM');
      reasons.push('R3_WEAPONIZATION_HARMFUL');
    }

    return {
      isMatch: categories.length > 0,
      categories,
      reasons,
    };
  }

  /**
   * Evaluate R2 Restricted (Dual-use technical risk, sensitive privacy profiling, risky automated legal/financial decisions).
   */
  private evaluateR2Restricted(
    input: string,
    isBenignContext: boolean
  ): { isMatch: boolean; categories: SafetyCategory[]; reasons: string[] } {
    const categories: SafetyCategory[] = [];
    const reasons: string[] = [];

    if (/\b(lookup personal private SSN|scan private identity profile|invasive tracking)\b/i.test(input)) {
      categories.push('PRIVACY_STALKING');
      reasons.push('R2_PRIVACY_INVASION');
    }

    if (/\b(autonomously approve loan|terminate employment automatically|deny medical coverage)\b/i.test(input)) {
      categories.push('HIGH_RISK_DECISION');
      reasons.push('R2_HIGH_RISK_DECISION');
    }

    return {
      isMatch: categories.length > 0,
      categories,
      reasons,
    };
  }

  /**
   * Evaluate R1 Sensitive (Sensitive topics discussed safely).
   */
  private evaluateR1Sensitive(input: string): { isMatch: boolean; categories: SafetyCategory[]; reasons: string[] } {
    const categories: SafetyCategory[] = [];
    const reasons: string[] = [];

    if (/\b(racism|hate speech analysis|political controversy|self-harm prevention|cybersecurity concept)\b/i.test(input)) {
      categories.push('HATE_HARASSMENT');
      reasons.push('R1_SENSITIVE_TOPIC_DISCUSSION');
    }

    return {
      isMatch: categories.length > 0,
      categories,
      reasons,
    };
  }

  private createDecision(opts: {
    decisionId: string;
    tenantId: string;
    userId: string;
    riskLevel: SafetyRiskLevel;
    categories: SafetyCategory[];
    responseMode: any;
    responseAllowed: boolean;
    planningAllowed: boolean;
    executionAllowed: boolean;
    requiresActionApproval: boolean;
    requiresHumanReview: boolean;
    enforcementRecommendation?: any;
    reasonCodes: string[];
    userFacingExplanation: string;
    now: string;
  }): SafetyDecision {
    return {
      decisionId: opts.decisionId,
      tenantId: opts.tenantId,
      userId: opts.userId,
      riskLevel: opts.riskLevel,
      categories: opts.categories,
      responseMode: opts.responseMode,
      responseAllowed: opts.responseAllowed,
      planningAllowed: opts.planningAllowed,
      executionAllowed: opts.executionAllowed,
      requiresActionApproval: opts.requiresActionApproval,
      requiresHumanReview: opts.requiresHumanReview,
      enforcementRecommendation: opts.enforcementRecommendation || 'NONE',
      reasonCodes: opts.reasonCodes,
      userFacingExplanation: opts.userFacingExplanation,
      policyVersion: POLICY_VERSION,
      classifierVersion: CLASSIFIER_VERSION,
      createdAt: opts.now,
    };
  }
}
