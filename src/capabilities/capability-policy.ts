import { CapabilityDefinition, CapabilityRequest, CapabilityApprovalMode } from './capability.types.js';

export interface PolicyEvaluationResult {
  allowed: boolean;
  effectiveApproval: CapabilityApprovalMode;
  reasonCode?: string;
  userFacingExplanation?: string;
}

export class CapabilityPolicy {
  public static evaluate(
    request: CapabilityRequest,
    definition: CapabilityDefinition | undefined,
    providerAvailable: boolean = true
  ): PolicyEvaluationResult {
    // 1. capability exists
    if (!definition) {
      return {
        allowed: false,
        effectiveApproval: 'NONE',
        reasonCode: 'CAPABILITY_NOT_FOUND',
        userFacingExplanation: `Capability "${request.capabilityId}" was not found.`,
      };
    }

    // 2. capability enabled
    if (!definition.enabled) {
      return {
        allowed: false,
        effectiveApproval: definition.approval,
        reasonCode: 'CAPABILITY_DISABLED',
        userFacingExplanation: `Capability "${definition.id}" is currently disabled.`,
      };
    }

    // 3. tenantId present
    if (!request.tenantId || typeof request.tenantId !== 'string' || request.tenantId.trim() === '') {
      return {
        allowed: false,
        effectiveApproval: definition.approval,
        reasonCode: 'CAPABILITY_POLICY_FAILED',
        userFacingExplanation: 'Tenant identity is required for capability execution.',
      };
    }

    // 4. principalId present
    if (!request.principalId || typeof request.principalId !== 'string' || request.principalId.trim() === '') {
      return {
        allowed: false,
        effectiveApproval: definition.approval,
        reasonCode: 'CAPABILITY_POLICY_FAILED',
        userFacingExplanation: 'Principal identity is required for capability execution.',
      };
    }

    // 5. requestId present
    if (!request.requestId || typeof request.requestId !== 'string' || request.requestId.trim() === '') {
      return {
        allowed: false,
        effectiveApproval: definition.approval,
        reasonCode: 'CAPABILITY_POLICY_FAILED',
        userFacingExplanation: 'Request ID is required for capability execution.',
      };
    }

    // 6. provider availability
    if (!providerAvailable) {
      return {
        allowed: false,
        effectiveApproval: definition.approval,
        reasonCode: 'CAPABILITY_PROVIDER_UNAVAILABLE',
        userFacingExplanation: `Provider "${definition.provider}" is unavailable.`,
      };
    }

    // 7. request matches registered capability
    if (request.capabilityId !== definition.id) {
      return {
        allowed: false,
        effectiveApproval: definition.approval,
        reasonCode: 'CAPABILITY_POLICY_FAILED',
        userFacingExplanation: 'Requested capability ID does not match registered definition.',
      };
    }

    // 9 & 10. safety decision checks (blocked runtime/session state & safety decision permits execution)
    if (request.safetyDecision) {
      if (request.safetyDecision.tenantId && request.safetyDecision.tenantId !== request.tenantId) {
        return {
          allowed: false,
          effectiveApproval: definition.approval,
          reasonCode: 'CAPABILITY_POLICY_FAILED',
          userFacingExplanation: 'Tenant mismatch between request and safety decision.',
        };
      }
      if (request.safetyDecision.executionAllowed === false) {
        return {
          allowed: false,
          effectiveApproval: definition.approval,
          reasonCode: 'CAPABILITY_BLOCKED_BY_SAFETY',
          userFacingExplanation: request.safetyDecision.userFacingExplanation || 'Execution blocked by safety policy.',
        };
      }
      if (['R2', 'R3', 'R4'].includes(request.safetyDecision.riskLevel)) {
        return {
          allowed: false,
          effectiveApproval: definition.approval,
          reasonCode: 'CAPABILITY_BLOCKED_BY_SAFETY',
          userFacingExplanation: request.safetyDecision.userFacingExplanation || `Execution blocked due to safety risk level ${request.safetyDecision.riskLevel}.`,
        };
      }
    }

    // 8 & Effective Approval = max(tool policy, safety policy)
    let effectiveApproval: CapabilityApprovalMode = definition.approval;
    if (request.safetyDecision?.requiresActionApproval) {
      effectiveApproval = 'REQUIRED';
    }

    return {
      allowed: true,
      effectiveApproval,
    };
  }
}
