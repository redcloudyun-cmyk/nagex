// P06 — Modules / Productization Layer Types

export type ModuleStatus =
  | 'AVAILABLE'
  | 'UNAVAILABLE'
  | 'DEGRADED'
  | 'DISABLED';

export interface ModuleDefinition {
  moduleId: string;
  name: string;
  version: string;
  category: string;
  description: string;
  capabilities: string[];
  requiredPermissions: string[];
  enabledByDefault: boolean;
}

export interface ModuleRuntimeState {
  moduleId: string;
  tenantId: string;
  enabled: boolean;
  status: ModuleStatus;
  health?: {
    ok: boolean;
    message?: string;
    checkedAt?: string;
  };
}

export interface ModuleRecord {
  id: string;
  tenantId: string;
  moduleId: string;
  enabled: boolean;
  updatedAt: string;
}

export function isModuleRecord(value: unknown): value is ModuleRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || !v.id.trim()) return false;
  if (typeof v.tenantId !== 'string' || !v.tenantId.trim()) return false;
  if (typeof v.moduleId !== 'string' || !v.moduleId.trim()) return false;
  if (typeof v.enabled !== 'boolean') return false;
  if (typeof v.updatedAt !== 'string' || !v.updatedAt.trim()) return false;
  return true;
}
