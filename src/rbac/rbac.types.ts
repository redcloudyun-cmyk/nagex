// R15 — Role-Based Access Control (RBAC) & Permission System Types

export type PermissionScope = 'ORGANIZATION' | 'WORKSPACE';

export const PERMISSIONS = {
  // Organization Scope
  ORG_READ: 'organization.read',
  ORGANIZATION_READ: 'organization.read',
  ORG_UPDATE: 'organization.update',
  ORGANIZATION_UPDATE: 'organization.update',
  ORG_DELETE: 'organization.delete',
  ORGANIZATION_DELETE: 'organization.delete',
  MEMBER_READ: 'member.read',
  MEMBER_INVITE: 'member.invite',
  MEMBER_REMOVE: 'member.remove',
  ROLE_READ: 'role.read',
  ROLE_CREATE: 'role.create',
  ROLE_UPDATE: 'role.update',
  ROLE_DELETE: 'role.delete',
  ROLE_ASSIGN: 'role.assign',
  AUDIT_READ: 'audit.read',

  // Workspace Scope
  WORKSPACE_READ: 'workspace.read',
  WORKSPACE_CREATE: 'workspace.create',
  WORKSPACE_UPDATE: 'workspace.update',
  WORKSPACE_ARCHIVE: 'workspace.archive',
  WORKSPACE_DELETE: 'workspace.delete',

  // R16 — Enterprise Identity Federation & Provisioning (Organization scope only)
  IDENTITY_PROVIDER_READ: 'identity_provider.read',
  IDENTITY_PROVIDER_MANAGE: 'identity_provider.manage',
  DOMAIN_READ: 'domain.read',
  DOMAIN_MANAGE: 'domain.manage',
  PROVISIONING_READ: 'provisioning.read',
  PROVISIONING_MANAGE: 'provisioning.manage',
  SSO_POLICY_READ: 'sso_policy.read',
  SSO_POLICY_MANAGE: 'sso_policy.manage',
} as const;

export type PermissionKey = typeof PERMISSIONS[keyof typeof PERMISSIONS];

export interface PermissionMapping {
  permissionKey: PermissionKey;
  scope: PermissionScope;
}

export type BuiltInRole = 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';

export interface RoleRecord {
  roleId: string;
  organizationId: string | null; // null for global built-in roles
  name: string;
  description: string;
  isSystem: boolean;
  permissions: PermissionMapping[];
  createdByUserId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RoleBindingRecord {
  roleBindingId: string;
  organizationId: string;
  workspaceId?: string | null; // null = Organization scope
  membershipId: string;
  userId: string;
  roleId: string;
  createdByUserId: string;
  createdAt: string;
}

export type RbacAuditEventType =
  | 'role.created'
  | 'role.updated'
  | 'role.deleted'
  | 'role.assigned'
  | 'role.removed'
  | 'permission.granted'
  | 'permission.removed'
  | 'authorization.denied'
  | 'privilege_escalation.blocked';

export const BUILTIN_ROLE_DEFINITIONS: Record<BuiltInRole, { name: string; description: string; permissions: PermissionMapping[] }> = {
  OWNER: {
    name: 'Owner',
    description: 'Full administrative access over the organization and all workspaces.',
    permissions: [
      { permissionKey: PERMISSIONS.ORG_READ, scope: 'ORGANIZATION' },
      { permissionKey: PERMISSIONS.ORG_UPDATE, scope: 'ORGANIZATION' },
      { permissionKey: PERMISSIONS.ORG_DELETE, scope: 'ORGANIZATION' },
      { permissionKey: PERMISSIONS.MEMBER_READ, scope: 'ORGANIZATION' },
      { permissionKey: PERMISSIONS.MEMBER_INVITE, scope: 'ORGANIZATION' },
      { permissionKey: PERMISSIONS.MEMBER_REMOVE, scope: 'ORGANIZATION' },
      { permissionKey: PERMISSIONS.ROLE_READ, scope: 'ORGANIZATION' },
      { permissionKey: PERMISSIONS.ROLE_CREATE, scope: 'ORGANIZATION' },
      { permissionKey: PERMISSIONS.ROLE_UPDATE, scope: 'ORGANIZATION' },
      { permissionKey: PERMISSIONS.ROLE_DELETE, scope: 'ORGANIZATION' },
      { permissionKey: PERMISSIONS.ROLE_ASSIGN, scope: 'ORGANIZATION' },
      { permissionKey: PERMISSIONS.AUDIT_READ, scope: 'ORGANIZATION' },
      { permissionKey: PERMISSIONS.WORKSPACE_READ, scope: 'WORKSPACE' },
      { permissionKey: PERMISSIONS.WORKSPACE_CREATE, scope: 'WORKSPACE' },
      { permissionKey: PERMISSIONS.WORKSPACE_UPDATE, scope: 'WORKSPACE' },
      { permissionKey: PERMISSIONS.WORKSPACE_ARCHIVE, scope: 'WORKSPACE' },
      { permissionKey: PERMISSIONS.WORKSPACE_DELETE, scope: 'WORKSPACE' },
      // R16 — OWNER holds every enterprise identity permission.
      { permissionKey: PERMISSIONS.IDENTITY_PROVIDER_READ, scope: 'ORGANIZATION' },
      { permissionKey: PERMISSIONS.IDENTITY_PROVIDER_MANAGE, scope: 'ORGANIZATION' },
      { permissionKey: PERMISSIONS.DOMAIN_READ, scope: 'ORGANIZATION' },
      { permissionKey: PERMISSIONS.DOMAIN_MANAGE, scope: 'ORGANIZATION' },
      { permissionKey: PERMISSIONS.PROVISIONING_READ, scope: 'ORGANIZATION' },
      { permissionKey: PERMISSIONS.PROVISIONING_MANAGE, scope: 'ORGANIZATION' },
      { permissionKey: PERMISSIONS.SSO_POLICY_READ, scope: 'ORGANIZATION' },
      { permissionKey: PERMISSIONS.SSO_POLICY_MANAGE, scope: 'ORGANIZATION' },
    ],
  },
  ADMIN: {
    name: 'Admin',
    description: 'Organization management except deletion and owner transfer.',
    permissions: [
      { permissionKey: PERMISSIONS.ORG_READ, scope: 'ORGANIZATION' },
      { permissionKey: PERMISSIONS.ORG_UPDATE, scope: 'ORGANIZATION' },
      { permissionKey: PERMISSIONS.MEMBER_READ, scope: 'ORGANIZATION' },
      { permissionKey: PERMISSIONS.MEMBER_INVITE, scope: 'ORGANIZATION' },
      { permissionKey: PERMISSIONS.MEMBER_REMOVE, scope: 'ORGANIZATION' },
      { permissionKey: PERMISSIONS.ROLE_READ, scope: 'ORGANIZATION' },
      { permissionKey: PERMISSIONS.ROLE_ASSIGN, scope: 'ORGANIZATION' },
      { permissionKey: PERMISSIONS.AUDIT_READ, scope: 'ORGANIZATION' },
      { permissionKey: PERMISSIONS.WORKSPACE_READ, scope: 'WORKSPACE' },
      { permissionKey: PERMISSIONS.WORKSPACE_CREATE, scope: 'WORKSPACE' },
      { permissionKey: PERMISSIONS.WORKSPACE_UPDATE, scope: 'WORKSPACE' },
      { permissionKey: PERMISSIONS.WORKSPACE_ARCHIVE, scope: 'WORKSPACE' },
      // R16 — ADMIN gets read on every enterprise identity area, plus
      // "limited manage" per §41: it may operate day-to-day identity
      // provider / domain / provisioning configuration, but NEVER
      // sso_policy.manage (SSO_REQUIRED toggle, local-login policy) — §42
      // names "ADMIN turns off SSO_REQUIRED" as exactly the privilege-
      // escalation-adjacent action that must stay OWNER-only, since
      // disabling enforcement is itself a security-boundary change, not
      // routine identity administration.
      { permissionKey: PERMISSIONS.IDENTITY_PROVIDER_READ, scope: 'ORGANIZATION' },
      { permissionKey: PERMISSIONS.IDENTITY_PROVIDER_MANAGE, scope: 'ORGANIZATION' },
      { permissionKey: PERMISSIONS.DOMAIN_READ, scope: 'ORGANIZATION' },
      { permissionKey: PERMISSIONS.DOMAIN_MANAGE, scope: 'ORGANIZATION' },
      { permissionKey: PERMISSIONS.PROVISIONING_READ, scope: 'ORGANIZATION' },
      { permissionKey: PERMISSIONS.PROVISIONING_MANAGE, scope: 'ORGANIZATION' },
      { permissionKey: PERMISSIONS.SSO_POLICY_READ, scope: 'ORGANIZATION' },
    ],
  },
  MEMBER: {
    name: 'Member',
    description: 'Standard member with access to read organization and create workspaces.',
    permissions: [
      { permissionKey: PERMISSIONS.ORG_READ, scope: 'ORGANIZATION' },
      { permissionKey: PERMISSIONS.MEMBER_READ, scope: 'ORGANIZATION' },
      { permissionKey: PERMISSIONS.WORKSPACE_READ, scope: 'WORKSPACE' },
      { permissionKey: PERMISSIONS.WORKSPACE_CREATE, scope: 'WORKSPACE' },
    ],
  },
  VIEWER: {
    name: 'Viewer',
    description: 'Read-only viewer.',
    permissions: [
      { permissionKey: PERMISSIONS.ORG_READ, scope: 'ORGANIZATION' },
      { permissionKey: PERMISSIONS.MEMBER_READ, scope: 'ORGANIZATION' },
      { permissionKey: PERMISSIONS.WORKSPACE_READ, scope: 'WORKSPACE' },
    ],
  },
};
