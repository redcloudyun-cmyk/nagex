import type { CapabilityApprovalMode, CapabilityDefinition, CapabilityRequest } from '../../capabilities/capability.types.js';

export type PermissionDisposition = 'ALLOW' | 'REQUIRE_APPROVAL' | 'BLOCK';

export interface PermissionDecision {
  disposition: PermissionDisposition;
  reasonCodes: string[];
  policyVersion: string;
  effectiveApproval: CapabilityApprovalMode;
}

export interface PermissionEvaluationInput {
  request: CapabilityRequest;
  definition: CapabilityDefinition | undefined;
  providerAvailable: boolean;
}
