// NAgex Trust & Safety Layer — Core Types & Taxonomy (TS-1)
// Directive: docs/NAgex_Trust_and_Safety_Layer_Development_Directive_20260908.md

export type SafetyRiskLevel = 'R0' | 'R1' | 'R2' | 'R3' | 'R4';

// R0: NORMAL — Normal lawful use
// R1: SENSITIVE — Sensitive/controversial subject without harmful intent
// R2: RESTRICTED — Misuse potential or elevated harm risk
// R3: PROHIBITED — Serious wrongdoing, targeted harm, criminal facilitation
// R4: CRITICAL — Credible indication of imminent serious physical harm

export type SafetyResponseMode =
  | 'NORMAL'
  | 'LIMITED'
  | 'SAFE_COMPLETION'
  | 'REFUSE'
  | 'CRISIS';

export type SafetyCategory =
  | 'VIOLENCE_PHYSICAL_HARM'
  | 'CRIMINAL_FACILITATION'
  | 'CYBER_ABUSE'
  | 'HATE_HARASSMENT'
  | 'SEXUAL_EXPLOITATION_MINORS'
  | 'PRIVACY_STALKING'
  | 'SELF_HARM_CRISIS'
  | 'HIGH_RISK_DECISION';

export type EnforcementLevel =
  | 'NONE'
  | 'WARN'
  | 'RESTRICT_CAPABILITY'
  | 'TEMPORARY_SUSPENSION_REVIEW'
  | 'ACCOUNT_REVIEW';

export interface SafetyDecision {
  decisionId: string;
  tenantId: string;
  userId: string;
  riskLevel: SafetyRiskLevel;
  categories: SafetyCategory[];
  responseMode: SafetyResponseMode;
  responseAllowed: boolean;
  planningAllowed: boolean;
  executionAllowed: boolean;
  requiresActionApproval: boolean;
  requiresHumanReview: boolean;
  enforcementRecommendation?: EnforcementLevel;
  reasonCodes: string[];
  userFacingExplanation: string;
  policyVersion: string;
  classifierVersion: string;
  createdAt: string;
}

export interface SafetyContext {
  tenantId?: string;
  userId?: string;
  input: string;
  domain?: string;
  sourceType?: 'TEXT' | 'URL' | 'PDF' | 'VOICE' | 'IMAGE' | 'TASK';
  metadata?: Record<string, any>;
}

export interface ActionSafetyContext {
  intentDecision?: SafetyDecision;
  capabilityId?: string;
  actionType?: string;
  toolArguments?: Record<string, any>;
  targetRecipient?: string;
  tenantId?: string;
  userId?: string;
}

export interface SafetyEvent {
  eventId: string;
  tenantId: string;
  userId: string;
  decisionId: string;
  eventType:
    | 'safety.intent.evaluated'
    | 'safety.action.evaluated'
    | 'safety.action.blocked'
    | 'safety.safe_completion'
    | 'safety.human_review.requested'
    | 'safety.enforcement.warning'
    | 'safety.enforcement.restricted'
    | 'safety.high_severity_event.created'
    | 'safety.high_severity_event.reviewed';
  riskLevel: SafetyRiskLevel;
  categories: SafetyCategory[];
  reasonCodes: string[];
  policyVersion: string;
  actionTaken: string;
  userFacingExplanation: string;
  timestamp: string;
  details?: Record<string, any>;
}
