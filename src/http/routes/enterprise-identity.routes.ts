// R16 — Enterprise Identity Federation & Provisioning HTTP routes.
// Session-authenticated administration endpoints (§51's first five
// groups) plus the OIDC/SAML redirect + callback flow. SCIM's own
// /scim/v2/* endpoints live in a separate route module (scim.routes.ts)
// because they use bearer-token authentication, not session cookies —
// deliberately never sharing getAuthenticatedUser with this file.
import crypto from 'node:crypto';
import { NagexError } from '../../common/errors.js';
import type { RbacService } from '../../rbac/rbac.service.js';
import type { OrganizationStore } from '../../organizations/organization.store.js';
import type { IdentityStore } from '../../identity/identity.store.js';
import type { SessionStore } from '../../sessions/session.store.js';
import type { RbacStore } from '../../rbac/rbac.store.js';
import { PERMISSIONS } from '../../rbac/rbac.types.js';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';
import { EnterpriseIdentityStore, hashSecret, encryptClientSecret, decryptClientSecret } from '../../enterprise-identity/enterprise-identity.store.js';
import { SsoFlowStore } from '../../enterprise-identity/sso-flow.store.js';
import * as oidc from '../../enterprise-identity/oidc.service.js';
import * as saml from '../../enterprise-identity/saml.service.js';
import * as domainService from '../../enterprise-identity/domain.service.js';
import { resolveEnterpriseLogin, linkEnterpriseIdentity } from '../../enterprise-identity/provisioning.service.js';
import { BUILTIN_ROLE_IDS } from '../../rbac/rbac.store.js';
import type { AuditLogger } from '../../governance/audit.logger.js';

export interface EnterpriseIdentityRoutesDependencies {
  rbacService: RbacService;
  organizationStore: OrganizationStore;
  identityStore: IdentityStore;
  sessionStore: SessionStore;
  rbacStore: RbacStore;
  enterpriseIdentityStore: EnterpriseIdentityStore;
  ssoFlowStore: SsoFlowStore;
  auditLogger: AuditLogger;
  fetchFn: typeof fetch;
  publicBaseUrl: string; // used to build redirect_uri / ACS URL / SP entityId
}

const COOKIE_HEADER = (sessionId: string) => ({ 'Set-Cookie': `nagex_session=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax` });

function getSessionIdFromHeaders(headers: Record<string, string | string[] | undefined>): string | null {
  const cookieHeader = Array.isArray(headers['cookie']) ? headers['cookie'][0] : headers['cookie'];
  if (cookieHeader) {
    const match = cookieHeader.match(/nagex_session=([^;]+)/);
    if (match) return decodeURIComponent(match[1]);
  }
  const authHeader = Array.isArray(headers['authorization']) ? headers['authorization'][0] : headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) return authHeader.substring(7).trim();
  return null;
}

function getAuthenticatedUser(headers: Record<string, string | string[] | undefined>, deps: EnterpriseIdentityRoutesDependencies): { userId: string; email: string } {
  const sessionId = getSessionIdFromHeaders(headers);
  if (!sessionId) throw new NagexError({ code: 'AUTH_REQUIRED', category: 'AUTHENTICATION', message: 'Authentication required.' });
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

function redactProviderForResponse(provider: ReturnType<EnterpriseIdentityStore['getProvider']>): unknown {
  if (!provider) return null;
  return {
    ...provider,
    oidcConfig: provider.oidcConfig ? { ...provider.oidcConfig, clientSecretEncrypted: undefined, hasClientSecret: true } : null,
  };
}

export const handleEnterpriseIdentityRoutes: AsyncRouteRegistrar<EnterpriseIdentityRoutesDependencies> = async (method, pathname, body, headers, query, deps): Promise<ApiResult | undefined> => {
  // ── Identity Providers ──
  let match = pathname.match(/^\/api\/(?:v1\/)?organizations\/([^/]+)\/identity-providers$/);
  if (match) {
    const [, organizationId] = match;
    const user = getAuthenticatedUser(headers, deps);
    if (method === 'GET') {
      deps.rbacService.authorize({ userId: user.userId, organizationId, permissionKey: PERMISSIONS.IDENTITY_PROVIDER_READ });
      const providers = deps.enterpriseIdentityStore.listProviders(organizationId).map(redactProviderForResponse);
      return { status: 200, data: { providers } };
    }
    if (method === 'POST') {
      deps.rbacService.authorize({ userId: user.userId, organizationId, permissionKey: PERMISSIONS.IDENTITY_PROVIDER_MANAGE });
      const input = (body ?? {}) as Record<string, any>;
      if (!input.providerType || (input.providerType !== 'OIDC' && input.providerType !== 'SAML')) {
        throw new NagexError({ code: 'INVALID_INPUT', category: 'VALIDATION', message: 'providerType must be OIDC or SAML.' });
      }
      let oidcConfig = null;
      let samlConfig = null;
      if (input.providerType === 'OIDC') {
        const c = input.oidcConfig ?? {};
        if (!c.issuer || !c.clientId || !c.clientSecret || !c.authorizationEndpoint || !c.tokenEndpoint || !c.jwksUri) {
          throw new NagexError({ code: 'INVALID_INPUT', category: 'VALIDATION', message: 'OIDC provider requires issuer, clientId, clientSecret, authorizationEndpoint, tokenEndpoint, jwksUri.' });
        }
        oidcConfig = {
          issuer: c.issuer,
          clientId: c.clientId,
          clientSecretEncrypted: encryptClientSecret(c.clientSecret),
          authorizationEndpoint: c.authorizationEndpoint,
          tokenEndpoint: c.tokenEndpoint,
          jwksUri: c.jwksUri,
          scopes: Array.isArray(c.scopes) && c.scopes.length > 0 ? c.scopes : ['openid', 'email', 'profile'],
        };
      } else {
        const c = input.samlConfig ?? {};
        if (!c.entityId || !c.ssoUrl || !c.x509Certificate) {
          throw new NagexError({ code: 'INVALID_INPUT', category: 'VALIDATION', message: 'SAML provider requires entityId, ssoUrl, x509Certificate.' });
        }
        samlConfig = { entityId: c.entityId, ssoUrl: c.ssoUrl, x509Certificate: c.x509Certificate, nameIdFormat: c.nameIdFormat ?? 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress', attributeMappings: c.attributeMappings ?? {} };
      }
      const provider = deps.enterpriseIdentityStore.createProvider({
        organizationId,
        providerType: input.providerType,
        name: typeof input.name === 'string' && input.name.trim() ? input.name.trim() : input.providerType,
        status: 'DRAFT',
        oidcConfig,
        samlConfig,
        createdByUserId: user.userId,
      });
      deps.auditLogger.logEvent({ actor: { type: 'user', id: user.userId }, tenant_id: organizationId, action: 'idp.created', resource: { type: 'identity_provider', id: provider.providerId }, result: 'SUCCESS', request_id: `req_idp_${Date.now()}` });
      return { status: 201, data: { provider: redactProviderForResponse(provider) } };
    }
  }

  match = pathname.match(/^\/api\/(?:v1\/)?organizations\/([^/]+)\/identity-providers\/([^/]+)$/);
  if (match) {
    const [, organizationId, providerId] = match;
    const user = getAuthenticatedUser(headers, deps);
    if (method === 'GET') {
      deps.rbacService.authorize({ userId: user.userId, organizationId, permissionKey: PERMISSIONS.IDENTITY_PROVIDER_READ });
      const provider = deps.enterpriseIdentityStore.getOwnedProvider(providerId, organizationId);
      if (!provider) throw new NagexError({ code: 'IDENTITY_PROVIDER_NOT_FOUND', category: 'NOT_FOUND', message: 'Identity provider not found.' });
      return { status: 200, data: { provider: redactProviderForResponse(provider) } };
    }
    if (method === 'PATCH') {
      deps.rbacService.authorize({ userId: user.userId, organizationId, permissionKey: PERMISSIONS.IDENTITY_PROVIDER_MANAGE });
      const provider = deps.enterpriseIdentityStore.getOwnedProvider(providerId, organizationId);
      if (!provider) throw new NagexError({ code: 'IDENTITY_PROVIDER_NOT_FOUND', category: 'NOT_FOUND', message: 'Identity provider not found.' });
      const input = (body ?? {}) as Record<string, any>;
      if (typeof input.name === 'string' && input.name.trim()) provider.name = input.name.trim();
      if (provider.providerType === 'SAML' && input.samlConfig) {
        provider.samlConfig = { ...provider.samlConfig!, ...input.samlConfig };
      }
      if (provider.providerType === 'OIDC' && input.oidcConfig) {
        const c = input.oidcConfig;
        provider.oidcConfig = {
          ...provider.oidcConfig!,
          ...c,
          clientSecretEncrypted: c.clientSecret ? encryptClientSecret(c.clientSecret) : provider.oidcConfig!.clientSecretEncrypted,
        };
      }
      provider.updatedAt = new Date().toISOString();
      deps.enterpriseIdentityStore.saveProvider(provider);
      deps.auditLogger.logEvent({ actor: { type: 'user', id: user.userId }, tenant_id: organizationId, action: 'idp.updated', resource: { type: 'identity_provider', id: providerId }, result: 'SUCCESS', request_id: `req_idp_${Date.now()}` });
      return { status: 200, data: { provider: redactProviderForResponse(provider) } };
    }
    if (method === 'DELETE') {
      deps.rbacService.authorize({ userId: user.userId, organizationId, permissionKey: PERMISSIONS.IDENTITY_PROVIDER_MANAGE });
      const provider = deps.enterpriseIdentityStore.getOwnedProvider(providerId, organizationId);
      if (!provider) throw new NagexError({ code: 'IDENTITY_PROVIDER_NOT_FOUND', category: 'NOT_FOUND', message: 'Identity provider not found.' });
      deps.enterpriseIdentityStore.deleteProvider(providerId);
      return { status: 200, data: { success: true } };
    }
  }

  match = pathname.match(/^\/api\/(?:v1\/)?organizations\/([^/]+)\/identity-providers\/([^/]+)\/(enable|disable)$/);
  if (match && method === 'POST') {
    const [, organizationId, providerId, action] = match;
    const user = getAuthenticatedUser(headers, deps);
    deps.rbacService.authorize({ userId: user.userId, organizationId, permissionKey: PERMISSIONS.IDENTITY_PROVIDER_MANAGE });
    const provider = deps.enterpriseIdentityStore.getOwnedProvider(providerId, organizationId);
    if (!provider) throw new NagexError({ code: 'IDENTITY_PROVIDER_NOT_FOUND', category: 'NOT_FOUND', message: 'Identity provider not found.' });
    provider.status = action === 'enable' ? 'ACTIVE' : 'DISABLED';
    provider.updatedAt = new Date().toISOString();
    deps.enterpriseIdentityStore.saveProvider(provider);
    deps.auditLogger.logEvent({ actor: { type: 'user', id: user.userId }, tenant_id: organizationId, action: action === 'enable' ? 'idp.enabled' : 'idp.disabled', resource: { type: 'identity_provider', id: providerId }, result: 'SUCCESS', request_id: `req_idp_${Date.now()}` });
    return { status: 200, data: { provider: redactProviderForResponse(provider) } };
  }

  // ── Domains ──
  match = pathname.match(/^\/api\/(?:v1\/)?organizations\/([^/]+)\/domains$/);
  if (match) {
    const [, organizationId] = match;
    const user = getAuthenticatedUser(headers, deps);
    if (method === 'GET') {
      deps.rbacService.authorize({ userId: user.userId, organizationId, permissionKey: PERMISSIONS.DOMAIN_READ });
      return { status: 200, data: { domains: deps.enterpriseIdentityStore.listDomains(organizationId) } };
    }
    if (method === 'POST') {
      deps.rbacService.authorize({ userId: user.userId, organizationId, permissionKey: PERMISSIONS.DOMAIN_MANAGE });
      const input = (body ?? {}) as { domain?: string };
      if (!input.domain || typeof input.domain !== 'string') {
        throw new NagexError({ code: 'INVALID_INPUT', category: 'VALIDATION', message: 'domain is required.' });
      }
      const normalized = domainService.normalizeDomain(input.domain);
      const rawToken = domainService.generateVerificationToken();
      const record = deps.enterpriseIdentityStore.createDomain(organizationId, normalized, domainService.hashVerificationToken(rawToken));
      deps.auditLogger.logEvent({ actor: { type: 'user', id: user.userId }, tenant_id: organizationId, action: 'domain.created', resource: { type: 'domain', id: record.domainId }, result: 'SUCCESS', request_id: `req_dom_${Date.now()}` });
      // The raw token is returned exactly once, here — never persisted, never logged.
      return { status: 201, data: { domain: record, dnsRecordValue: domainService.formatTxtRecordValue(rawToken), rawVerificationToken: rawToken } };
    }
  }

  match = pathname.match(/^\/api\/(?:v1\/)?organizations\/([^/]+)\/domains\/([^/]+)\/verify$/);
  if (match && method === 'POST') {
    const [, organizationId, domainId] = match;
    const user = getAuthenticatedUser(headers, deps);
    deps.rbacService.authorize({ userId: user.userId, organizationId, permissionKey: PERMISSIONS.DOMAIN_MANAGE });
    const record = deps.enterpriseIdentityStore.getOwnedDomain(domainId, organizationId);
    if (!record) throw new NagexError({ code: 'DOMAIN_NOT_FOUND', category: 'NOT_FOUND', message: 'Domain not found.' });
    const input = (body ?? {}) as { rawVerificationToken?: string };
    if (!input.rawVerificationToken || domainService.hashVerificationToken(input.rawVerificationToken) !== record.verificationTokenHash) {
      throw new NagexError({ code: 'DOMAIN_TOKEN_INVALID', category: 'VALIDATION', message: 'Verification token does not match this domain\'s issued token.' });
    }
    // §17 — single verified owner across all organizations, enforced here.
    const existingOwner = deps.enterpriseIdentityStore.findVerifiedOwnerOfDomain(record.domain);
    if (existingOwner && existingOwner.organizationId !== organizationId) {
      throw new NagexError({ code: 'DOMAIN_ALREADY_OWNED', category: 'CONFLICT', message: 'This domain is already verified by another organization.' });
    }
    const dnsOk = await domainService.checkDnsTxtVerification(record.domain, input.rawVerificationToken);
    if (!dnsOk) {
      throw new NagexError({ code: 'DOMAIN_DNS_NOT_FOUND', category: 'VALIDATION', message: 'The expected TXT record was not found for this domain yet.' });
    }
    const updated = deps.enterpriseIdentityStore.updateDomainStatus(domainId, 'VERIFIED');
    deps.auditLogger.logEvent({ actor: { type: 'user', id: user.userId }, tenant_id: organizationId, action: 'domain.verified', resource: { type: 'domain', id: domainId }, result: 'SUCCESS', request_id: `req_dom_${Date.now()}` });
    return { status: 200, data: { domain: updated } };
  }

  match = pathname.match(/^\/api\/(?:v1\/)?organizations\/([^/]+)\/domains\/([^/]+)\/revoke$/);
  if (match && method === 'POST') {
    const [, organizationId, domainId] = match;
    const user = getAuthenticatedUser(headers, deps);
    deps.rbacService.authorize({ userId: user.userId, organizationId, permissionKey: PERMISSIONS.DOMAIN_MANAGE });
    const record = deps.enterpriseIdentityStore.getOwnedDomain(domainId, organizationId);
    if (!record) throw new NagexError({ code: 'DOMAIN_NOT_FOUND', category: 'NOT_FOUND', message: 'Domain not found.' });
    const updated = deps.enterpriseIdentityStore.updateDomainStatus(domainId, 'REVOKED');
    deps.auditLogger.logEvent({ actor: { type: 'user', id: user.userId }, tenant_id: organizationId, action: 'domain.revoked', resource: { type: 'domain', id: domainId }, result: 'SUCCESS', request_id: `req_dom_${Date.now()}` });
    return { status: 200, data: { domain: updated } };
  }

  // ── SSO Policy ──
  match = pathname.match(/^\/api\/(?:v1\/)?organizations\/([^/]+)\/sso-policy$/);
  if (match) {
    const [, organizationId] = match;
    const user = getAuthenticatedUser(headers, deps);
    if (method === 'GET') {
      deps.rbacService.authorize({ userId: user.userId, organizationId, permissionKey: PERMISSIONS.SSO_POLICY_READ });
      const policy = deps.enterpriseIdentityStore.getSsoPolicy(organizationId) ?? defaultSsoPolicy(organizationId, user.userId);
      return { status: 200, data: { ssoPolicy: policy } };
    }
    if (method === 'PUT') {
      // §42 — SSO_POLICY_MANAGE is OWNER-only per the R16 permission
      // matrix (never granted to ADMIN — see rbac.types.ts), so this
      // authorize() call alone already blocks ADMIN from disabling
      // SSO_REQUIRED or changing local-login policy.
      deps.rbacService.authorize({ userId: user.userId, organizationId, permissionKey: PERMISSIONS.SSO_POLICY_MANAGE });
      const existing = deps.enterpriseIdentityStore.getSsoPolicy(organizationId) ?? defaultSsoPolicy(organizationId, user.userId);
      const input = (body ?? {}) as Record<string, any>;
      const wasRequired = existing.ssoEnforcement === 'SSO_REQUIRED';

      if (input.ssoEnforcement === 'SSO_OPTIONAL' || input.ssoEnforcement === 'SSO_REQUIRED') existing.ssoEnforcement = input.ssoEnforcement;
      if (input.localLoginPolicy === 'ALLOW' || input.localLoginPolicy === 'RESTRICT' || input.localLoginPolicy === 'BREAK_GLASS_ONLY') existing.localLoginPolicy = input.localLoginPolicy;
      if (typeof input.jitProvisioningEnabled === 'boolean') existing.jitProvisioningEnabled = input.jitProvisioningEnabled;
      if (typeof input.scimEnabled === 'boolean') existing.scimEnabled = input.scimEnabled;
      if (Array.isArray(input.breakGlassUserIds)) existing.breakGlassUserIds = input.breakGlassUserIds;
      if (typeof input.defaultRoleId === 'string') {
        // Never allow the JIT/SCIM default role to be set to OWNER —
        // mirrors the guard already enforced at provisioning time, but
        // rejecting it here too means a misconfigured policy can never
        // even be saved.
        if (input.defaultRoleId === BUILTIN_ROLE_IDS.OWNER) {
          throw new NagexError({ code: 'ENTERPRISE_IDENTITY_OWNER_MAPPING_BLOCKED', category: 'AUTHORIZATION', message: 'defaultRoleId may never be OWNER.' });
        }
        existing.defaultRoleId = input.defaultRoleId;
      }

      // §20 — break-glass rule: SSO_REQUIRED may never leave zero recovery
      // paths. Refuse to save SSO_REQUIRED with an empty breakGlassUserIds
      // list AND a localLoginPolicy that fully blocks local login.
      if (existing.ssoEnforcement === 'SSO_REQUIRED' && existing.localLoginPolicy === 'RESTRICT' && existing.breakGlassUserIds.length === 0) {
        throw new NagexError({ code: 'SSO_ENFORCEMENT_NO_RECOVERY_PATH', category: 'VALIDATION', message: 'SSO_REQUIRED with local login fully restricted requires at least one break-glass user — set localLoginPolicy to BREAK_GLASS_ONLY and name at least one user, or keep RESTRICT with no breakGlassUserIds only if that is intentional... refusing to lock the organization out entirely.' });
      }

      existing.updatedByUserId = user.userId;
      deps.enterpriseIdentityStore.saveSsoPolicy(existing);
      if (wasRequired !== (existing.ssoEnforcement === 'SSO_REQUIRED')) {
        deps.auditLogger.logEvent({ actor: { type: 'user', id: user.userId }, tenant_id: organizationId, action: 'sso.enforcement.changed', resource: { type: 'sso_policy', id: organizationId }, result: 'SUCCESS', request_id: `req_sso_${Date.now()}`, details: { ssoEnforcement: existing.ssoEnforcement } });
      }
      return { status: 200, data: { ssoPolicy: existing } };
    }
  }

  // ── SCIM tokens (management, not the SCIM protocol itself) ──
  match = pathname.match(/^\/api\/(?:v1\/)?organizations\/([^/]+)\/scim\/tokens$/);
  if (match) {
    const [, organizationId] = match;
    const user = getAuthenticatedUser(headers, deps);
    if (method === 'GET') {
      deps.rbacService.authorize({ userId: user.userId, organizationId, permissionKey: PERMISSIONS.PROVISIONING_READ });
      const tokens = deps.enterpriseIdentityStore.listScimTokens(organizationId).map((t) => ({ ...t, tokenHash: undefined }));
      return { status: 200, data: { tokens } };
    }
    if (method === 'POST') {
      deps.rbacService.authorize({ userId: user.userId, organizationId, permissionKey: PERMISSIONS.PROVISIONING_MANAGE });
      const input = (body ?? {}) as { name?: string };
      const rawToken = `scim_tok_${crypto.randomBytes(24).toString('hex')}`;
      const record = deps.enterpriseIdentityStore.createScimToken(organizationId, typeof input.name === 'string' && input.name.trim() ? input.name.trim() : 'SCIM Token', hashSecret(rawToken), user.userId);
      deps.auditLogger.logEvent({ actor: { type: 'user', id: user.userId }, tenant_id: organizationId, action: 'scim.token.created', resource: { type: 'scim_token', id: record.scimTokenId }, result: 'SUCCESS', request_id: `req_sct_${Date.now()}` });
      // Raw token shown exactly once — never persisted, never logged again.
      return { status: 201, data: { token: { ...record, tokenHash: undefined }, rawToken } };
    }
  }

  match = pathname.match(/^\/api\/(?:v1\/)?organizations\/([^/]+)\/scim\/tokens\/([^/]+)\/(rotate|revoke)$/);
  if (match && method === 'POST') {
    const [, organizationId, scimTokenId, action] = match;
    const user = getAuthenticatedUser(headers, deps);
    deps.rbacService.authorize({ userId: user.userId, organizationId, permissionKey: PERMISSIONS.PROVISIONING_MANAGE });
    const existing = deps.enterpriseIdentityStore.listScimTokens(organizationId).find((t) => t.scimTokenId === scimTokenId);
    if (!existing) throw new NagexError({ code: 'SCIM_TOKEN_NOT_FOUND', category: 'NOT_FOUND', message: 'SCIM token not found.' });
    deps.enterpriseIdentityStore.revokeScimToken(scimTokenId);
    deps.auditLogger.logEvent({ actor: { type: 'user', id: user.userId }, tenant_id: organizationId, action: action === 'rotate' ? 'scim.token.rotated' : 'scim.token.revoked', resource: { type: 'scim_token', id: scimTokenId }, result: 'SUCCESS', request_id: `req_sct_${Date.now()}` });
    if (action === 'revoke') return { status: 200, data: { success: true } };
    const rawToken = `scim_tok_${crypto.randomBytes(24).toString('hex')}`;
    const created = deps.enterpriseIdentityStore.createScimToken(organizationId, existing.name, hashSecret(rawToken), user.userId);
    return { status: 201, data: { token: { ...created, tokenHash: undefined }, rawToken } };
  }

  // ── Group -> Role Mappings ──
  match = pathname.match(/^\/api\/(?:v1\/)?organizations\/([^/]+)\/group-mappings$/);
  if (match) {
    const [, organizationId] = match;
    const user = getAuthenticatedUser(headers, deps);
    if (method === 'GET') {
      deps.rbacService.authorize({ userId: user.userId, organizationId, permissionKey: PERMISSIONS.PROVISIONING_READ });
      return { status: 200, data: { groupMappings: deps.enterpriseIdentityStore.listGroupMappings(organizationId) } };
    }
    if (method === 'POST') {
      deps.rbacService.authorize({ userId: user.userId, organizationId, permissionKey: PERMISSIONS.PROVISIONING_MANAGE });
      const input = (body ?? {}) as { providerId?: string; externalGroupName?: string; roleId?: string };
      if (!input.providerId || !input.externalGroupName || !input.roleId) {
        throw new NagexError({ code: 'INVALID_INPUT', category: 'VALIDATION', message: 'providerId, externalGroupName, and roleId are required.' });
      }
      // §37/§58 — OWNER mapping is blocked at the source, not just at
      // application time, so a bad mapping can never even be saved.
      if (input.roleId === BUILTIN_ROLE_IDS.OWNER) {
        throw new NagexError({ code: 'ENTERPRISE_IDENTITY_OWNER_MAPPING_BLOCKED', category: 'AUTHORIZATION', message: 'Group role mappings may never target the OWNER role.' });
      }
      const provider = deps.enterpriseIdentityStore.getOwnedProvider(input.providerId, organizationId);
      if (!provider) throw new NagexError({ code: 'IDENTITY_PROVIDER_NOT_FOUND', category: 'NOT_FOUND', message: 'Identity provider not found in this organization.' });
      const role = deps.rbacStore.getRole(input.roleId);
      if (!role || (role.organizationId !== null && role.organizationId !== organizationId)) {
        throw new NagexError({ code: 'AUTHZ_ROLE_NOT_FOUND', category: 'NOT_FOUND', message: 'Role not found or belongs to another organization.' });
      }
      const mapping = deps.enterpriseIdentityStore.createGroupMapping({ organizationId, providerId: input.providerId, externalGroupName: input.externalGroupName, roleId: input.roleId });
      return { status: 201, data: { groupMapping: mapping } };
    }
  }

  match = pathname.match(/^\/api\/(?:v1\/)?organizations\/([^/]+)\/group-mappings\/([^/]+)$/);
  if (match && method === 'DELETE') {
    const [, organizationId, groupMappingId] = match;
    const user = getAuthenticatedUser(headers, deps);
    deps.rbacService.authorize({ userId: user.userId, organizationId, permissionKey: PERMISSIONS.PROVISIONING_MANAGE });
    deps.enterpriseIdentityStore.deleteGroupMapping(groupMappingId);
    return { status: 200, data: { success: true } };
  }

  // ── SSO discovery (§18) — email domain lookup only, never itself an authentication step ──
  match = pathname.match(/^\/api\/(?:v1\/)?auth\/sso\/discover$/);
  if (match && method === 'GET') {
    const email = query?.email;
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return { status: 200, data: { ssoAvailable: false } };
    }
    const domain = email.split('@')[1]?.toLowerCase();
    const verifiedDomain = domain ? deps.enterpriseIdentityStore.findVerifiedOwnerOfDomain(domain) : null;
    if (!verifiedDomain) return { status: 200, data: { ssoAvailable: false } };
    const providers = deps.enterpriseIdentityStore.listProviders(verifiedDomain.organizationId).filter((p) => p.status === 'ACTIVE');
    if (providers.length === 0) return { status: 200, data: { ssoAvailable: false } };
    return { status: 200, data: { ssoAvailable: true, organizationId: verifiedDomain.organizationId, providerId: providers[0].providerId, providerType: providers[0].providerType } };
  }

  // ── OIDC start / callback ──
  match = pathname.match(/^\/api\/(?:v1\/)?auth\/oidc\/([^/]+)\/start$/);
  if (match && method === 'GET') {
    const [, providerId] = match;
    const organizationId = query?.organizationId;
    if (!organizationId || typeof organizationId !== 'string') {
      throw new NagexError({ code: 'INVALID_INPUT', category: 'VALIDATION', message: 'organizationId query parameter is required.' });
    }
    const provider = deps.enterpriseIdentityStore.getOwnedProvider(providerId, organizationId);
    if (!provider || provider.providerType !== 'OIDC' || provider.status !== 'ACTIVE' || !provider.oidcConfig) {
      throw new NagexError({ code: 'IDENTITY_PROVIDER_NOT_FOUND', category: 'NOT_FOUND', message: 'Active OIDC provider not found in this organization.' });
    }
    const redirectUri = `${deps.publicBaseUrl}/api/v1/auth/oidc/callback`;
    const flow = deps.ssoFlowStore.createOidcFlowState(organizationId, providerId, redirectUri);
    const authUrl = oidc.buildAuthorizationUrl(provider.oidcConfig, { state: flow.state, nonce: flow.nonce, codeVerifier: flow.codeVerifier, redirectUri });
    return { status: 302, data: null, redirectTo: authUrl };
  }

  match = pathname.match(/^\/api\/(?:v1\/)?auth\/oidc\/callback$/);
  if (match && method === 'GET') {
    const state = query?.state;
    const code = query?.code;
    if (!state || typeof state !== 'string' || !code || typeof code !== 'string') {
      return { status: 302, data: null, redirectTo: '/?sso=oidc&status=error' };
    }
    const flow = deps.ssoFlowStore.consumeOidcFlowState(state);
    if (!flow) return { status: 302, data: null, redirectTo: '/?sso=oidc&status=error' };
    const provider = deps.enterpriseIdentityStore.getOwnedProvider(flow.providerId, flow.organizationId);
    if (!provider || !provider.oidcConfig) return { status: 302, data: null, redirectTo: '/?sso=oidc&status=error' };
    try {
      const clientSecret = decryptClientSecret(provider.oidcConfig.clientSecretEncrypted);
      const tokens = await oidc.exchangeAuthorizationCode(provider.oidcConfig, clientSecret, code, flow.redirectUri, flow.codeVerifier, deps.fetchFn);
      const jwks = await oidc.fetchJwks(provider.oidcConfig.jwksUri, deps.fetchFn);
      const claims = oidc.verifyIdToken(tokens.idToken, { issuer: provider.oidcConfig.issuer, audience: provider.oidcConfig.clientId, jwks, expectedNonce: flow.nonce });
      if (!claims.email) throw new NagexError({ code: 'OIDC_EMAIL_MISSING', category: 'AUTHENTICATION', message: 'ID token did not include an email claim.' });

      const groupNames = Array.isArray((claims as any).groups) ? (claims as any).groups : [];
      const result = resolveEnterpriseLogin({ identityStore: deps.identityStore, organizationStore: deps.organizationStore, sessionStore: deps.sessionStore, rbacStore: deps.rbacStore, enterpriseIdentityStore: deps.enterpriseIdentityStore }, {
        organizationId: flow.organizationId,
        providerId: flow.providerId,
        providerType: 'oidc',
        externalSubject: claims.sub,
        externalEmail: claims.email,
        groupNames,
      });
      if (result.membershipCreated) {
        deps.auditLogger.logEvent({ actor: { type: 'user', id: result.userId }, tenant_id: flow.organizationId, action: 'jit.user.created', resource: { type: 'user', id: result.userId }, result: 'SUCCESS', request_id: `req_jit_${Date.now()}` });
      }
      deps.auditLogger.logEvent({ actor: { type: 'user', id: result.userId }, tenant_id: flow.organizationId, action: 'sso.login.succeeded', resource: { type: 'identity_provider', id: flow.providerId }, result: 'SUCCESS', request_id: `req_sso_${Date.now()}` });
      const session = deps.sessionStore.createAuthSession(flow.organizationId, result.userId, 'MAIN');
      return { status: 302, data: null, redirectTo: '/?sso=oidc&status=connected', headers: COOKIE_HEADER(session.sessionId) };
    } catch (error) {
      deps.auditLogger.logEvent({ actor: { type: 'user', id: 'unknown' }, tenant_id: flow.organizationId, action: 'sso.login.failed', resource: { type: 'identity_provider', id: flow.providerId }, result: 'DENIED', reason_code: error instanceof NagexError ? error.code : 'OIDC_LOGIN_FAILED', request_id: `req_sso_${Date.now()}` });
      return { status: 302, data: null, redirectTo: '/?sso=oidc&status=error' };
    }
  }

  // ── SAML start / ACS callback ──
  match = pathname.match(/^\/api\/(?:v1\/)?auth\/saml\/([^/]+)\/start$/);
  if (match && method === 'GET') {
    const [, providerId] = match;
    const organizationId = query?.organizationId;
    if (!organizationId || typeof organizationId !== 'string') {
      throw new NagexError({ code: 'INVALID_INPUT', category: 'VALIDATION', message: 'organizationId query parameter is required.' });
    }
    const provider = deps.enterpriseIdentityStore.getOwnedProvider(providerId, organizationId);
    if (!provider || provider.providerType !== 'SAML' || provider.status !== 'ACTIVE' || !provider.samlConfig) {
      throw new NagexError({ code: 'IDENTITY_PROVIDER_NOT_FOUND', category: 'NOT_FOUND', message: 'Active SAML provider not found in this organization.' });
    }
    const acsUrl = `${deps.publicBaseUrl}/api/v1/auth/saml/callback`;
    const spEntityId = `${deps.publicBaseUrl}/api/v1/auth/saml/metadata`;
    const authnRequestId = saml.generateSamlRequestId();
    const flow = deps.ssoFlowStore.createSamlFlowState(organizationId, providerId, acsUrl, authnRequestId);
    const { redirectUrl } = saml.buildAuthnRequest(provider.samlConfig, spEntityId, acsUrl, flow.state, authnRequestId);
    return { status: 302, data: null, redirectTo: redirectUrl };
  }

  match = pathname.match(/^\/api\/(?:v1\/)?auth\/saml\/callback$/);
  if (match && method === 'POST') {
    const input = (body ?? {}) as { SAMLResponse?: string; RelayState?: string };
    if (!input.SAMLResponse || !input.RelayState) return { status: 302, data: null, redirectTo: '/?sso=saml&status=error' };
    const flow = deps.ssoFlowStore.consumeOidcFlowState(input.RelayState);
    if (!flow) return { status: 302, data: null, redirectTo: '/?sso=saml&status=error' };
    const provider = deps.enterpriseIdentityStore.getOwnedProvider(flow.providerId, flow.organizationId);
    if (!provider || !provider.samlConfig) return { status: 302, data: null, redirectTo: '/?sso=saml&status=error' };
    try {
      const xml = saml.decodeSamlResponse(input.SAMLResponse);
      const acsUrl = `${deps.publicBaseUrl}/api/v1/auth/saml/callback`;
      const spEntityId = `${deps.publicBaseUrl}/api/v1/auth/saml/metadata`;
      const assertion = saml.verifySamlResponse(xml, {
        organizationId: flow.organizationId,
        providerId: flow.providerId,
        config: provider.samlConfig,
        spEntityId,
        acsUrl,
        expectedInResponseTo: flow.samlAuthnRequestId ?? '',
        isReplay: (id) => !deps.ssoFlowStore.recordSamlResponseIdIfNew(flow.organizationId, flow.providerId, id),
      });
      const email = assertion.attributes.email || assertion.nameId;
      const groupsAttr = assertion.attributes.groups;
      const groupNames = groupsAttr ? groupsAttr.split(',').map((g) => g.trim()) : [];
      const result = resolveEnterpriseLogin({ identityStore: deps.identityStore, organizationStore: deps.organizationStore, sessionStore: deps.sessionStore, rbacStore: deps.rbacStore, enterpriseIdentityStore: deps.enterpriseIdentityStore }, {
        organizationId: flow.organizationId,
        providerId: flow.providerId,
        providerType: 'saml',
        externalSubject: assertion.nameId,
        externalEmail: email,
        groupNames,
      });
      if (result.membershipCreated) {
        deps.auditLogger.logEvent({ actor: { type: 'user', id: result.userId }, tenant_id: flow.organizationId, action: 'jit.user.created', resource: { type: 'user', id: result.userId }, result: 'SUCCESS', request_id: `req_jit_${Date.now()}` });
      }
      deps.auditLogger.logEvent({ actor: { type: 'user', id: result.userId }, tenant_id: flow.organizationId, action: 'sso.login.succeeded', resource: { type: 'identity_provider', id: flow.providerId }, result: 'SUCCESS', request_id: `req_sso_${Date.now()}` });
      const session = deps.sessionStore.createAuthSession(flow.organizationId, result.userId, 'MAIN');
      return { status: 302, data: null, redirectTo: '/?sso=saml&status=connected', headers: COOKIE_HEADER(session.sessionId) };
    } catch (error) {
      deps.auditLogger.logEvent({ actor: { type: 'user', id: 'unknown' }, tenant_id: flow.organizationId, action: 'sso.login.failed', resource: { type: 'identity_provider', id: flow.providerId }, result: 'DENIED', reason_code: error instanceof NagexError ? error.code : 'SAML_LOGIN_FAILED', request_id: `req_sso_${Date.now()}` });
      return { status: 302, data: null, redirectTo: '/?sso=saml&status=error' };
    }
  }

  // ── Explicit account linking (§25) — requires an authenticated existing session ──
  match = pathname.match(/^\/api\/(?:v1\/)?organizations\/([^/]+)\/identity-links$/);
  if (match && method === 'POST') {
    const [, organizationId] = match;
    const user = getAuthenticatedUser(headers, deps);
    const input = (body ?? {}) as { providerId?: string; externalSubject?: string; externalEmail?: string };
    if (!input.providerId || !input.externalSubject || !input.externalEmail) {
      throw new NagexError({ code: 'INVALID_INPUT', category: 'VALIDATION', message: 'providerId, externalSubject, and externalEmail are required (obtained from a just-completed IdP login, not user-supplied free text).' });
    }
    const provider = deps.enterpriseIdentityStore.getOwnedProvider(input.providerId, organizationId);
    if (!provider) throw new NagexError({ code: 'IDENTITY_PROVIDER_NOT_FOUND', category: 'NOT_FOUND', message: 'Identity provider not found in this organization.' });
    const link = linkEnterpriseIdentity({ identityStore: deps.identityStore, organizationStore: deps.organizationStore, sessionStore: deps.sessionStore, rbacStore: deps.rbacStore, enterpriseIdentityStore: deps.enterpriseIdentityStore }, {
      organizationId,
      callerUserId: user.userId,
      providerId: input.providerId,
      externalSubject: input.externalSubject,
      externalEmail: input.externalEmail,
    });
    deps.auditLogger.logEvent({ actor: { type: 'user', id: user.userId }, tenant_id: organizationId, action: 'identity.linked', resource: { type: 'identity_link', id: link.identityLinkId }, result: 'SUCCESS', request_id: `req_link_${Date.now()}` });
    return { status: 201, data: { identityLink: link } };
  }

  match = pathname.match(/^\/api\/(?:v1\/)?organizations\/([^/]+)\/identity-links\/([^/]+)$/);
  if (match && method === 'DELETE') {
    const [, organizationId, identityLinkId] = match;
    const user = getAuthenticatedUser(headers, deps);
    deps.enterpriseIdentityStore.deleteLink(identityLinkId);
    deps.auditLogger.logEvent({ actor: { type: 'user', id: user.userId }, tenant_id: organizationId, action: 'identity.unlinked', resource: { type: 'identity_link', id: identityLinkId }, result: 'SUCCESS', request_id: `req_link_${Date.now()}` });
    return { status: 200, data: { success: true } };
  }

  return undefined;
};

function defaultSsoPolicy(organizationId: string, userId: string) {
  return {
    organizationId,
    ssoEnforcement: 'SSO_OPTIONAL' as const,
    localLoginPolicy: 'ALLOW' as const,
    jitProvisioningEnabled: false,
    scimEnabled: false,
    defaultRoleId: BUILTIN_ROLE_IDS.MEMBER,
    breakGlassUserIds: [] as string[],
    updatedAt: new Date().toISOString(),
    updatedByUserId: userId,
  };
}
