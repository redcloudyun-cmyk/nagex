import { generateResourceId, getCurrentISOString } from '../common/utils.js';
import { AgexError } from '../common/errors.js';

export interface DelegationRequest {
  parent_agent_id: string;
  child_agent_id: string;
  parent_permissions: string[];
  child_permissions: string[];
  delegated_scope: string[];
}

export interface DelegatedAgentScope {
  delegation_id: string;
  parent_agent_id: string;
  child_agent_id: string;
  effective_permissions: string[]; // Intersection of Parent Permissions & Child Permissions & Delegated Scope (Rule 31/89 in S-05)
  created_at: string;
}

export class MultiAgentOrchestrator {
  public createDelegatedScope(request: DelegationRequest): DelegatedAgentScope {
    // 1. Calculate Permission Intersection (Delegation Rule in S-05: Child Agent cannot self-elevate or gain more than Parent)
    const effectivePermissions = request.child_permissions.filter(perm =>
      request.parent_permissions.includes(perm) && request.delegated_scope.includes(perm)
    );

    if (effectivePermissions.length === 0) {
      throw new AgexError({
        code: 'EMPTY_DELEGATED_SCOPE',
        category: 'POLICY',
        message: `Delegation from Agent ${request.parent_agent_id} to Agent ${request.child_agent_id} resulted in empty permission scope.`,
        request_id: 'del_req',
      });
    }

    return {
      delegation_id: generateResourceId('dlg'),
      parent_agent_id: request.parent_agent_id,
      child_agent_id: request.child_agent_id,
      effective_permissions: effectivePermissions,
      created_at: getCurrentISOString(),
    };
  }
}
