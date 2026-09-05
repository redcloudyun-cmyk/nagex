import type { ResourceMetadata } from '../common/types.js';
import { AgexError } from '../common/errors.js';

export type IsolationProfile = 'SHARED' | 'ISOLATED_DATA' | 'ISOLATED_RUNTIME' | 'DEDICATED';
export type AutonomyLevel = 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5';
export type TenantState = 'PROVISIONING' | 'ACTIVE' | 'RESTRICTED' | 'SUSPENDED' | 'CLOSING' | 'DELETING' | 'DELETED';

const VALID_ISOLATION_PROFILES: ReadonlySet<IsolationProfile> = new Set([
  'SHARED',
  'ISOLATED_DATA',
  'ISOLATED_RUNTIME',
  'DEDICATED',
]);
const VALID_AUTONOMY_LEVELS: ReadonlySet<AutonomyLevel> = new Set(['L0', 'L1', 'L2', 'L3', 'L4', 'L5']);

export interface TenantSpecification {
  display_name: string;
  home_region: string;
  isolation_profile: IsolationProfile;
  maximum_autonomy_level: AutonomyLevel;
  data_residency_policy_id?: string | null;
  default_model_profile_id?: string | null;
  quota_profile_id?: string | null;
  retention_profile_id?: string | null;
}

export interface TenantStatus {
  state: TenantState;
  provisioning_state?: string | null;
  runtime_health?: string | null;
  suspension_reason?: string | null;
}

export interface TenantResource {
  api_version: 'agex/v1';
  kind: 'Tenant';
  metadata: ResourceMetadata;
  specification: TenantSpecification;
  status: TenantStatus;
}

export function validateTenantResource(tenant: TenantResource): void {
  if (tenant.kind !== 'Tenant') {
    throw new AgexError({
      code: 'VALIDATION_ERROR',
      category: 'VALIDATION',
      message: `Invalid Resource kind: ${tenant.kind}. Expected 'Tenant'.`,
      request_id: 'val_req',
    });
  }

  if (tenant.metadata.scope_type !== 'PLATFORM') {
    throw new AgexError({
      code: 'VALIDATION_ERROR',
      category: 'VALIDATION',
      message: `Tenant Resource metadata scope_type must be 'PLATFORM'.`,
      request_id: 'val_req',
    });
  }

  if (!tenant.specification.display_name) {
    throw new AgexError({
      code: 'VALIDATION_ERROR',
      category: 'VALIDATION',
      message: `Tenant display_name is required.`,
      request_id: 'val_req',
    });
  }

  if (!tenant.specification.home_region) {
    throw new AgexError({
      code: 'VALIDATION_ERROR',
      category: 'VALIDATION',
      message: `Tenant home_region is required.`,
      request_id: 'val_req',
    });
  }

  if (!VALID_ISOLATION_PROFILES.has(tenant.specification.isolation_profile)) {
    throw new AgexError({
      code: 'VALIDATION_ERROR',
      category: 'VALIDATION',
      message: `Invalid isolation_profile: ${tenant.specification.isolation_profile}.`,
      request_id: 'val_req',
    });
  }

  if (!VALID_AUTONOMY_LEVELS.has(tenant.specification.maximum_autonomy_level)) {
    throw new AgexError({
      code: 'VALIDATION_ERROR',
      category: 'VALIDATION',
      message: `Invalid maximum_autonomy_level: ${tenant.specification.maximum_autonomy_level}.`,
      request_id: 'val_req',
    });
  }
}
