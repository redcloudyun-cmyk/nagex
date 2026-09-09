import { SafetyDecision } from '../governance/safety.types.js';

export type CapabilityRisk =
  | 'READ_ONLY'
  | 'LOW'
  | 'CONSEQUENTIAL'
  | 'RESTRICTED'
  | 'DYNAMIC';

export type CapabilityApprovalMode =
  | 'NONE'
  | 'CONDITIONAL'
  | 'REQUIRED';

export interface CapabilityDefinition {
  id: string;
  provider: 'GOOGLE_CALENDAR' | 'GMAIL' | 'BROWSER';
  risk: CapabilityRisk;
  approval: CapabilityApprovalMode;
  enabled: boolean;
}

export interface CapabilityRequest {
  capabilityId: string;
  tenantId: string;
  principalId: string;
  requestId: string;
  payload: unknown;
  source: 'WEB' | 'QUICK_WAKE' | 'TELEGRAM' | 'SLACK' | 'TASK' | 'SYSTEM';
  sessionId?: string;
  safetyDecision?: SafetyDecision;
  idempotencyKey?: string;
}

export type CapabilityBrokerResult =
  | { status: 'EXECUTED'; capabilityId: string; result: unknown }
  | { status: 'APPROVAL_REQUIRED'; capabilityId: string; approval: unknown }
  | { status: 'BLOCKED'; capabilityId: string; reasonCode: string };

export type CapabilityErrorCode =
  | 'CAPABILITY_NOT_FOUND'
  | 'CAPABILITY_DISABLED'
  | 'CAPABILITY_BLOCKED_BY_SAFETY'
  | 'CAPABILITY_SAFETY_APPROVAL_REQUIRED'
  | 'CAPABILITY_POLICY_FAILED'
  | 'CAPABILITY_PROVIDER_UNAVAILABLE'
  | 'CAPABILITY_PAYLOAD_INVALID'
  | 'CAPABILITY_IDEMPOTENCY_CONFLICT';
