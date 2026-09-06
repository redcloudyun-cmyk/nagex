import type { SideEffectLevel } from '../tools/tool-registry.js';

export interface ApprovalDecision {
  required: boolean;
  reason: 'READ_ONLY' | 'TOOL_POLICY' | 'CONSEQUENTIAL_WRITE' | 'MODEL_REQUESTED';
}

export class ApprovalPolicy {
  public decide(input: { sideEffectLevel: SideEffectLevel | null; toolRequiresApproval: boolean; modelRequiresApproval: boolean }): ApprovalDecision {
    if (input.sideEffectLevel === 'REVERSIBLE_WRITE' || input.sideEffectLevel === 'IRREVERSIBLE_WRITE') {
      return { required: true, reason: 'CONSEQUENTIAL_WRITE' };
    }
    if (input.toolRequiresApproval) return { required: true, reason: 'TOOL_POLICY' };
    if (input.modelRequiresApproval) return { required: true, reason: 'MODEL_REQUESTED' };
    return { required: false, reason: 'READ_ONLY' };
  }
}
