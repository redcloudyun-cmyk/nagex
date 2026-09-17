// R16 §9, §21-26, §31-38 — JIT provisioning, explicit account linking,
// SCIM/tenant-scoped deprovisioning, and IdP group -> NAgex role mapping.
// Shared by both the OIDC and SAML login flows (and SCIM for
// deprovisioning) so the security invariants below are enforced in
// exactly one place, not duplicated per protocol.
import { NagexError } from '../common/errors.js';
import { generateResourceId } from '../common/utils.js';
import type { IdentityStore } from '../identity/identity.store.js';
import type { OrganizationStore } from '../organizations/organization.store.js';
import type { SessionStore } from '../sessions/session.store.js';
import { RbacStore, BUILTIN_ROLE_IDS } from '../rbac/rbac.store.js';
import type { EnterpriseIdentityStore } from './enterprise-identity.store.js';
import type { EnterpriseIdentityLinkRecord } from './enterprise-identity.types.js';

export interface ProvisioningDeps {
  identityStore: IdentityStore;
  organizationStore: OrganizationStore;
  sessionStore: SessionStore;
  rbacStore: RbacStore;
  enterpriseIdentityStore: EnterpriseIdentityStore;
}

export interface ResolveEnterpriseLoginParams {
  organizationId: string;
  providerId: string;
  providerType: 'oidc' | 'saml';
  externalSubject: string;
  externalEmail: string;
  groupNames?: string[];
}

export interface ResolveEnterpriseLoginResult {
  userId: string;
  membershipCreated: boolean;
  link: EnterpriseIdentityLinkRecord;
}

// §9's full flow, minus the outer transport-specific steps (redirect,
// state validation, token/assertion validation) which each protocol's own
// service handles BEFORE calling this — by the time this function runs,
// the caller has already cryptographically proven the user's identity
// with the configured IdP. This function only ever does identity
// mapping -> membership resolution; it is never itself an authentication
// step.
export function resolveEnterpriseLogin(deps: ProvisioningDeps, params: ResolveEnterpriseLoginParams): ResolveEnterpriseLoginResult {
  const { organizationId, providerId, externalSubject, externalEmail, groupNames } = params;

  // §26 — the provider+subject unique constraint is the FIRST thing
  // checked: a subject already linked to a user always resolves to that
  // exact user, regardless of what email the IdP asserts this time (an
  // IdP-side email change must never silently move an internal account).
  const existingLink = deps.enterpriseIdentityStore.findLinkByProviderSubject(providerId, externalSubject);
  if (existingLink) {
    if (existingLink.organizationId !== organizationId) {
      // Defense in depth — findLinkByProviderSubject is already
      // implicitly org-scoped because providerId itself only ever
      // belongs to one organization (§5), but this makes the invariant
      // explicit and fails closed if that ever stops being true.
      throw new NagexError({ code: 'ENTERPRISE_IDENTITY_TENANT_MISMATCH', category: 'AUTHORIZATION', message: 'This identity link does not belong to the requested organization.' });
    }
    const membership = deps.organizationStore.getMembership(organizationId, existingLink.userId);
    if (!membership) {
      // §32/§57 — the membership was explicitly removed (deprovisioned)
      // at some point. A successful SSO login must NEVER silently
      // resurrect it — that would undo deprovisioning through the very
      // channel deprovisioning is supposed to close off.
      const anyStatus = deps.organizationStore.getMembershipAnyStatus(organizationId, existingLink.userId);
      if (anyStatus && anyStatus.status !== 'ACTIVE') {
        throw new NagexError({ code: 'ENTERPRISE_IDENTITY_MEMBERSHIP_REMOVED', category: 'AUTHORIZATION', message: 'This account\'s membership in this organization has been removed and is not automatically restored by SSO login.' });
      }
      throw new NagexError({ code: 'ENTERPRISE_IDENTITY_NO_MEMBERSHIP', category: 'AUTHORIZATION', message: 'This identity is not a member of this organization.' });
    }
    existingLink.lastLoginAt = new Date().toISOString();
    deps.enterpriseIdentityStore.saveLink(existingLink);
    applyGroupRoleMappings(deps, organizationId, providerId, existingLink.userId, membership.membershipId, groupNames ?? []);
    return { userId: existingLink.userId, membershipCreated: false, link: existingLink };
  }

  // No link yet — this is either a brand-new user (JIT) or an existing
  // local account with the same email (§24: never silently merge).
  const ssoPolicy = deps.enterpriseIdentityStore.getSsoPolicy(organizationId);
  if (!ssoPolicy?.jitProvisioningEnabled) {
    throw new NagexError({ code: 'ENTERPRISE_IDENTITY_JIT_DISABLED', category: 'AUTHORIZATION', message: 'This organization does not allow automatic provisioning on first SSO login. An administrator must invite this user first.' });
  }

  const existingIdentity = deps.identityStore.getByEmail(externalEmail);
  if (existingIdentity) {
    // §24 — a same-email existing account is never auto-linked. The user
    // must sign in to their existing account and use the explicit,
    // authenticated linkEnterpriseIdentity() flow (§25) instead.
    throw new NagexError({ code: 'ENTERPRISE_IDENTITY_LINK_REQUIRED', category: 'AUTHORIZATION', message: 'An account with this email already exists. Sign in and link your enterprise identity from Account Settings instead of using SSO directly.' });
  }

  const { identity } = deps.identityStore.createEnterpriseAccount(externalEmail, params.providerType);
  const link = deps.enterpriseIdentityStore.createLink({ organizationId, userId: identity.userId, providerId, externalSubject, externalEmail, lastLoginAt: new Date().toISOString() });

  // §22 — JIT default role is ALWAYS MEMBER (or the organization's
  // configured default role, which is itself validated at write time —
  // see setSsoPolicyDefaultRole below — to never be OWNER/ADMIN-holding
  // an org.delete-class permission). Never OWNER, never ADMIN by default.
  const membership = deps.organizationStore.addMember(organizationId, identity.userId, 'MEMBER');
  const defaultRoleId = ssoPolicy.defaultRoleId || BUILTIN_ROLE_IDS.MEMBER;
  if (defaultRoleId !== BUILTIN_ROLE_IDS.MEMBER) {
    assertNotOwnerRole(defaultRoleId, 'JIT default role');
    deps.rbacStore.saveRoleBinding({
      roleBindingId: generateResourceId('rb'),
      organizationId,
      workspaceId: null,
      membershipId: membership.membershipId,
      userId: identity.userId,
      roleId: defaultRoleId,
      createdByUserId: 'system:jit',
      createdAt: new Date().toISOString(),
    });
  }

  applyGroupRoleMappings(deps, organizationId, providerId, identity.userId, membership.membershipId, groupNames ?? []);

  return { userId: identity.userId, membershipCreated: true, link };
}

// §25 — explicit linking flow: only ever called from a route that has
// already re-verified the caller has an authenticated existing session
// (i.e. callerUserId is the CURRENTLY SIGNED IN user, not an arbitrary
// parameter derived from IdP-asserted data) AND the IdP login the caller
// just completed. This function itself only enforces §26 (no duplicate
// subject) — the "authenticated existing session" requirement is the
// HTTP route's responsibility, matching how every other session-gated
// route in this codebase works (getAuthenticatedUser() first, business
// logic second).
export function linkEnterpriseIdentity(deps: ProvisioningDeps, params: { organizationId: string; callerUserId: string; providerId: string; externalSubject: string; externalEmail: string }): EnterpriseIdentityLinkRecord {
  const existing = deps.enterpriseIdentityStore.findLinkByProviderSubject(params.providerId, params.externalSubject);
  if (existing) {
    throw new NagexError({ code: 'ENTERPRISE_IDENTITY_ALREADY_LINKED', category: 'CONFLICT', message: 'This external identity is already linked to a NAgex account.' });
  }
  return deps.enterpriseIdentityStore.createLink({
    organizationId: params.organizationId,
    userId: params.callerUserId,
    providerId: params.providerId,
    externalSubject: params.externalSubject,
    externalEmail: params.externalEmail,
    lastLoginAt: new Date().toISOString(),
  });
}

function assertNotOwnerRole(roleId: string, context: string): void {
  if (roleId === BUILTIN_ROLE_IDS.OWNER) {
    throw new NagexError({ code: 'ENTERPRISE_IDENTITY_OWNER_MAPPING_BLOCKED', category: 'AUTHORIZATION', message: `${context} may never resolve to the OWNER role — OWNER can only change via the R14 owner-transfer flow.` });
  }
}

// §36-38, §58 — an IdP group asserted on the token/assertion maps to a
// NAgex role ONLY if an administrator has explicitly created that
// mapping for THIS provider in THIS organization. Unmapped group names
// are silently ignored (not an error — most IdP group claims are noise
// unrelated to NAgex roles). The OWNER-mapping guard is enforced both
// here (defense in depth) and at group-mapping CREATE time.
function applyGroupRoleMappings(deps: ProvisioningDeps, organizationId: string, providerId: string, userId: string, membershipId: string, groupNames: string[]): void {
  if (groupNames.length === 0) return;
  const mappings = deps.enterpriseIdentityStore.listGroupMappings(organizationId, providerId).filter((m) => groupNames.includes(m.externalGroupName));
  for (const mapping of mappings) {
    assertNotOwnerRole(mapping.roleId, 'Group role mapping');
    const alreadyBound = deps.rbacStore
      .listRoleBindingsByMembership(organizationId, membershipId)
      .some((b) => b.roleId === mapping.roleId && b.workspaceId === null);
    if (alreadyBound) continue;
    deps.rbacStore.saveRoleBinding({
      roleBindingId: generateResourceId('rb'),
      organizationId,
      workspaceId: null,
      membershipId,
      userId,
      roleId: mapping.roleId,
      createdByUserId: `system:group-mapping:${providerId}`,
      createdAt: new Date().toISOString(),
    });
  }
}

// §31-34 — SCIM/administrator-initiated deprovisioning. Tenant-scoped by
// construction: only ever touches ORG-scoped membership + ORG-scoped
// sessions for the ONE organization being deprovisioned, never the user's
// global account or their membership in any other organization (§32).
export function deprovisionOrganizationMember(deps: ProvisioningDeps, params: { organizationId: string; targetUserId: string; requestingActor: string }): void {
  const membership = deps.organizationStore.getMembership(params.organizationId, params.targetUserId);
  if (membership) {
    deps.organizationStore.removeMember(params.organizationId, params.targetUserId, params.requestingActor);
  }
  deps.rbacStore
    .listRoleBindings(params.organizationId, params.targetUserId)
    .forEach((b) => deps.rbacStore.deleteRoleBinding(b.roleBindingId));
  // §33 — revoke only sessions scoped to this organization (tenantId),
  // never a global revoke (§34 reserves global revoke for account
  // compromise / global identity disable / password reset — none of
  // which apply to an ordinary tenant-scoped SCIM deprovision).
  deps.sessionStore.revokeAllUserSessions(params.organizationId, params.targetUserId);
}
