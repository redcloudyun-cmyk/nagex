export type ScopeType = 'PLATFORM' | 'TENANT';

export type LifecycleState =
  | 'DRAFT'
  | 'VALIDATING'
  | 'REVIEW'
  | 'APPROVED'
  | 'PUBLISHED'
  | 'ACTIVE'
  | 'SUSPENDED'
  | 'DEPRECATED'
  | 'ARCHIVED'
  | 'DELETED';

export interface PrincipalReference {
  type: 'user' | 'service' | 'workload' | 'agent' | 'system';
  id: string;
}

export interface ResourceMetadata {
  id: string;
  name?: string | null;
  scope_type: ScopeType;
  tenant_id?: string | null;
  version?: number | null;
  revision: number;
  lifecycle_state: LifecycleState;
  owner?: PrincipalReference | null;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  created_at: string;
  updated_at: string;
  created_by: PrincipalReference;
  updated_by: PrincipalReference;
}

export interface ResourceReference {
  type: string;
  id: string;
  version?: number | null;
}

export interface TenantContext {
  tenant_id: string;
  scope_type: 'TENANT';
}
