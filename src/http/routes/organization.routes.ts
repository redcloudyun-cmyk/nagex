// R14 Organization & Workspace — HTTP Route Registrar
import { NagexError } from '../../common/errors.js';
import type { OrganizationStore } from '../../organizations/organization.store.js';
import type { IdentityStore } from '../../identity/identity.store.js';
import type { IdentityAuditStore } from '../../identity/identity.audit.js';
import type { SessionStore } from '../../sessions/session.store.js';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';

export interface OrganizationRoutesDependencies {
  organizationStore: OrganizationStore;
  identityStore: IdentityStore;
  identityAuditStore: IdentityAuditStore;
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
  deps: OrganizationRoutesDependencies
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
    if (identity && identity.accountState === 'DELETION_PENDING') {
      // Allowed to view account, but not perform org mutations
    } else {
      throw new NagexError({ code: 'AUTH_ACCOUNT_DISABLED', category: 'AUTHENTICATION', message: 'Account is not active.' });
    }
  }

  return { userId: identity!.userId, email: identity!.email };
}

export const handleOrganizationRoutes: AsyncRouteRegistrar<OrganizationRoutesDependencies> = async (
  method,
  pathname,
  body,
  headers,
  _query,
  deps
): Promise<ApiResult | undefined> => {
  const rawForwarded = Array.isArray(headers['x-forwarded-for']) ? headers['x-forwarded-for'][0] : headers['x-forwarded-for'];
  const clientIp = rawForwarded || '127.0.0.1';
  const rawUserAgent = Array.isArray(headers['user-agent']) ? headers['user-agent'][0] : headers['user-agent'];
  const userAgent = rawUserAgent || null;

  try {
    // 16. POST /api/v1/invitations/:token/accept (Static token route before parameterized org routes)
    const acceptMatch = pathname.match(/^\/api\/v1\/invitations\/([^/]+)\/accept$/);
    if (acceptMatch && method === 'POST') {
      const auth = getAuthenticatedUser(headers, deps);
      const rawToken = decodeURIComponent(acceptMatch[1]);

      const result = deps.organizationStore.acceptInvitation(rawToken, auth.userId, auth.email);

      deps.identityAuditStore.recordEvent(auth.userId, 'invitation.accepted', 'SUCCESS', {
        ip: clientIp,
        userAgent,
        details: { organizationId: result.membership.organizationId },
      });
      deps.identityAuditStore.recordEvent(auth.userId, 'member.joined', 'SUCCESS', {
        ip: clientIp,
        userAgent,
        details: { organizationId: result.membership.organizationId },
      });

      return {
        status: 200,
        data: {
          status: 'SUCCESS',
          membership: result.membership,
          invitation: result.invitation,
        },
      };
    }

    // 1. POST /api/v1/organizations (Create Organization)
    if (pathname === '/api/v1/organizations' && method === 'POST') {
      const auth = getAuthenticatedUser(headers, deps);
      const data = body || {};
      const { name } = data as Record<string, any>;

      const result = deps.organizationStore.createOrganization(auth.userId, name);

      deps.identityAuditStore.recordEvent(auth.userId, 'organization.created', 'SUCCESS', {
        ip: clientIp,
        userAgent,
        details: { organizationId: result.organization.organizationId },
      });

      return {
        status: 201,
        data: {
          status: 'SUCCESS',
          organization: result.organization,
          membership: result.membership,
          workspace: result.workspace,
        },
      };
    }

    // 2. GET /api/v1/organizations (List Organizations for current user)
    if (pathname === '/api/v1/organizations' && method === 'GET') {
      const auth = getAuthenticatedUser(headers, deps);
      const orgs = deps.organizationStore.listOrganizationsForUser(auth.userId);
      return {
        status: 200,
        data: {
          organizations: orgs,
        },
      };
    }

    // Parameterized Organization Routes: /api/v1/organizations/:orgId...
    const orgMatch = pathname.match(/^\/api\/v1\/organizations\/([^/]+)(.*)$/);
    if (!orgMatch) return undefined;

    const orgId = decodeURIComponent(orgMatch[1]);
    const subPath = orgMatch[2];

    // 3. GET /api/v1/organizations/:orgId (Get Organization details)
    if (subPath === '' && method === 'GET') {
      const auth = getAuthenticatedUser(headers, deps);
      deps.organizationStore.assertMember(orgId, auth.userId);
      const org = deps.organizationStore.getOrganization(orgId);
      if (!org) {
        throw new NagexError({ code: 'ORG_NOT_FOUND', category: 'NOT_FOUND', message: 'Organization not found.' });
      }
      return { status: 200, data: { organization: org } };
    }

    // 4. PATCH /api/v1/organizations/:orgId (Update Organization)
    if (subPath === '' && method === 'PATCH') {
      const auth = getAuthenticatedUser(headers, deps);
      deps.organizationStore.assertOwner(orgId, auth.userId);
      const data = body || {};
      const { name } = data as Record<string, any>;
      const org = deps.organizationStore.updateOrganization(orgId, name);

      deps.identityAuditStore.recordEvent(auth.userId, 'organization.updated', 'SUCCESS', {
        ip: clientIp,
        userAgent,
        details: { organizationId: orgId },
      });

      return { status: 200, data: { organization: org } };
    }

    // 5. POST /api/v1/organizations/:orgId/delete (Request Deletion)
    if (subPath === '/delete' && method === 'POST') {
      const auth = getAuthenticatedUser(headers, deps);
      deps.organizationStore.assertOwner(orgId, auth.userId);
      const org = deps.organizationStore.requestOrganizationDeletion(orgId);

      deps.identityAuditStore.recordEvent(auth.userId, 'organization.deletion.requested', 'SUCCESS', {
        ip: clientIp,
        userAgent,
        details: { organizationId: orgId },
      });

      return { status: 200, data: { organization: org } };
    }

    // 6. POST /api/v1/organizations/:orgId/delete/cancel (Cancel Deletion)
    if (subPath === '/delete/cancel' && method === 'POST') {
      const auth = getAuthenticatedUser(headers, deps);
      deps.organizationStore.assertOwner(orgId, auth.userId);
      const org = deps.organizationStore.cancelOrganizationDeletion(orgId);

      deps.identityAuditStore.recordEvent(auth.userId, 'organization.deletion.cancelled', 'SUCCESS', {
        ip: clientIp,
        userAgent,
        details: { organizationId: orgId },
      });

      return { status: 200, data: { organization: org } };
    }

    // ── Workspaces Routes ──
    // 7. POST /api/v1/organizations/:orgId/workspaces (Create Workspace)
    if (subPath === '/workspaces' && method === 'POST') {
      const auth = getAuthenticatedUser(headers, deps);
      deps.organizationStore.assertOwner(orgId, auth.userId);
      const data = body || {};
      const { name } = data as Record<string, any>;
      const ws = deps.organizationStore.createWorkspace(orgId, auth.userId, name);

      deps.identityAuditStore.recordEvent(auth.userId, 'workspace.created', 'SUCCESS', {
        ip: clientIp,
        userAgent,
        details: { organizationId: orgId, workspaceId: ws.workspaceId },
      });

      return { status: 201, data: { workspace: ws } };
    }

    // 8. GET /api/v1/organizations/:orgId/workspaces (List Workspaces)
    if (subPath === '/workspaces' && method === 'GET') {
      const auth = getAuthenticatedUser(headers, deps);
      deps.organizationStore.assertMember(orgId, auth.userId);
      const workspaces = deps.organizationStore.listWorkspaces(orgId, true);
      return { status: 200, data: { workspaces } };
    }

    // Parameterized Workspace Routes: /api/v1/organizations/:orgId/workspaces/:wsId...
    const wsMatch = subPath.match(/^\/workspaces\/([^/]+)(.*)$/);
    if (wsMatch) {
      const wsId = decodeURIComponent(wsMatch[1]);
      const wsSubPath = wsMatch[2];

      // 9. PATCH /api/v1/organizations/:orgId/workspaces/:wsId
      if (wsSubPath === '' && method === 'PATCH') {
        const auth = getAuthenticatedUser(headers, deps);
        deps.organizationStore.assertOwner(orgId, auth.userId);
        const data = body || {};
        const { name } = data as Record<string, any>;
        const ws = deps.organizationStore.updateWorkspace(orgId, wsId, name);

        deps.identityAuditStore.recordEvent(auth.userId, 'workspace.updated', 'SUCCESS', {
          ip: clientIp,
          userAgent,
          details: { organizationId: orgId, workspaceId: wsId },
        });

        return { status: 200, data: { workspace: ws } };
      }

      // 10. POST /api/v1/organizations/:orgId/workspaces/:wsId/archive
      if (wsSubPath === '/archive' && method === 'POST') {
        const auth = getAuthenticatedUser(headers, deps);
        deps.organizationStore.assertOwner(orgId, auth.userId);
        const ws = deps.organizationStore.archiveWorkspace(orgId, wsId);

        deps.identityAuditStore.recordEvent(auth.userId, 'workspace.archived', 'SUCCESS', {
          ip: clientIp,
          userAgent,
          details: { organizationId: orgId, workspaceId: wsId },
        });

        return { status: 200, data: { workspace: ws } };
      }

      // 11. POST /api/v1/organizations/:orgId/workspaces/:wsId/restore
      if (wsSubPath === '/restore' && method === 'POST') {
        const auth = getAuthenticatedUser(headers, deps);
        deps.organizationStore.assertOwner(orgId, auth.userId);
        const ws = deps.organizationStore.restoreWorkspace(orgId, wsId);

        deps.identityAuditStore.recordEvent(auth.userId, 'workspace.restored', 'SUCCESS', {
          ip: clientIp,
          userAgent,
          details: { organizationId: orgId, workspaceId: wsId },
        });

        return { status: 200, data: { workspace: ws } };
      }

      // 12. POST /api/v1/organizations/:orgId/workspaces/:wsId/delete
      if (wsSubPath === '/delete' && method === 'POST') {
        const auth = getAuthenticatedUser(headers, deps);
        deps.organizationStore.assertOwner(orgId, auth.userId);
        const ws = deps.organizationStore.deleteWorkspace(orgId, wsId);

        deps.identityAuditStore.recordEvent(auth.userId, 'workspace.deletion.requested', 'SUCCESS', {
          ip: clientIp,
          userAgent,
          details: { organizationId: orgId, workspaceId: wsId },
        });

        return { status: 200, data: { workspace: ws } };
      }
    }

    // ── Invitations Routes ──
    // 13. POST /api/v1/organizations/:orgId/invitations (Create Invitation)
    if (subPath === '/invitations' && method === 'POST') {
      const auth = getAuthenticatedUser(headers, deps);
      deps.organizationStore.assertOwner(orgId, auth.userId);
      const data = body || {};
      const { email } = data as Record<string, any>;

      const result = deps.organizationStore.createInvitation(orgId, auth.userId, email);

      deps.identityAuditStore.recordEvent(auth.userId, 'invitation.created', 'SUCCESS', {
        ip: clientIp,
        userAgent,
        details: { organizationId: orgId, invitationId: result.invitation.invitationId, invitedEmail: result.invitation.email },
      });

      return {
        status: 201,
        data: {
          invitation: result.invitation,
          devInvitationToken: result.rawToken,
        },
      };
    }

    // 14. GET /api/v1/organizations/:orgId/invitations (List Invitations)
    if (subPath === '/invitations' && method === 'GET') {
      const auth = getAuthenticatedUser(headers, deps);
      deps.organizationStore.assertOwner(orgId, auth.userId);
      const invitations = deps.organizationStore.listInvitations(orgId);
      return { status: 200, data: { invitations } };
    }

    // 15. DELETE /api/v1/organizations/:orgId/invitations/:invId (Revoke Invitation)
    const invMatch = subPath.match(/^\/invitations\/([^/]+)$/);
    if (invMatch && method === 'DELETE') {
      const auth = getAuthenticatedUser(headers, deps);
      deps.organizationStore.assertOwner(orgId, auth.userId);
      const invId = decodeURIComponent(invMatch[1]);
      const inv = deps.organizationStore.revokeInvitation(orgId, invId);

      deps.identityAuditStore.recordEvent(auth.userId, 'invitation.revoked', 'SUCCESS', {
        ip: clientIp,
        userAgent,
        details: { organizationId: orgId, invitationId: invId },
      });

      return { status: 200, data: { invitation: inv } };
    }

    // ── Members & Owner Operations Routes ──
    // 17. GET /api/v1/organizations/:orgId/members (List Members)
    if (subPath === '/members' && method === 'GET') {
      const auth = getAuthenticatedUser(headers, deps);
      const callerMem = deps.organizationStore.assertMember(orgId, auth.userId);
      const members = deps.organizationStore.listMembers(orgId);

      // Hydrate with profile display names if identityStore is present
      const hydratedMembers = members.map((m) => {
        const profile = deps.identityStore.getProfile(m.userId);
        const identity = deps.identityStore.getByUserId(m.userId);
        return {
          ...m,
          displayName: profile?.displayName || identity?.email.split('@')[0] || 'Member',
          email: callerMem.role === 'OWNER' ? identity?.email : undefined,
        };
      });

      return { status: 200, data: { members: hydratedMembers } };
    }

    // 18. DELETE /api/v1/organizations/:orgId/members/:userId (Remove Member)
    const memMatch = subPath.match(/^\/members\/([^/]+)$/);
    if (memMatch && method === 'DELETE') {
      const auth = getAuthenticatedUser(headers, deps);
      deps.organizationStore.assertOwner(orgId, auth.userId);
      const targetUserId = decodeURIComponent(memMatch[1]);

      const mem = deps.organizationStore.removeMember(orgId, targetUserId, auth.userId);

      deps.identityAuditStore.recordEvent(auth.userId, 'member.removed', 'SUCCESS', {
        ip: clientIp,
        userAgent,
        details: { organizationId: orgId, targetUserId },
      });

      return { status: 200, data: { membership: mem } };
    }

    // 19. POST /api/v1/organizations/:orgId/leave (Leave Organization)
    if (subPath === '/leave' && method === 'POST') {
      const auth = getAuthenticatedUser(headers, deps);
      const mem = deps.organizationStore.leaveOrganization(orgId, auth.userId);

      deps.identityAuditStore.recordEvent(auth.userId, 'member.left', 'SUCCESS', {
        ip: clientIp,
        userAgent,
        details: { organizationId: orgId },
      });

      return { status: 200, data: { membership: mem } };
    }

    // 20. POST /api/v1/organizations/:orgId/transfer-owner (Transfer Ownership)
    if (subPath === '/transfer-owner' && method === 'POST') {
      const auth = getAuthenticatedUser(headers, deps);
      deps.organizationStore.assertOwner(orgId, auth.userId);
      const data = body || {};
      const { targetUserId } = data as Record<string, any>;

      if (!targetUserId || typeof targetUserId !== 'string') {
        throw new NagexError({ code: 'INVALID_INPUT', category: 'VALIDATION', message: 'Target user ID is required.' });
      }

      const result = deps.organizationStore.transferOwnership(orgId, auth.userId, targetUserId);

      deps.identityAuditStore.recordEvent(auth.userId, 'owner.transferred', 'SUCCESS', {
        ip: clientIp,
        userAgent,
        details: { organizationId: orgId, previousOwnerId: auth.userId, newOwnerId: targetUserId },
      });

      return {
        status: 200,
        data: {
          previousOwner: result.previousOwner,
          newOwner: result.newOwner,
        },
      };
    }

    return undefined;
  } catch (err: any) {
    if (err instanceof NagexError) {
      const statusMap: Record<string, number> = {
        AUTH_REQUIRED: 401,
        AUTH_SESSION_EXPIRED: 401,
        AUTH_ACCOUNT_DISABLED: 403,
        ORG_FORBIDDEN: 403,
        OWNER_REQUIRED: 403,
        EMAIL_MISMATCH: 403,
        LAST_OWNER_PROTECTION: 403,
        ORG_MUTATION_RESTRICTED: 403,
        ORG_NOT_FOUND: 404,
        WORKSPACE_NOT_FOUND: 404,
        INVITATION_NOT_FOUND: 404,
        MEMBER_NOT_FOUND: 404,
        INVITATION_ALREADY_EXISTS: 409,
        INVALID_INPUT: 400,
        INVALID_EMAIL: 400,
        INVALID_TOKEN: 400,
        INVALID_STATE: 400,
        INVITATION_EXPIRED: 400,
      };
      const status = statusMap[err.code] || 400;
      return { status, data: { error: { code: err.code, message: err.message } } };
    }
    return { status: 500, data: { error: { code: 'SERVER_ERROR', message: 'Internal server error.' } } };
  }
};
