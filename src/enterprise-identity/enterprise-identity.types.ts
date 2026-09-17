// R16 — Enterprise Identity Federation & Provisioning: core domain types.
//
// Canonical architecture (per the R16 directive):
//   User Identity (immutable userId, R13 IdentityRecord)
//     |- Local Credential (existing, untouched)
//     `- Enterprise Identity Link
//          |- OIDC
//          `- SAML
//
// External IdP subject/email is NEVER used as an internal primary key —
// every enterprise concept below is keyed by NAgex's own generated ids and
// points AT an existing organizationId/userId, never the reverse.

export type EnterpriseProviderType = 'OIDC' | 'SAML';
export type EnterpriseProviderStatus = 'DRAFT' | 'ACTIVE' | 'DISABLED' | 'ERROR';

export interface OidcProviderConfig {
  issuer: string;
  clientId: string;
  // Never stored/returned in plaintext outside this record; see
  // enterprise-identity.secrets.ts for the at-rest encryption wrapper.
  clientSecretEncrypted: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  scopes: string[];
}

export interface SamlProviderConfig {
  entityId: string;
  ssoUrl: string;
  x509Certificate: string; // PEM, used to verify assertion signatures — never trust an embedded KeyInfo cert instead
  nameIdFormat: string;
  attributeMappings: Record<string, string>; // e.g. { email: 'http://schemas.../emailaddress' }
}

export interface EnterpriseIdentityProviderRecord {
  providerId: string;
  organizationId: string;
  providerType: EnterpriseProviderType;
  name: string;
  status: EnterpriseProviderStatus;
  oidcConfig: OidcProviderConfig | null;
  samlConfig: SamlProviderConfig | null;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
}

export interface EnterpriseIdentityLinkRecord {
  identityLinkId: string;
  organizationId: string;
  userId: string;
  providerId: string;
  externalSubject: string;
  externalEmail: string;
  createdAt: string;
  lastLoginAt: string | null;
}

export type DomainStatus = 'PENDING' | 'VERIFIED' | 'REVOKED';

export interface DomainRecord {
  domainId: string;
  organizationId: string;
  domain: string; // normalized lowercase, no scheme/path
  verificationTokenHash: string; // sha256(rawToken) — raw token is never persisted
  status: DomainStatus;
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScimTokenRecord {
  scimTokenId: string;
  organizationId: string;
  tokenHash: string; // sha256(rawToken)
  name: string;
  createdByUserId: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export type LocalLoginPolicy = 'ALLOW' | 'RESTRICT' | 'BREAK_GLASS_ONLY';
export type SsoEnforcement = 'SSO_OPTIONAL' | 'SSO_REQUIRED';

export interface SsoPolicyRecord {
  organizationId: string;
  ssoEnforcement: SsoEnforcement;
  localLoginPolicy: LocalLoginPolicy;
  jitProvisioningEnabled: boolean;
  scimEnabled: boolean;
  defaultRoleId: string; // must always resolve to a role whose permissions the assigning OWNER already holds; enforced at write time, defaults to MEMBER builtin
  breakGlassUserIds: string[]; // §20 — always allowed local login regardless of ssoEnforcement/localLoginPolicy
  updatedAt: string;
  updatedByUserId: string;
}

// §36 — IdP Group -> NAgex Role mapping. Never permits mapping to the
// OWNER role (§37/§58) — enforced in the service layer, not just here.
export interface GroupRoleMappingRecord {
  groupMappingId: string;
  organizationId: string;
  providerId: string;
  externalGroupName: string;
  roleId: string;
  createdAt: string;
  updatedAt: string;
}

// §35 — SCIM-pushed group (distinct from GroupRoleMappingRecord's
// token-claim-based mapping: this is the actual /Groups resource an IdP's
// SCIM client creates and PATCHes members into). displayName doubles as
// the externalGroupName a GroupRoleMappingRecord may reference.
export interface ScimGroupRecord {
  scimGroupId: string;
  organizationId: string;
  displayName: string;
  memberUserIds: string[];
  createdAt: string;
  updatedAt: string;
}

export type EnterpriseIdentityAuditEventType =
  | 'idp.created'
  | 'idp.updated'
  | 'idp.enabled'
  | 'idp.disabled'
  | 'domain.created'
  | 'domain.verified'
  | 'domain.revoked'
  | 'sso.login.succeeded'
  | 'sso.login.failed'
  | 'identity.linked'
  | 'identity.unlinked'
  | 'jit.user.created'
  | 'scim.token.created'
  | 'scim.token.rotated'
  | 'scim.token.revoked'
  | 'scim.user.created'
  | 'scim.user.updated'
  | 'scim.user.deprovisioned'
  | 'scim.group.created'
  | 'scim.group.updated'
  | 'scim.group.deleted'
  | 'sso.enforcement.changed';
