// R16 — Enterprise Identity Federation & Provisioning: persistence layer.
// Same FileRecordStore-backed skeleton every store in this codebase uses
// (constructor takes { dir?, env?, now? }, computes a base dir via
// resolveNagexDataDir, one FileRecordStore sub-directory per record type,
// in-memory Map mirror loaded at construction for O(1) lookups).
import crypto from 'node:crypto';
import path from 'node:path';
import { FileRecordStore, resolveNagexDataDir } from '../governance/file-record.store.js';
import { generateResourceId } from '../common/utils.js';
import { NagexError } from '../common/errors.js';
import { loadEncryptionKey, encryptJson, decryptJson, type EncryptedEnvelope } from '../integrations/google/token.crypto.js';
import type {
  EnterpriseIdentityProviderRecord,
  EnterpriseIdentityLinkRecord,
  DomainRecord,
  ScimTokenRecord,
  SsoPolicyRecord,
  GroupRoleMappingRecord,
  ScimGroupRecord,
  DomainStatus,
} from './enterprise-identity.types.js';

export function hashSecret(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

// R16 §8 — client_secret is never stored in plaintext. Reuses the exact
// same AES-256-GCM envelope Google OAuth's token store already uses
// (src/integrations/google/token.crypto.ts) rather than inventing a
// second secret-at-rest mechanism. Fails closed (throws, never silently
// stores plaintext) when NAGEX_TOKEN_ENCRYPTION_KEY is not configured —
// an unconfigured environment simply cannot register an OIDC provider,
// exactly mirroring how Google OAuth persistence is disabled (not
// downgraded to plaintext) under the same condition.
export function encryptClientSecret(raw: string, env: NodeJS.ProcessEnv = process.env): string {
  const key = loadEncryptionKey(env);
  if (!key) {
    throw new NagexError({
      code: 'ENTERPRISE_IDENTITY_ENCRYPTION_UNAVAILABLE',
      category: 'POLICY',
      message: 'NAGEX_TOKEN_ENCRYPTION_KEY must be configured before an OIDC client_secret can be stored.',
    });
  }
  return JSON.stringify(encryptJson(key, raw));
}

export function decryptClientSecret(encrypted: string, env: NodeJS.ProcessEnv = process.env): string {
  const key = loadEncryptionKey(env);
  if (!key) {
    throw new NagexError({
      code: 'ENTERPRISE_IDENTITY_ENCRYPTION_UNAVAILABLE',
      category: 'POLICY',
      message: 'NAGEX_TOKEN_ENCRYPTION_KEY must be configured to decrypt a stored client_secret.',
    });
  }
  const envelope = JSON.parse(encrypted) as EncryptedEnvelope;
  return decryptJson<string>(key, envelope);
}

export function isEnterpriseIdentityProviderRecord(value: unknown): value is EnterpriseIdentityProviderRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.providerId === 'string' &&
    typeof v.organizationId === 'string' &&
    (v.providerType === 'OIDC' || v.providerType === 'SAML') &&
    typeof v.name === 'string' &&
    typeof v.status === 'string' &&
    typeof v.createdAt === 'string'
  );
}

export function isEnterpriseIdentityLinkRecord(value: unknown): value is EnterpriseIdentityLinkRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.identityLinkId === 'string' &&
    typeof v.organizationId === 'string' &&
    typeof v.userId === 'string' &&
    typeof v.providerId === 'string' &&
    typeof v.externalSubject === 'string' &&
    typeof v.createdAt === 'string'
  );
}

export function isDomainRecord(value: unknown): value is DomainRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.domainId === 'string' &&
    typeof v.organizationId === 'string' &&
    typeof v.domain === 'string' &&
    typeof v.verificationTokenHash === 'string' &&
    typeof v.status === 'string' &&
    typeof v.createdAt === 'string'
  );
}

export function isScimTokenRecord(value: unknown): value is ScimTokenRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.scimTokenId === 'string' &&
    typeof v.organizationId === 'string' &&
    typeof v.tokenHash === 'string' &&
    typeof v.createdAt === 'string'
  );
}

export function isSsoPolicyRecord(value: unknown): value is SsoPolicyRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.organizationId === 'string' &&
    typeof v.ssoEnforcement === 'string' &&
    typeof v.localLoginPolicy === 'string' &&
    typeof v.updatedAt === 'string'
  );
}

export function isScimGroupRecord(value: unknown): value is ScimGroupRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.scimGroupId === 'string' &&
    typeof v.organizationId === 'string' &&
    typeof v.displayName === 'string' &&
    Array.isArray(v.memberUserIds) &&
    typeof v.createdAt === 'string'
  );
}

export function isGroupRoleMappingRecord(value: unknown): value is GroupRoleMappingRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.groupMappingId === 'string' &&
    typeof v.organizationId === 'string' &&
    typeof v.providerId === 'string' &&
    typeof v.externalGroupName === 'string' &&
    typeof v.roleId === 'string' &&
    typeof v.createdAt === 'string'
  );
}

export interface EnterpriseIdentityStoreOptions {
  dir?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => string;
}

export class EnterpriseIdentityStore {
  private readonly providers: FileRecordStore<EnterpriseIdentityProviderRecord>;
  private readonly links: FileRecordStore<EnterpriseIdentityLinkRecord>;
  private readonly domains: FileRecordStore<DomainRecord>;
  private readonly scimTokens: FileRecordStore<ScimTokenRecord>;
  private readonly ssoPolicies: FileRecordStore<SsoPolicyRecord>;
  private readonly groupMappings: FileRecordStore<GroupRoleMappingRecord>;
  private readonly scimGroups: FileRecordStore<ScimGroupRecord>;
  private readonly now: () => string;

  constructor(options: EnterpriseIdentityStoreOptions = {}) {
    const baseDir = options.dir ?? resolveNagexDataDir('enterprise-identity', 'NAGEX_ENTERPRISE_IDENTITY_DIR', options.env);
    this.providers = new FileRecordStore<EnterpriseIdentityProviderRecord>(path.join(baseDir, 'providers'), isEnterpriseIdentityProviderRecord);
    this.links = new FileRecordStore<EnterpriseIdentityLinkRecord>(path.join(baseDir, 'links'), isEnterpriseIdentityLinkRecord);
    this.domains = new FileRecordStore<DomainRecord>(path.join(baseDir, 'domains'), isDomainRecord);
    this.scimTokens = new FileRecordStore<ScimTokenRecord>(path.join(baseDir, 'scim-tokens'), isScimTokenRecord);
    this.ssoPolicies = new FileRecordStore<SsoPolicyRecord>(path.join(baseDir, 'sso-policies'), isSsoPolicyRecord);
    this.groupMappings = new FileRecordStore<GroupRoleMappingRecord>(path.join(baseDir, 'group-mappings'), isGroupRoleMappingRecord);
    this.scimGroups = new FileRecordStore<ScimGroupRecord>(path.join(baseDir, 'scim-groups'), isScimGroupRecord);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  // ── Providers ──

  public createProvider(input: Omit<EnterpriseIdentityProviderRecord, 'providerId' | 'createdAt' | 'updatedAt'>): EnterpriseIdentityProviderRecord {
    const record: EnterpriseIdentityProviderRecord = {
      ...input,
      providerId: generateResourceId('idp'),
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    this.providers.write(record.providerId, record);
    return record;
  }

  public getProvider(providerId: string): EnterpriseIdentityProviderRecord | null {
    return this.providers.read(providerId);
  }

  // R16 §5 — every provider lookup that will be used for authentication
  // MUST be scoped to the expected organization; a bare getProvider() is
  // reserved for internal id-only lookups (e.g. resolving a link's
  // providerId back to a record already known to belong to the same org).
  public getOwnedProvider(providerId: string, organizationId: string): EnterpriseIdentityProviderRecord | null {
    const record = this.providers.read(providerId);
    if (!record || record.organizationId !== organizationId) return null;
    return record;
  }

  public listProviders(organizationId: string): EnterpriseIdentityProviderRecord[] {
    return this.providers.readAll().filter((p) => p.organizationId === organizationId);
  }

  public saveProvider(record: EnterpriseIdentityProviderRecord): void {
    this.providers.write(record.providerId, record);
  }

  public deleteProvider(providerId: string): void {
    this.providers.remove(providerId);
  }

  // ── Identity Links ──

  public createLink(input: Omit<EnterpriseIdentityLinkRecord, 'identityLinkId' | 'createdAt'>): EnterpriseIdentityLinkRecord {
    const record: EnterpriseIdentityLinkRecord = {
      ...input,
      identityLinkId: generateResourceId('idl'),
      createdAt: this.now(),
    };
    this.links.write(record.identityLinkId, record);
    return record;
  }

  // R16 §26 — the unique constraint the directive requires: the same
  // (providerId, externalSubject) pair may never resolve to two different
  // internal users. Callers must check this BEFORE creating a link.
  public findLinkByProviderSubject(providerId: string, externalSubject: string): EnterpriseIdentityLinkRecord | null {
    return this.links.readAll().find((l) => l.providerId === providerId && l.externalSubject === externalSubject) ?? null;
  }

  public findLinkForUserAndProvider(organizationId: string, userId: string, providerId: string): EnterpriseIdentityLinkRecord | null {
    return this.links.readAll().find((l) => l.organizationId === organizationId && l.userId === userId && l.providerId === providerId) ?? null;
  }

  public listLinksForUser(userId: string): EnterpriseIdentityLinkRecord[] {
    return this.links.readAll().filter((l) => l.userId === userId);
  }

  public saveLink(record: EnterpriseIdentityLinkRecord): void {
    this.links.write(record.identityLinkId, record);
  }

  public deleteLink(identityLinkId: string): void {
    this.links.remove(identityLinkId);
  }

  // ── Domains ──

  public createDomain(organizationId: string, domain: string, verificationTokenHash: string): DomainRecord {
    const record: DomainRecord = {
      domainId: generateResourceId('dom'),
      organizationId,
      domain: domain.trim().toLowerCase(),
      verificationTokenHash,
      status: 'PENDING',
      verifiedAt: null,
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    this.domains.write(record.domainId, record);
    return record;
  }

  public getDomain(domainId: string): DomainRecord | null {
    return this.domains.read(domainId);
  }

  public getOwnedDomain(domainId: string, organizationId: string): DomainRecord | null {
    const record = this.domains.read(domainId);
    if (!record || record.organizationId !== organizationId) return null;
    return record;
  }

  public listDomains(organizationId: string): DomainRecord[] {
    return this.domains.readAll().filter((d) => d.organizationId === organizationId);
  }

  // R16 §17 — a domain may have at most one VERIFIED owner across ALL
  // organizations at any time. Callers must check this before flipping a
  // domain to VERIFIED.
  public findVerifiedOwnerOfDomain(domain: string): DomainRecord | null {
    const normalized = domain.trim().toLowerCase();
    return this.domains.readAll().find((d) => d.domain === normalized && d.status === 'VERIFIED') ?? null;
  }

  public saveDomain(record: DomainRecord): void {
    record.updatedAt = this.now();
    this.domains.write(record.domainId, record);
  }

  public updateDomainStatus(domainId: string, status: DomainStatus): DomainRecord {
    const record = this.domains.read(domainId);
    if (!record) {
      throw new NagexError({ code: 'DOMAIN_NOT_FOUND', category: 'NOT_FOUND', message: `Domain ${domainId} was not found.` });
    }
    record.status = status;
    record.verifiedAt = status === 'VERIFIED' ? this.now() : record.verifiedAt;
    record.updatedAt = this.now();
    this.domains.write(domainId, record);
    return record;
  }

  // ── SCIM Tokens ──

  public createScimToken(organizationId: string, name: string, tokenHash: string, createdByUserId: string): ScimTokenRecord {
    const record: ScimTokenRecord = {
      scimTokenId: generateResourceId('sct'),
      organizationId,
      tokenHash,
      name,
      createdByUserId,
      createdAt: this.now(),
      lastUsedAt: null,
      revokedAt: null,
    };
    this.scimTokens.write(record.scimTokenId, record);
    return record;
  }

  public listScimTokens(organizationId: string): ScimTokenRecord[] {
    return this.scimTokens.readAll().filter((t) => t.organizationId === organizationId);
  }

  // R16 — the ONLY lookup path SCIM request authentication may use: never
  // resolve a token by id alone without also verifying the hash matches
  // and it is unrevoked. Touches lastUsedAt as a side effect (mirrors
  // SessionStore.getSession's lastActiveAt-on-read convention).
  public findActiveTokenByHash(tokenHash: string): ScimTokenRecord | null {
    const record = this.scimTokens.readAll().find((t) => t.tokenHash === tokenHash && !t.revokedAt);
    if (!record) return null;
    record.lastUsedAt = this.now();
    this.scimTokens.write(record.scimTokenId, record);
    return record;
  }

  public revokeScimToken(scimTokenId: string): ScimTokenRecord {
    const record = this.scimTokens.read(scimTokenId);
    if (!record) {
      throw new NagexError({ code: 'SCIM_TOKEN_NOT_FOUND', category: 'NOT_FOUND', message: `SCIM token ${scimTokenId} was not found.` });
    }
    record.revokedAt = this.now();
    this.scimTokens.write(scimTokenId, record);
    return record;
  }

  // ── SSO Policy (one per organization) ──

  public getSsoPolicy(organizationId: string): SsoPolicyRecord | null {
    return this.ssoPolicies.read(organizationId);
  }

  public saveSsoPolicy(record: SsoPolicyRecord): void {
    record.updatedAt = this.now();
    this.ssoPolicies.write(record.organizationId, record);
  }

  // ── Group -> Role Mappings ──

  public createGroupMapping(input: Omit<GroupRoleMappingRecord, 'groupMappingId' | 'createdAt' | 'updatedAt'>): GroupRoleMappingRecord {
    const record: GroupRoleMappingRecord = {
      ...input,
      groupMappingId: generateResourceId('grp'),
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    this.groupMappings.write(record.groupMappingId, record);
    return record;
  }

  public listGroupMappings(organizationId: string, providerId?: string): GroupRoleMappingRecord[] {
    return this.groupMappings.readAll().filter((m) => m.organizationId === organizationId && (!providerId || m.providerId === providerId));
  }

  public deleteGroupMapping(groupMappingId: string): void {
    this.groupMappings.remove(groupMappingId);
  }

  // ── SCIM Groups (the actual /Groups resource, distinct from role mapping) ──

  public createScimGroup(organizationId: string, displayName: string): ScimGroupRecord {
    const record: ScimGroupRecord = {
      scimGroupId: generateResourceId('grp'),
      organizationId,
      displayName,
      memberUserIds: [],
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    this.scimGroups.write(record.scimGroupId, record);
    return record;
  }

  public getOwnedScimGroup(scimGroupId: string, organizationId: string): ScimGroupRecord | null {
    const record = this.scimGroups.read(scimGroupId);
    if (!record || record.organizationId !== organizationId) return null;
    return record;
  }

  public listScimGroups(organizationId: string): ScimGroupRecord[] {
    return this.scimGroups.readAll().filter((g) => g.organizationId === organizationId);
  }

  public saveScimGroup(record: ScimGroupRecord): void {
    record.updatedAt = this.now();
    this.scimGroups.write(record.scimGroupId, record);
  }

  public deleteScimGroup(scimGroupId: string): void {
    this.scimGroups.remove(scimGroupId);
  }
}
