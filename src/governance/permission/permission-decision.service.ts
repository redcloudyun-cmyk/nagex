import type { AuditLogger } from '../audit.logger.js';
import { CapabilityPolicy } from '../../capabilities/capability-policy.js';
import type { PermissionDecision, PermissionEvaluationInput } from './permission.types.js';

export const PERMISSION_POLICY_VERSION = 'r23.3t-v1';

export class PermissionDecisionService {
  constructor(private readonly auditLogger: AuditLogger) {}

  public evaluate(input: PermissionEvaluationInput): PermissionDecision {
    const policy = CapabilityPolicy.evaluate(
      input.request,
      input.definition,
      input.providerAvailable,
    );

    const disposition: PermissionDecision['disposition'] =
      !policy.allowed
        ? 'BLOCK'
        : policy.effectiveApproval === 'REQUIRED'
          ? 'REQUIRE_APPROVAL'
          : 'ALLOW';

    const decision: PermissionDecision = {
      disposition,
      reasonCodes: policy.reasonCode ? [policy.reasonCode] : [
        disposition === 'REQUIRE_APPROVAL'
          ? 'PERMISSION_APPROVAL_REQUIRED'
          : 'PERMISSION_ALLOWED',
      ],
      policyVersion: PERMISSION_POLICY_VERSION,
      effectiveApproval: policy.effectiveApproval,
    };

    this.auditLogger.logEvent({
      actor: { type: 'user', id: input.request.principalId || 'unknown' },
      tenant_id: input.request.tenantId || 'unknown',
      action: 'permission.decision',
      resource: { type: 'Capability', id: input.request.capabilityId },
      result: disposition === 'BLOCK' ? 'DENIED' : disposition === 'REQUIRE_APPROVAL' ? 'PENDING_APPROVAL' : 'SUCCESS',
      reason_code: decision.reasonCodes[0],
      request_id: input.request.requestId || 'unknown',
      details: {
        capabilityId: input.request.capabilityId,
        provider: input.definition?.provider,
        source: input.request.source,
        risk: input.definition?.risk,
        mutation: input.definition?.risk !== 'READ_ONLY',
        disposition,
        policyVersion: decision.policyVersion,
      },
    });

    return decision;
  }
}
