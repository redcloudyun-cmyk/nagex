// R15 — Role-Based Access Control (RBAC) Store Layer
import { FileRecordStore, resolveNagexDataDir } from '../governance/file-record.store.js';
import { BUILTIN_ROLE_DEFINITIONS, type RoleRecord, type RoleBindingRecord, type BuiltInRole } from './rbac.types.js';

import path from 'node:path';

export function isRoleRecord(value: unknown): value is RoleRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.roleId === 'string' &&
    typeof v.name === 'string' &&
    typeof v.description === 'string' &&
    typeof v.isSystem === 'boolean' &&
    Array.isArray(v.permissions) &&
    typeof v.createdAt === 'string'
  );
}

export function isRoleBindingRecord(value: unknown): value is RoleBindingRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.roleBindingId === 'string' &&
    typeof v.organizationId === 'string' &&
    typeof v.membershipId === 'string' &&
    typeof v.userId === 'string' &&
    typeof v.roleId === 'string' &&
    typeof v.createdAt === 'string'
  );
}

export const BUILTIN_ROLE_IDS: Record<BuiltInRole, string> = {
  OWNER: 'role_builtin_owner',
  ADMIN: 'role_builtin_admin',
  MEMBER: 'role_builtin_member',
  VIEWER: 'role_builtin_viewer',
};

export class RbacStore {
  private readonly rolesStore: FileRecordStore<RoleRecord>;
  private readonly bindingsStore: FileRecordStore<RoleBindingRecord>;

  constructor(options?: { dir?: string; rolesDir?: string; bindingsDir?: string }) {
    const baseDir = options?.dir;
    const rolesDir = options?.rolesDir ?? (baseDir ? path.join(baseDir, 'roles') : resolveNagexDataDir('rbac-roles', 'NAGEX_RBAC_ROLES_DIR'));
    const bindingsDir = options?.bindingsDir ?? (baseDir ? path.join(baseDir, 'bindings') : resolveNagexDataDir('rbac-bindings', 'NAGEX_RBAC_BINDINGS_DIR'));

    this.rolesStore = new FileRecordStore<RoleRecord>(rolesDir, isRoleRecord);
    this.bindingsStore = new FileRecordStore<RoleBindingRecord>(bindingsDir, isRoleBindingRecord);

    this.seedBuiltInRoles();
  }

  private seedBuiltInRoles(): void {
    const now = new Date().toISOString();
    for (const [key, def] of Object.entries(BUILTIN_ROLE_DEFINITIONS)) {
      const roleId = BUILTIN_ROLE_IDS[key as BuiltInRole];
      const existing = this.rolesStore.read(roleId);
      if (!existing) {
        this.rolesStore.write(roleId, {
          roleId,
          organizationId: null, // System-wide
          name: def.name,
          description: def.description,
          isSystem: true,
          permissions: def.permissions,
          createdByUserId: 'system',
          createdAt: now,
          updatedAt: now,
        });
      }
    }
  }

  public getRole(roleId: string): RoleRecord | null {
    return this.rolesStore.read(roleId);
  }

  public getRoleBySystemName(organizationId: string, systemName: string): RoleRecord | null {
    const key = systemName.toUpperCase() as BuiltInRole;
    const roleId = BUILTIN_ROLE_IDS[key];
    if (roleId) {
      return this.getRole(roleId);
    }
    const roles = this.listRoles(organizationId);
    return roles.find((r) => r.name.toLowerCase() === systemName.toLowerCase()) ?? null;
  }

  public listRoles(organizationId: string): RoleRecord[] {
    const all = this.rolesStore.readAll();
    // Return system roles + custom roles belonging to this organization
    return all.filter((r) => r.organizationId === null || r.organizationId === organizationId);
  }

  public saveRole(role: RoleRecord): void {
    this.rolesStore.write(role.roleId, role);
  }

  public deleteRole(roleId: string): void {
    this.rolesStore.remove(roleId);
  }

  public getRoleBinding(bindingId: string): RoleBindingRecord | null {
    return this.bindingsStore.read(bindingId);
  }

  public listRoleBindings(organizationId: string, userId?: string): RoleBindingRecord[] {
    const all = this.bindingsStore.readAll();
    return all.filter((b) => b.organizationId === organizationId && (!userId || b.userId === userId));
  }

  public listRoleBindingsByMembership(organizationId: string, membershipId: string): RoleBindingRecord[] {
    const all = this.bindingsStore.readAll();
    return all.filter((b) => b.organizationId === organizationId && b.membershipId === membershipId);
  }

  public listRoleBindingsByRole(roleId: string): RoleBindingRecord[] {
    const all = this.bindingsStore.readAll();
    return all.filter((b) => b.roleId === roleId);
  }

  public saveRoleBinding(binding: RoleBindingRecord): void {
    this.bindingsStore.write(binding.roleBindingId, binding);
  }

  public deleteRoleBinding(bindingId: string): void {
    this.bindingsStore.remove(bindingId);
  }

  public deleteRoleBindingsForMembership(membershipId: string): void {
    const all = this.bindingsStore.readAll();
    for (const b of all) {
      if (b.membershipId === membershipId) {
        this.bindingsStore.remove(b.roleBindingId);
      }
    }
  }

  public deleteRoleBindingsForWorkspace(workspaceId: string): void {
    const all = this.bindingsStore.readAll();
    for (const b of all) {
      if (b.workspaceId === workspaceId) {
        this.bindingsStore.remove(b.roleBindingId);
      }
    }
  }

  public deleteRoleBindingsForOrganization(organizationId: string): void {
    const all = this.bindingsStore.readAll();
    for (const b of all) {
      if (b.organizationId === organizationId) {
        this.bindingsStore.remove(b.roleBindingId);
      }
    }
  }
}
