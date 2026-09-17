// R15 — Role-Based Access Control (RBAC) Service & Permission Evaluator Layer
import { generateResourceId } from '../common/utils.js';
import { NagexError } from '../common/errors.js';
import type { AuditLogger } from '../governance/audit.logger.js';
import type { OrganizationStore } from '../organizations/organization.store.js';
import { RbacStore, BUILTIN_ROLE_IDS } from './rbac.store.js';
import {
  PERMISSIONS,
  type PermissionKey,
  type PermissionMapping,
  type RoleRecord,
  type RoleBindingRecord,
  type BuiltInRole,
} from './rbac.types.js';

export interface AuthorizeOptions {
  userId: string;
  organizationId: string;
  workspaceId?: string | null;
  permissionKey: PermissionKey;
  requestId?: string;
}

export class RbacService {
  private cache = new Map<string, boolean>();

  constructor(
    private readonly rbacStore: RbacStore,
    private readonly orgStore: OrganizationStore,
    private readonly auditLogger?: AuditLogger,
  ) {}

  public invalidateCache(): void {
    this.cache.clear();
  }

  private getCacheKey(userId: string, organizationId: string, workspaceId: string | null | undefined, permissionKey: string): string {
    return `${userId}:${organizationId}:${workspaceId ?? ''}:${permissionKey}`;
  }

  /**
   * Core Permission Evaluator: Deny-by-Default
   */
  public evaluatePermission(options: AuthorizeOptions): boolean {
    const { userId, organizationId, workspaceId, permissionKey } = options;
    if (!userId || !organizationId || !permissionKey) return false;
    if (!Object.values(PERMISSIONS).includes(permissionKey as any)) return false;

    const cacheKey = this.getCacheKey(userId, organizationId, workspaceId, permissionKey);
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    // 1. Verify caller has ACTIVE membership in organization
    const membership = this.orgStore.getMembership(organizationId, userId);
    if (!membership || membership.status !== 'ACTIVE') {
      this.cache.set(cacheKey, false);
      return false;
    }

    // 2. OWNER shortcut (OWNER has full organizational access)
    if (membership.role === 'OWNER') {
      this.cache.set(cacheKey, true);
      return true;
    }

    // 3. Collect all permission mappings from bound roles.
    //
    // membership.role (R14's own org-membership field) is only a coarse
    // OWNER/MEMBER distinction, not the RBAC role — it exists so a member
    // with no explicit RBAC binding still gets a sane default (baseline
    // MEMBER permissions). If the member DOES have an explicit
    // organization-scope RBAC binding (e.g. VIEWER), that binding replaces
    // the membership.role default rather than being unioned with it —
    // unioning them would let a VIEWER silently inherit MEMBER's broader
    // permissions (e.g. workspace.create) through the fallback alone,
    // defeating the whole point of assigning VIEWER.
    const bindings = this.rbacStore.listRoleBindingsByMembership(organizationId, membership.membershipId);
    const hasExplicitOrgScopeBinding = bindings.some((b) => b.workspaceId === null);

    const boundRoleIds = new Set<string>();
    if (!hasExplicitOrgScopeBinding) {
      const baseSystemRoleId = BUILTIN_ROLE_IDS[membership.role as BuiltInRole];
      if (baseSystemRoleId) {
        boundRoleIds.add(baseSystemRoleId);
      }
    }

    if (bindings.length > 0) {
      bindings.forEach((b) => {
        if (b.workspaceId === null || (workspaceId && b.workspaceId === workspaceId)) {
          boundRoleIds.add(b.roleId);
        }
      });
    }

    // Union permissions across all active bound roles
    let hasPermission = false;
    for (const roleId of boundRoleIds) {
      const role = this.rbacStore.getRole(roleId);
      if (!role) continue;

      const match = role.permissions.some((p) => p.permissionKey === permissionKey);
      if (match) {
        hasPermission = true;
        break;
      }
    }

    this.cache.set(cacheKey, hasPermission);
    return hasPermission;
  }

  /**
   * Convenience permission check helper
   */
  public can(userId: string, organizationId: string, permissionKey: PermissionKey, workspaceId?: string | null): boolean {
    return this.evaluatePermission({ userId, organizationId, permissionKey, workspaceId });
  }

  /**
   * Enforces permission check, logging audit event on DENY
   */
  public authorize(options: AuthorizeOptions): void {
    const allowed = this.evaluatePermission(options);
    if (!allowed) {
      this.auditLogger?.logEvent({
        actor: { type: 'user', id: options.userId },
        tenant_id: options.organizationId,
        action: 'authorization.denied',
        resource: { type: 'permission', id: options.permissionKey },
        result: 'DENIED',
        reason_code: 'AUTHZ_PERMISSION_DENIED',
        request_id: options.requestId ?? 'req_authz_denied',
        details: {
          organizationId: options.organizationId,
          workspaceId: options.workspaceId,
          permissionKey: options.permissionKey,
        },
      });

      throw new NagexError({
        code: 'AUTHZ_PERMISSION_DENIED',
        category: 'AUTHORIZATION',
        message: `You do not have permission (${options.permissionKey}) to perform this action.`,
      });
    }
  }

  /**
   * Get all effective permissions for a user within an organization/workspace
   */
  public getEffectivePermissions(userId: string, organizationId: string, workspaceId?: string | null): PermissionMapping[] {
    const membership = this.orgStore.getMembership(organizationId, userId);
    if (!membership || membership.status !== 'ACTIVE') return [];

    if (membership.role === 'OWNER') {
      return this.rbacStore.getRole(BUILTIN_ROLE_IDS.OWNER)?.permissions ?? [];
    }

    const bindings = this.rbacStore.listRoleBindingsByMembership(organizationId, membership.membershipId);
    const result = new Map<string, PermissionMapping>();

    // Same override-not-union rule as evaluatePermission() above — an
    // explicit organization-scope binding replaces the membership.role
    // default rather than being unioned with it.
    const hasExplicitOrgScopeBinding = bindings.some((b) => b.workspaceId === null);
    const roleIds = new Set<string>();
    if (!hasExplicitOrgScopeBinding) {
      const baseSystemRoleId = BUILTIN_ROLE_IDS[membership.role as BuiltInRole];
      if (baseSystemRoleId) {
        roleIds.add(baseSystemRoleId);
      }
    }

    if (bindings.length > 0) {
      bindings.forEach((b) => {
        if (b.workspaceId === null || (workspaceId && b.workspaceId === workspaceId)) {
          roleIds.add(b.roleId);
        }
      });
    }

    for (const roleId of roleIds) {
      const role = this.rbacStore.getRole(roleId);
      if (!role) continue;
      for (const p of role.permissions) {
        result.set(`${p.permissionKey}:${p.scope}`, p);
      }
    }

    return Array.from(result.values());
  }

  // ── Custom Role Management ──

  public listRoles(organizationId: string): RoleRecord[] {
    return this.rbacStore.listRoles(organizationId);
  }

  public getRole(organizationId: string, roleId: string): RoleRecord {
    const role = this.rbacStore.getRole(roleId);
    if (!role || (role.organizationId !== null && role.organizationId !== organizationId)) {
      throw new NagexError({ code: 'ROLE_NOT_FOUND', category: 'NOT_FOUND', message: 'Role not found.' });
    }
    return role;
  }

  public createCustomRole(
    callerUserIdOrParams: string | { callerUserId: string; organizationId: string; name: string; description: string; permissions: PermissionMapping[]; requestId?: string },
    organizationIdArg?: string,
    nameArg?: string,
    descriptionArg?: string,
    permissionsArg?: PermissionMapping[]
  ): RoleRecord {
    let params: { callerUserId: string; organizationId: string; name: string; description: string; permissions: PermissionMapping[]; requestId?: string };
    if (typeof callerUserIdOrParams === 'string') {
      params = {
        callerUserId: callerUserIdOrParams,
        organizationId: organizationIdArg!,
        name: nameArg!,
        description: descriptionArg!,
        permissions: permissionsArg!,
      };
    } else {
      params = callerUserIdOrParams;
    }
    const { callerUserId, organizationId, name, description, permissions, requestId } = params;

    this.authorize({ userId: callerUserId, organizationId, permissionKey: PERMISSIONS.ROLE_CREATE, requestId });

    // Ceiling Rule: Caller cannot grant permissions they do not possess
    const callerEffective = this.getEffectivePermissions(callerUserId, organizationId);
    const callerPermKeys = new Set(callerEffective.map((p) => p.permissionKey));

    for (const p of permissions) {
      if (!callerPermKeys.has(p.permissionKey)) {
        this.auditLogger?.logEvent({
          actor: { type: 'user', id: callerUserId },
          tenant_id: organizationId,
          action: 'privilege_escalation.blocked',
          resource: { type: 'permission', id: p.permissionKey },
          result: 'DENIED',
          reason_code: 'ROLE_CEILING_VIOLATION',
          request_id: requestId ?? 'req_priv_esc',
          details: { attemptedPermission: p.permissionKey },
        });
        throw new NagexError({
          code: 'PRIVILEGE_ESCALATION_BLOCKED',
          category: 'AUTHORIZATION',
          message: `Cannot grant permission (${p.permissionKey}) exceeding caller privileges.`,
        });
      }
    }

    const now = new Date().toISOString();
    const role: RoleRecord = {
      roleId: generateResourceId('role'),
      organizationId,
      name,
      description,
      isSystem: false,
      permissions,
      createdByUserId: callerUserId,
      createdAt: now,
      updatedAt: now,
    };

    this.rbacStore.saveRole(role);
    this.invalidateCache();

    this.auditLogger?.logEvent({
      actor: { type: 'user', id: callerUserId },
      tenant_id: organizationId,
      action: 'role.created',
      resource: { type: 'role', id: role.roleId },
      result: 'SUCCESS',
      request_id: requestId ?? 'req_role_create',
      details: { name, permissionsCount: permissions.length },
    });

    return role;
  }

  public updateCustomRole(
    callerUserIdOrParams: string | { callerUserId: string; organizationId: string; roleId: string; name?: string; description?: string; permissions?: PermissionMapping[]; requestId?: string },
    organizationIdArg?: string,
    roleIdArg?: string,
    updatesArg?: { name?: string; description?: string; permissions?: PermissionMapping[] }
  ): RoleRecord {
    let params: { callerUserId: string; organizationId: string; roleId: string; name?: string; description?: string; permissions?: PermissionMapping[]; requestId?: string };
    if (typeof callerUserIdOrParams === 'string') {
      params = {
        callerUserId: callerUserIdOrParams,
        organizationId: organizationIdArg!,
        roleId: roleIdArg!,
        ...updatesArg,
      };
    } else {
      params = callerUserIdOrParams;
    }
    const { callerUserId, organizationId, roleId, name, description, permissions, requestId } = params;

    this.authorize({ userId: callerUserId, organizationId, permissionKey: PERMISSIONS.ROLE_UPDATE, requestId });

    const role = this.getRole(organizationId, roleId);
    if (role.isSystem) {
      throw new NagexError({ code: 'SYSTEM_ROLE_MUTATION_BLOCKED', category: 'AUTHORIZATION', message: 'System roles cannot be modified.' });
    }

    if (permissions) {
      const callerEffective = this.getEffectivePermissions(callerUserId, organizationId);
      const callerPermKeys = new Set(callerEffective.map((p) => p.permissionKey));
      for (const p of permissions) {
        if (!callerPermKeys.has(p.permissionKey)) {
          this.auditLogger?.logEvent({
            actor: { type: 'user', id: callerUserId },
            tenant_id: organizationId,
            action: 'privilege_escalation.blocked',
            resource: { type: 'role', id: roleId },
            result: 'DENIED',
            reason_code: 'ROLE_CEILING_VIOLATION',
            request_id: requestId ?? 'req_priv_esc',
            details: { attemptedPermission: p.permissionKey },
          });
          throw new NagexError({
            code: 'PRIVILEGE_ESCALATION_BLOCKED',
            category: 'AUTHORIZATION',
            message: `Cannot grant permission (${p.permissionKey}) exceeding caller privileges.`,
          });
        }
      }
      role.permissions = permissions;
    }

    if (name !== undefined) role.name = name;
    if (description !== undefined) role.description = description;
    role.updatedAt = new Date().toISOString();

    this.rbacStore.saveRole(role);
    this.invalidateCache();

    this.auditLogger?.logEvent({
      actor: { type: 'user', id: callerUserId },
      tenant_id: organizationId,
      action: 'role.updated',
      resource: { type: 'role', id: roleId },
      result: 'SUCCESS',
      request_id: requestId ?? 'req_role_update',
    });

    return role;
  }

  public deleteCustomRole(
    callerUserIdOrParams: string | { callerUserId: string; organizationId: string; roleId: string; requestId?: string },
    organizationIdArg?: string,
    roleIdArg?: string
  ): void {
    let params: { callerUserId: string; organizationId: string; roleId: string; requestId?: string };
    if (typeof callerUserIdOrParams === 'string') {
      params = {
        callerUserId: callerUserIdOrParams,
        organizationId: organizationIdArg!,
        roleId: roleIdArg!,
      };
    } else {
      params = callerUserIdOrParams;
    }
    const { callerUserId, organizationId, roleId, requestId } = params;

    this.authorize({ userId: callerUserId, organizationId, permissionKey: PERMISSIONS.ROLE_DELETE, requestId });

    const role = this.getRole(organizationId, roleId);
    if (role.isSystem) {
      throw new NagexError({ code: 'SYSTEM_ROLE_MUTATION_BLOCKED', category: 'AUTHORIZATION', message: 'System roles cannot be deleted.' });
    }

    const activeBindings = this.rbacStore.listRoleBindingsByRole(roleId);
    if (activeBindings.length > 0) {
      throw new NagexError({ code: 'AUTHZ_ROLE_IN_USE', category: 'CONFLICT', message: 'Cannot delete role with active member assignments.' });
    }

    this.rbacStore.deleteRole(roleId);
    this.invalidateCache();

    this.auditLogger?.logEvent({
      actor: { type: 'user', id: callerUserId },
      tenant_id: organizationId,
      action: 'role.deleted',
      resource: { type: 'role', id: roleId },
      result: 'SUCCESS',
      request_id: requestId ?? 'req_role_delete',
    });
  }

  // ── Role Binding Management ──

  public listMemberRoleBindings(organizationId: string, userId: string): RoleBindingRecord[] {
    return this.rbacStore.listRoleBindings(organizationId, userId);
  }

  public assignRoleBinding(
    callerUserIdOrParams: string | { callerUserId: string; organizationId: string; targetUserId: string; roleId: string; workspaceId?: string | null; requestId?: string },
    organizationIdArg?: string,
    targetUserIdArg?: string,
    roleIdArg?: string,
    workspaceIdArg?: string | null
  ): RoleBindingRecord {
    let params: { callerUserId: string; organizationId: string; targetUserId: string; roleId: string; workspaceId?: string | null; requestId?: string };
    if (typeof callerUserIdOrParams === 'string') {
      params = {
        callerUserId: callerUserIdOrParams,
        organizationId: organizationIdArg!,
        targetUserId: targetUserIdArg!,
        roleId: roleIdArg!,
        workspaceId: workspaceIdArg,
      };
    } else {
      params = callerUserIdOrParams;
    }
    const { callerUserId, organizationId, targetUserId, roleId, workspaceId, requestId } = params;

    this.authorize({ userId: callerUserId, organizationId, permissionKey: PERMISSIONS.ROLE_ASSIGN, requestId });

    // 1. OWNER assignment bypass guard (OWNER role cannot be assigned via normal API)
    if (roleId === BUILTIN_ROLE_IDS.OWNER) {
      this.auditLogger?.logEvent({
        actor: { type: 'user', id: callerUserId },
        tenant_id: organizationId,
        action: 'privilege_escalation.blocked',
        resource: { type: 'role', id: roleId },
        result: 'DENIED',
        reason_code: 'OWNER_BYPASS_ATTEMPT',
        request_id: requestId ?? 'req_priv_esc',
        details: { targetUserId },
      });
      throw new NagexError({ code: 'AUTHZ_OWNER_ASSIGNMENT_RESTRICTED', category: 'AUTHORIZATION', message: 'Owner role can only be transferred via owner transfer flow.' });
    }

    // 2. Self-escalation guard (Caller cannot change their own roles unless OWNER)
    const callerMembership = this.orgStore.getMembership(organizationId, callerUserId);
    if (callerUserId === targetUserId && callerMembership?.role !== 'OWNER') {
      this.auditLogger?.logEvent({
        actor: { type: 'user', id: callerUserId },
        tenant_id: organizationId,
        action: 'privilege_escalation.blocked',
        resource: { type: 'user', id: targetUserId },
        result: 'DENIED',
        reason_code: 'SELF_ESCALATION_ATTEMPT',
        request_id: requestId ?? 'req_priv_esc',
      });
      throw new NagexError({ code: 'AUTHZ_SELF_ESCALATION_BLOCKED', category: 'AUTHORIZATION', message: 'Users cannot assign roles to themselves.' });
    }

    // 3. Cross-Tenant Role & User Validation
    const role = this.rbacStore.getRole(roleId);
    if (!role || (role.organizationId !== null && role.organizationId !== organizationId)) {
      throw new NagexError({ code: 'AUTHZ_ROLE_NOT_FOUND', category: 'NOT_FOUND', message: 'Role not found or belongs to another organization.' });
    }

    const targetMembership = this.orgStore.getMembership(organizationId, targetUserId);
    if (!targetMembership || targetMembership.status !== 'ACTIVE') {
      throw new NagexError({ code: 'MEMBER_NOT_FOUND', category: 'NOT_FOUND', message: 'Target user is not an active member of this organization.' });
    }

    if (workspaceId) {
      const ws = this.orgStore.getWorkspace(workspaceId);
      if (!ws || ws.organizationId !== organizationId || ws.status === 'DELETED') {
        throw new NagexError({ code: 'AUTHZ_WORKSPACE_NOT_FOUND', category: 'NOT_FOUND', message: 'Workspace not found in this organization.' });
      }
    }

    // 4. Role Ceiling Check: Caller cannot assign a role with permissions exceeding their own
    if (callerMembership?.role !== 'OWNER') {
      const callerEffective = this.getEffectivePermissions(callerUserId, organizationId);
      const callerPermKeys = new Set(callerEffective.map((p) => p.permissionKey));
      for (const p of role.permissions) {
        if (!callerPermKeys.has(p.permissionKey)) {
          this.auditLogger?.logEvent({
            actor: { type: 'user', id: callerUserId },
            tenant_id: organizationId,
            action: 'privilege_escalation.blocked',
            resource: { type: 'role', id: roleId },
            result: 'DENIED',
            reason_code: 'ROLE_CEILING_VIOLATION',
            request_id: requestId ?? 'req_priv_esc',
            details: { unheldPermission: p.permissionKey },
          });
          throw new NagexError({ code: 'AUTHZ_PRIVILEGE_ESCALATION', category: 'AUTHORIZATION', message: `Cannot assign role containing permission (${p.permissionKey}) exceeding caller privileges.` });
        }
      }
    }

    const binding: RoleBindingRecord = {
      roleBindingId: generateResourceId('rb'),
      organizationId,
      workspaceId: workspaceId ?? null,
      membershipId: targetMembership.membershipId,
      userId: targetUserId,
      roleId,
      createdByUserId: callerUserId,
      createdAt: new Date().toISOString(),
    };

    this.rbacStore.saveRoleBinding(binding);
    this.invalidateCache();

    this.auditLogger?.logEvent({
      actor: { type: 'user', id: callerUserId },
      tenant_id: organizationId,
      action: 'role.assigned',
      resource: { type: 'role_binding', id: binding.roleBindingId },
      result: 'SUCCESS',
      request_id: requestId ?? 'req_role_assign',
      details: { targetUserId, roleId, workspaceId: workspaceId ?? null },
    });

    return binding;
  }

  public assignRole(
    callerUserIdOrParams: any,
    organizationIdArg?: string,
    targetUserIdArg?: string,
    roleIdArg?: string,
    workspaceIdArg?: string | null
  ): RoleBindingRecord {
    return this.assignRoleBinding(callerUserIdOrParams, organizationIdArg, targetUserIdArg, roleIdArg, workspaceIdArg);
  }

  public removeRoleBinding(
    callerUserIdOrParams: string | { callerUserId: string; organizationId: string; targetUserId?: string; bindingId: string; requestId?: string },
    organizationIdArg?: string,
    bindingIdOrTargetUserIdArg?: string,
    bindingIdArg?: string
  ): void {
    let params: { callerUserId: string; organizationId: string; targetUserId?: string; bindingId: string; requestId?: string };
    if (typeof callerUserIdOrParams === 'string') {
      const bindingId = bindingIdArg ?? bindingIdOrTargetUserIdArg!;
      const targetUserId = bindingIdArg ? bindingIdOrTargetUserIdArg : undefined;
      params = { callerUserId: callerUserIdOrParams, organizationId: organizationIdArg!, targetUserId, bindingId };
    } else {
      params = callerUserIdOrParams;
    }
    const { callerUserId, organizationId, bindingId, requestId } = params;

    this.authorize({ userId: callerUserId, organizationId, permissionKey: PERMISSIONS.ROLE_ASSIGN, requestId });

    const binding = this.rbacStore.getRoleBinding(bindingId);
    if (!binding || binding.organizationId !== organizationId) {
      throw new NagexError({ code: 'BINDING_NOT_FOUND', category: 'NOT_FOUND', message: 'Role binding not found.' });
    }
    const targetUserId = params.targetUserId ?? binding.userId;

    const callerMembership = this.orgStore.getMembership(organizationId, callerUserId);
    if (callerUserId === targetUserId && callerMembership?.role !== 'OWNER') {
      throw new NagexError({ code: 'AUTHZ_SELF_ESCALATION_BLOCKED', category: 'AUTHORIZATION', message: 'Users cannot remove their own role assignments.' });
    }

    this.rbacStore.deleteRoleBinding(bindingId);
    this.invalidateCache();

    this.auditLogger?.logEvent({
      actor: { type: 'user', id: callerUserId },
      tenant_id: organizationId,
      action: 'role.removed',
      resource: { type: 'role_binding', id: bindingId },
      result: 'SUCCESS',
      request_id: requestId ?? 'req_role_remove',
      details: { targetUserId },
    });
  }

  public removeRoleAssignment(
    callerUserIdOrParams: any,
    organizationIdArg?: string,
    bindingIdOrTargetUserIdArg?: string,
    bindingIdArg?: string
  ): void {
    return this.removeRoleBinding(callerUserIdOrParams, organizationIdArg, bindingIdOrTargetUserIdArg, bindingIdArg);
  }
}
