// R16 §27-37 — SCIM 2.0 protocol endpoints. Deliberately does NOT import
// or call getAuthenticatedUser from enterprise-identity.routes.ts — SCIM
// clients authenticate with a bearer token scoped to ONE organization's
// ScimTokenRecord, never a session cookie, never a userId. The
// organizationId a SCIM request acts on is resolved ENTIRELY from which
// token was presented, never trusted from the URL/body alone (closing off
// the "foreign organization token" attack class in §56/§59).
import crypto from 'node:crypto';
import { NagexError } from '../../common/errors.js';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';
import { EnterpriseIdentityStore, hashSecret } from '../../enterprise-identity/enterprise-identity.store.js';
import * as scim from '../../enterprise-identity/scim.service.js';
import type { ScimDeps } from '../../enterprise-identity/scim.service.js';
import type { AuditLogger } from '../../governance/audit.logger.js';

export interface ScimRoutesDependencies extends ScimDeps {
  enterpriseIdentityStore: EnterpriseIdentityStore;
  auditLogger: AuditLogger;
}

function getBearerToken(headers: Record<string, string | string[] | undefined>): string | null {
  const authHeader = Array.isArray(headers['authorization']) ? headers['authorization'][0] : headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) return authHeader.substring(7).trim();
  return null;
}

function authenticateScimRequest(headers: Record<string, string | string[] | undefined>, deps: ScimRoutesDependencies): { organizationId: string } {
  const rawToken = getBearerToken(headers);
  if (!rawToken) {
    throw new NagexError({ code: 'SCIM_UNAUTHORIZED', category: 'AUTHENTICATION', message: 'A bearer token is required.' });
  }
  const record = deps.enterpriseIdentityStore.findActiveTokenByHash(hashSecret(rawToken));
  if (!record) {
    throw new NagexError({ code: 'SCIM_UNAUTHORIZED', category: 'AUTHENTICATION', message: 'Invalid or revoked SCIM token.' });
  }
  const policy = deps.enterpriseIdentityStore.getSsoPolicy(record.organizationId);
  if (!policy?.scimEnabled) {
    throw new NagexError({ code: 'SCIM_DISABLED', category: 'AUTHORIZATION', message: 'SCIM provisioning is not enabled for this organization.' });
  }
  return { organizationId: record.organizationId };
}

function scimError(status: number, detail: string): ApiResult {
  return { status, data: { schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], detail, status: String(status) } };
}

export const handleScimRoutes: AsyncRouteRegistrar<ScimRoutesDependencies> = async (method, pathname, body, headers, _query, deps): Promise<ApiResult | undefined> => {
  if (!pathname.startsWith('/scim/v2/')) return undefined;

  let auth: { organizationId: string };
  try {
    auth = authenticateScimRequest(headers, deps);
  } catch (error) {
    if (error instanceof NagexError) return scimError(error.category === 'AUTHENTICATION' ? 401 : 403, error.message);
    return scimError(401, 'Unauthorized.');
  }
  const { organizationId } = auth;

  const runOrScimError = (fn: () => unknown, requestId: string): ApiResult | undefined => {
    try {
      return { status: 200, data: fn() };
    } catch (error) {
      if (error instanceof NagexError) {
        const status = error.category === 'NOT_FOUND' ? 404 : error.category === 'VALIDATION' ? 400 : error.category === 'CONFLICT' ? 409 : 400;
        return scimError(status, error.message);
      }
      return scimError(500, 'Internal error.');
    }
  };

  // ── Users ──
  if (pathname === '/scim/v2/Users' && method === 'POST') {
    try {
      const user = scim.createScimUser(deps, organizationId, (body ?? {}) as Record<string, unknown>);
      deps.auditLogger.logEvent({ actor: { type: 'system', id: 'scim' }, tenant_id: organizationId, action: 'scim.user.created', resource: { type: 'user', id: String((user as any).id) }, result: 'SUCCESS', request_id: `req_scim_${crypto.randomUUID()}` });
      return { status: 201, data: user };
    } catch (error) {
      return error instanceof NagexError ? scimError(400, error.message) : scimError(500, 'Internal error.');
    }
  }
  if (pathname === '/scim/v2/Users' && method === 'GET') {
    return runOrScimError(() => scim.listScimUsers(deps, organizationId), 'req_scim_list');
  }
  let match = pathname.match(/^\/scim\/v2\/Users\/([^/]+)$/);
  if (match) {
    const [, userId] = match;
    if (method === 'GET') return runOrScimError(() => scim.getScimUser(deps, organizationId, userId), 'req_scim_get');
    if (method === 'PATCH') {
      const result = runOrScimError(() => scim.patchScimUser(deps, organizationId, userId, (body ?? {}) as Record<string, unknown>), 'req_scim_patch');
      if (result && result.status === 200) {
        deps.auditLogger.logEvent({ actor: { type: 'system', id: 'scim' }, tenant_id: organizationId, action: (body as any)?.active === false ? 'scim.user.deprovisioned' : 'scim.user.updated', resource: { type: 'user', id: userId }, result: 'SUCCESS', request_id: `req_scim_${crypto.randomUUID()}` });
      }
      return result;
    }
    if (method === 'DELETE') {
      try {
        scim.deleteScimUser(deps, organizationId, userId);
        deps.auditLogger.logEvent({ actor: { type: 'system', id: 'scim' }, tenant_id: organizationId, action: 'scim.user.deprovisioned', resource: { type: 'user', id: userId }, result: 'SUCCESS', request_id: `req_scim_${crypto.randomUUID()}` });
        return { status: 204, data: null };
      } catch (error) {
        return error instanceof NagexError ? scimError(404, error.message) : scimError(500, 'Internal error.');
      }
    }
  }

  // ── Groups ──
  if (pathname === '/scim/v2/Groups' && method === 'POST') {
    try {
      const group = scim.createScimGroup(deps, organizationId, (body ?? {}) as Record<string, unknown>);
      deps.auditLogger.logEvent({ actor: { type: 'system', id: 'scim' }, tenant_id: organizationId, action: 'scim.group.created', resource: { type: 'group', id: String((group as any).id) }, result: 'SUCCESS', request_id: `req_scim_${crypto.randomUUID()}` });
      return { status: 201, data: group };
    } catch (error) {
      return error instanceof NagexError ? scimError(400, error.message) : scimError(500, 'Internal error.');
    }
  }
  if (pathname === '/scim/v2/Groups' && method === 'GET') {
    return runOrScimError(() => scim.listScimGroups(deps, organizationId), 'req_scim_grp_list');
  }
  match = pathname.match(/^\/scim\/v2\/Groups\/([^/]+)$/);
  if (match) {
    const [, groupId] = match;
    if (method === 'PATCH') {
      const result = runOrScimError(() => scim.patchScimGroup(deps, organizationId, groupId, (body ?? {}) as Record<string, unknown>), 'req_scim_grp_patch');
      if (result && result.status === 200) {
        deps.auditLogger.logEvent({ actor: { type: 'system', id: 'scim' }, tenant_id: organizationId, action: 'scim.group.updated', resource: { type: 'group', id: groupId }, result: 'SUCCESS', request_id: `req_scim_${crypto.randomUUID()}` });
      }
      return result;
    }
    if (method === 'DELETE') {
      try {
        scim.deleteScimGroup(deps, organizationId, groupId);
        deps.auditLogger.logEvent({ actor: { type: 'system', id: 'scim' }, tenant_id: organizationId, action: 'scim.group.deleted', resource: { type: 'group', id: groupId }, result: 'SUCCESS', request_id: `req_scim_${crypto.randomUUID()}` });
        return { status: 204, data: null };
      } catch (error) {
        return error instanceof NagexError ? scimError(404, error.message) : scimError(500, 'Internal error.');
      }
    }
  }

  return undefined;
};
