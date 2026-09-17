// R16 §27-37 — SCIM 2.0 Users/Groups, mapped onto the existing
// IdentityRecord/ProfileRecord/MembershipRecord triple (§30 — the
// external SCIM id is never used as the internal user_id; internal ids
// are always NAgex-generated and returned as the SCIM "id" field).
import { NagexError } from '../common/errors.js';
import type { IdentityStore } from '../identity/identity.store.js';
import type { OrganizationStore } from '../organizations/organization.store.js';
import type { SessionStore } from '../sessions/session.store.js';
import type { RbacStore } from '../rbac/rbac.store.js';
import type { EnterpriseIdentityStore } from './enterprise-identity.store.js';
import { deprovisionOrganizationMember, type ProvisioningDeps } from './provisioning.service.js';

export interface ScimDeps extends ProvisioningDeps {
  identityStore: IdentityStore;
  organizationStore: OrganizationStore;
  sessionStore: SessionStore;
  rbacStore: RbacStore;
  enterpriseIdentityStore: EnterpriseIdentityStore;
}

const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';

function toScimUser(organizationId: string, deps: ScimDeps, userId: string): Record<string, unknown> | null {
  const identity = deps.identityStore.getByUserId(userId);
  if (!identity) return null;
  const membership = deps.organizationStore.getMembership(organizationId, userId);
  const profile = deps.identityStore.getProfile(userId);
  return {
    schemas: [USER_SCHEMA],
    id: userId,
    userName: identity.email,
    displayName: profile?.displayName ?? identity.email,
    emails: [{ value: identity.email, primary: true }],
    active: Boolean(membership && membership.status === 'ACTIVE'),
    meta: { resourceType: 'User', created: identity.createdAt, lastModified: membership?.updatedAt ?? identity.createdAt },
  };
}

function extractEmail(scimBody: Record<string, unknown>): string | null {
  const emails = scimBody.emails as Array<{ value?: string; primary?: boolean }> | undefined;
  if (Array.isArray(emails) && emails.length > 0) {
    const primary = emails.find((e) => e.primary) ?? emails[0];
    if (primary?.value) return primary.value;
  }
  if (typeof scimBody.userName === 'string' && scimBody.userName.includes('@')) return scimBody.userName;
  return null;
}

// §29 POST /scim/v2/Users — idempotent-by-email: if an identity with this
// email already exists (created earlier by this same SCIM client or by
// JIT/local signup), membership is created/ensured rather than a
// duplicate identity — SCIM clients commonly retry creates, and RFC 7644
// treats a duplicate userName as a 409, which "reuse the existing
// identity, ensure membership" achieves without erroring on legitimate
// retries. §30 — the SCIM caller's own external id (if any) is never
// treated as the internal id; only the NAgex-generated userId is.
export function createScimUser(deps: ScimDeps, organizationId: string, scimBody: Record<string, unknown>): Record<string, unknown> {
  const email = extractEmail(scimBody);
  if (!email) {
    throw new NagexError({ code: 'SCIM_INVALID_USER', category: 'VALIDATION', message: 'SCIM User must include userName or an emails[] entry.' });
  }
  let identity = deps.identityStore.getByEmail(email);
  if (!identity) {
    identity = deps.identityStore.createEnterpriseAccount(email, 'scim').identity;
  }
  const existingMembership = deps.organizationStore.getMembership(organizationId, identity.userId);
  if (!existingMembership) {
    deps.organizationStore.addMember(organizationId, identity.userId, 'MEMBER');
  }
  const active = scimBody.active !== false;
  if (!active) {
    deprovisionOrganizationMember(deps, { organizationId, targetUserId: identity.userId, requestingActor: 'system:scim' });
  }
  return toScimUser(organizationId, deps, identity.userId)!;
}

export function getScimUser(deps: ScimDeps, organizationId: string, userId: string): Record<string, unknown> {
  const resource = toScimUser(organizationId, deps, userId);
  if (!resource) {
    throw new NagexError({ code: 'SCIM_USER_NOT_FOUND', category: 'NOT_FOUND', message: `User ${userId} was not found.` });
  }
  // §30/§56 cross-tenant guard: a user that exists globally but has no
  // membership record at all (never was, or a different org entirely) in
  // THIS organization must read as not-found from THIS org's SCIM
  // endpoint, not as a real (inactive) user — otherwise a SCIM token
  // scoped to org A could enumerate users of org B by id.
  const membership = deps.organizationStore.getMembershipAnyStatus(organizationId, userId);
  if (!membership) {
    throw new NagexError({ code: 'SCIM_USER_NOT_FOUND', category: 'NOT_FOUND', message: `User ${userId} was not found.` });
  }
  return resource;
}

export function listScimUsers(deps: ScimDeps, organizationId: string): Record<string, unknown> {
  const members = deps.organizationStore.listMembers(organizationId);
  const resources = members.map((m) => toScimUser(organizationId, deps, m.userId)).filter((r): r is Record<string, unknown> => r !== null);
  return { schemas: [LIST_SCHEMA], totalResults: resources.length, itemsPerPage: resources.length, startIndex: 1, Resources: resources };
}

export function patchScimUser(deps: ScimDeps, organizationId: string, userId: string, scimBody: Record<string, unknown>): Record<string, unknown> {
  // Ensure this user is genuinely a member of THIS org before mutating —
  // same cross-tenant guard as getScimUser.
  getScimUser(deps, organizationId, userId);

  const operations = (scimBody.Operations as Array<{ op?: string; path?: string; value?: unknown }> | undefined) ?? [];
  const directActive = scimBody.active;
  const activeFromOps = operations.find((op) => op.path === 'active')?.value;
  const active = typeof directActive === 'boolean' ? directActive : typeof activeFromOps === 'boolean' ? activeFromOps : undefined;

  if (active === false) {
    // §31 — the deprovision path: tenant-scoped membership disable +
    // tenant-scoped session revoke, never a global account delete (§32).
    deprovisionOrganizationMember(deps, { organizationId, targetUserId: userId, requestingActor: 'system:scim' });
  } else if (active === true) {
    const membership = deps.organizationStore.getMembershipAnyStatus(organizationId, userId);
    if (membership && membership.status !== 'ACTIVE') {
      deps.organizationStore.addMember(organizationId, userId, 'MEMBER');
    }
  }
  return toScimUser(organizationId, deps, userId) ?? { schemas: [USER_SCHEMA], id: userId, active: false };
}

export function deleteScimUser(deps: ScimDeps, organizationId: string, userId: string): void {
  getScimUser(deps, organizationId, userId); // cross-tenant existence guard
  deprovisionOrganizationMember(deps, { organizationId, targetUserId: userId, requestingActor: 'system:scim' });
}

// ── Groups ──

function toScimGroup(deps: ScimDeps, organizationId: string, scimGroupId: string): Record<string, unknown> | null {
  const record = deps.enterpriseIdentityStore.getOwnedScimGroup(scimGroupId, organizationId);
  if (!record) return null;
  return {
    schemas: [GROUP_SCHEMA],
    id: record.scimGroupId,
    displayName: record.displayName,
    members: record.memberUserIds.map((uid) => ({ value: uid })),
    meta: { resourceType: 'Group', created: record.createdAt, lastModified: record.updatedAt },
  };
}

export function createScimGroup(deps: ScimDeps, organizationId: string, scimBody: Record<string, unknown>): Record<string, unknown> {
  const displayName = typeof scimBody.displayName === 'string' ? scimBody.displayName : null;
  if (!displayName) {
    throw new NagexError({ code: 'SCIM_INVALID_GROUP', category: 'VALIDATION', message: 'SCIM Group must include displayName.' });
  }
  const record = deps.enterpriseIdentityStore.createScimGroup(organizationId, displayName);
  const members = (scimBody.members as Array<{ value?: string }> | undefined) ?? [];
  if (members.length > 0) {
    record.memberUserIds = members.map((m) => m.value).filter((v): v is string => typeof v === 'string');
    deps.enterpriseIdentityStore.saveScimGroup(record);
  }
  return toScimGroup(deps, organizationId, record.scimGroupId)!;
}

export function listScimGroups(deps: ScimDeps, organizationId: string): Record<string, unknown> {
  const resources = deps.enterpriseIdentityStore.listScimGroups(organizationId).map((g) => toScimGroup(deps, organizationId, g.scimGroupId)!);
  return { schemas: [LIST_SCHEMA], totalResults: resources.length, itemsPerPage: resources.length, startIndex: 1, Resources: resources };
}

export function patchScimGroup(deps: ScimDeps, organizationId: string, scimGroupId: string, scimBody: Record<string, unknown>): Record<string, unknown> {
  const record = deps.enterpriseIdentityStore.getOwnedScimGroup(scimGroupId, organizationId);
  if (!record) {
    throw new NagexError({ code: 'SCIM_GROUP_NOT_FOUND', category: 'NOT_FOUND', message: `Group ${scimGroupId} was not found.` });
  }
  const operations = (scimBody.Operations as Array<{ op?: string; path?: string; value?: unknown }> | undefined) ?? [];
  for (const op of operations) {
    const action = (op.op ?? '').toLowerCase();
    const values = Array.isArray(op.value) ? op.value : op.value ? [op.value] : [];
    const userIds = values.map((v: any) => (typeof v === 'string' ? v : v?.value)).filter((v: unknown): v is string => typeof v === 'string');
    if (op.path === 'members' || !op.path) {
      if (action === 'add') {
        for (const uid of userIds) if (!record.memberUserIds.includes(uid)) record.memberUserIds.push(uid);
      } else if (action === 'remove') {
        record.memberUserIds = record.memberUserIds.filter((uid) => !userIds.includes(uid));
      }
    }
  }
  if (typeof scimBody.displayName === 'string') record.displayName = scimBody.displayName;
  deps.enterpriseIdentityStore.saveScimGroup(record);
  return toScimGroup(deps, organizationId, scimGroupId)!;
}

export function deleteScimGroup(deps: ScimDeps, organizationId: string, scimGroupId: string): void {
  const record = deps.enterpriseIdentityStore.getOwnedScimGroup(scimGroupId, organizationId);
  if (!record) {
    throw new NagexError({ code: 'SCIM_GROUP_NOT_FOUND', category: 'NOT_FOUND', message: `Group ${scimGroupId} was not found.` });
  }
  deps.enterpriseIdentityStore.deleteScimGroup(scimGroupId);
}
