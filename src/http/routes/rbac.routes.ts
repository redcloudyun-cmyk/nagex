// R15 — Role-Based Access Control (RBAC) HTTP Route Registrar
import { NagexError } from '../../common/errors.js';
import type { RbacService } from '../../rbac/rbac.service.js';
import type { OrganizationStore } from '../../organizations/organization.store.js';
import type { IdentityStore } from '../../identity/identity.store.js';
import type { SessionStore } from '../../sessions/session.store.js';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';
import { PERMISSIONS } from '../../rbac/rbac.types.js';

export interface RbacRoutesDependencies {
  rbacService: RbacService;
  organizationStore: OrganizationStore;
  identityStore: IdentityStore;
  sessionStore: SessionStore;
}

function getSessionIdFromHeaders(headers: Record<string, string | string[] | undefined>): string | null {
  const cookieHeader = Array.isArray(headers['cookie']) ? headers['cookie'][0] : headers['cookie'];
  if (cookieHeader) {
    const match = cookieHeader.match(/nagex_session=([^;]+)/);
    if (match) return decodeURIComponent(match[1]);
  }
  const authHeader = Array.isArray(headers['authorization']) ? headers['authorization'][0] : headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7).trim();
  }
  return null;
}

function getAuthenticatedUser(
  headers: Record<string, string | string[] | undefined>,
  deps: RbacRoutesDependencies
): { userId: string; email: string } {
  const sessionId = getSessionIdFromHeaders(headers);
  if (!sessionId) {
    throw new NagexError({ code: 'AUTH_REQUIRED', category: 'AUTHENTICATION', message: 'Authentication required.' });
  }

  const session = deps.sessionStore.getSession(sessionId);
  if (!session || session.revokedAt || new Date(session.expiresAt).getTime() < Date.now()) {
    throw new NagexError({ code: 'AUTH_SESSION_EXPIRED', category: 'AUTHENTICATION', message: 'Session expired or revoked.' });
  }

  const identity = deps.identityStore.getByUserId(session.principalId);
  if (!identity || identity.accountState !== 'ACTIVE') {
    throw new NagexError({ code: 'AUTH_ACCOUNT_DISABLED', category: 'AUTHENTICATION', message: 'Account is not active.' });
  }

  return { userId: identity.userId, email: identity.email };
}

export const handleRbacRoutes: AsyncRouteRegistrar<RbacRoutesDependencies> = async (
  method,
  pathname,
  body,
  headers,
  _query,
  deps
): Promise<ApiResult | undefined> => {
  // GET /api/v1/organizations/:organizationId/roles
  let match = pathname.match(/^\/api\/(?:v1\/)?organizations\/([^\/]+)\/roles$/);
  if (match) {
    const [, organizationId] = match;
    const user = getAuthenticatedUser(headers, deps);

    if (method === 'GET') {
      deps.rbacService.authorize({ userId: user.userId, organizationId, permissionKey: PERMISSIONS.ROLE_READ });
      const roles = deps.rbacService.listRoles(organizationId);
      return { status: 200, data: { roles } };
    }

    if (method === 'POST') {
      const input = (body ?? {}) as { name?: string; description?: string; permissions?: any[] };
      if (!input.name || typeof input.name !== 'string' || !input.name.trim()) {
        throw new NagexError({ code: 'INVALID_INPUT', category: 'VALIDATION', message: 'Role name is required.' });
      }
      if (!Array.isArray(input.permissions)) {
        throw new NagexError({ code: 'INVALID_INPUT', category: 'VALIDATION', message: 'Role permissions array is required.' });
      }

      const role = deps.rbacService.createCustomRole({
        callerUserId: user.userId,
        organizationId,
        name: input.name.trim(),
        description: (input.description ?? '').trim(),
        permissions: input.permissions,
      });

      return { status: 201, data: { role } };
    }
  }

  // GET/PATCH/DELETE /api/v1/organizations/:organizationId/roles/:roleId
  match = pathname.match(/^\/api\/(?:v1\/)?organizations\/([^\/]+)\/roles\/([^\/]+)$/);
  if (match) {
    const [, organizationId, roleId] = match;
    const user = getAuthenticatedUser(headers, deps);

    if (method === 'GET') {
      deps.rbacService.authorize({ userId: user.userId, organizationId, permissionKey: PERMISSIONS.ROLE_READ });
      const role = deps.rbacService.getRole(organizationId, roleId);
      return { status: 200, data: { role } };
    }

    if (method === 'PATCH') {
      const input = (body ?? {}) as { name?: string; description?: string; permissions?: any[] };
      const role = deps.rbacService.updateCustomRole({
        callerUserId: user.userId,
        organizationId,
        roleId,
        name: input.name,
        description: input.description,
        permissions: input.permissions,
      });
      return { status: 200, data: { role } };
    }

    if (method === 'DELETE') {
      deps.rbacService.deleteCustomRole({
        callerUserId: user.userId,
        organizationId,
        roleId,
      });
      return { status: 200, data: { success: true } };
    }
  }

  // GET/POST /api/v1/organizations/:organizationId/members/:userId/roles
  match = pathname.match(/^\/api\/(?:v1\/)?organizations\/([^\/]+)\/members\/([^\/]+)\/roles$/);
  if (match) {
    const [, organizationId, targetUserId] = match;
    const user = getAuthenticatedUser(headers, deps);

    if (method === 'GET') {
      deps.rbacService.authorize({ userId: user.userId, organizationId, permissionKey: PERMISSIONS.ROLE_READ });
      const bindings = deps.rbacService.listMemberRoleBindings(organizationId, targetUserId);
      return { status: 200, data: { bindings } };
    }

    if (method === 'POST') {
      const input = (body ?? {}) as { roleId?: string; workspaceId?: string };
      if (!input.roleId || typeof input.roleId !== 'string') {
        throw new NagexError({ code: 'INVALID_INPUT', category: 'VALIDATION', message: 'roleId is required.' });
      }

      const binding = deps.rbacService.assignRoleBinding({
        callerUserId: user.userId,
        organizationId,
        targetUserId,
        roleId: input.roleId,
        workspaceId: input.workspaceId,
      });

      return { status: 201, data: { binding } };
    }
  }

  // DELETE /api/v1/organizations/:organizationId/members/:userId/roles/:bindingId
  match = pathname.match(/^\/api\/(?:v1\/)?organizations\/([^\/]+)\/members\/([^\/]+)\/roles\/([^\/]+)$/);
  if (match && method === 'DELETE') {
    const [, organizationId, targetUserId, bindingId] = match;
    const user = getAuthenticatedUser(headers, deps);

    deps.rbacService.removeRoleBinding({
      callerUserId: user.userId,
      organizationId,
      targetUserId,
      bindingId,
    });

    return { status: 200, data: { success: true } };
  }

  // GET /api/v1/organizations/:organizationId/effective-permissions
  match = pathname.match(/^\/api\/(?:v1\/)?organizations\/([^\/]+)\/effective-permissions$/);
  if (match && method === 'GET') {
    const [, organizationId] = match;
    const user = getAuthenticatedUser(headers, deps);
    const workspaceId = _query?.workspaceId;

    const permissions = deps.rbacService.getEffectivePermissions(user.userId, organizationId, workspaceId);
    return { status: 200, data: { permissions } };
  }

  return undefined;
};
