// R13 Identity & Account Lifecycle — Identity & Profile Store
import { generateResourceId } from '../common/utils.js';
import { FileRecordStore, resolveNagexDataDir } from '../governance/file-record.store.js';
import { NagexError } from '../common/errors.js';
import type { AccountState, IdentityRecord, ProfileRecord } from './identity.types.js';

export function isIdentityRecord(value: unknown): value is IdentityRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.userId === 'string' &&
    typeof v.email === 'string' &&
    typeof v.passwordHash === 'string' &&
    typeof v.accountState === 'string' &&
    typeof v.verificationStatus === 'string' &&
    typeof v.createdAt === 'string'
  );
}

export function isProfileRecord(value: unknown): value is ProfileRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.userId === 'string' &&
    typeof v.displayName === 'string' &&
    typeof v.locale === 'string' &&
    typeof v.timezone === 'string' &&
    typeof v.updatedAt === 'string'
  );
}

const ALLOWED_TRANSITIONS: Record<AccountState, Set<AccountState>> = {
  PENDING_VERIFICATION: new Set(['ACTIVE']),
  ACTIVE: new Set(['LOCKED', 'DISABLED', 'DELETION_PENDING']),
  LOCKED: new Set(['ACTIVE', 'DISABLED']),
  DISABLED: new Set(['ACTIVE', 'DELETION_PENDING']),
  DELETION_PENDING: new Set(['ACTIVE', 'DELETED']),
  DELETED: new Set([]),
};

export interface IdentityStoreOptions {
  dir?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => string;
}

export class IdentityStore {
  private readonly identities = new Map<string, IdentityRecord>();
  private readonly profiles = new Map<string, ProfileRecord>();
  private readonly identityFileStore: FileRecordStore<IdentityRecord>;
  private readonly profileFileStore: FileRecordStore<ProfileRecord>;
  private readonly now: () => string;

  constructor(options: IdentityStoreOptions = {}) {
    const env = options.env ?? process.env;
    const baseDir = options.dir ?? resolveNagexDataDir('identity', 'NAGEX_IDENTITY_DIR', env);
    this.identityFileStore = new FileRecordStore<IdentityRecord>(`${baseDir}/identities`, isIdentityRecord);
    this.profileFileStore = new FileRecordStore<ProfileRecord>(`${baseDir}/profiles`, isProfileRecord);
    this.now = options.now ?? (() => new Date().toISOString());

    for (const record of this.identityFileStore.readAll()) {
      this.identities.set(record.userId, record);
    }
    for (const record of this.profileFileStore.readAll()) {
      this.profiles.set(record.userId, record);
    }
  }

  public normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  public getByUserId(userId: string): IdentityRecord | null {
    return this.identities.get(userId) || null;
  }

  public getByEmail(email: string): IdentityRecord | null {
    const norm = this.normalizeEmail(email);
    for (const record of this.identities.values()) {
      if (record.email === norm && record.accountState !== 'DELETED') {
        return record;
      }
    }
    return null;
  }

  public getProfile(userId: string): ProfileRecord | null {
    return this.profiles.get(userId) || null;
  }

  public createAccount(email: string, passwordHash: string): { identity: IdentityRecord; profile: ProfileRecord } {
    const normEmail = this.normalizeEmail(email);
    if (this.getByEmail(normEmail)) {
      throw new NagexError({
        code: 'AUTH_EMAIL_ALREADY_EXISTS',
        category: 'VALIDATION',
        message: 'An account with this email address already exists.',
        request_id: `req_id_create_${Date.now()}`,
      });
    }

    const userId = generateResourceId('usr');
    const createdAt = this.now();

    const identity: IdentityRecord = {
      userId,
      email: normEmail,
      passwordHash,
      authProvider: 'local',
      verificationStatus: 'UNVERIFIED',
      accountState: 'PENDING_VERIFICATION',
      createdAt,
      lastLoginAt: null,
      passwordChangedAt: null,
      disabledAt: null,
      deletionRequestedAt: null,
      scheduledPurgeAt: null,
    };

    const displayName = normEmail.split('@')[0] || 'User';
    const profile: ProfileRecord = {
      userId,
      displayName,
      avatarUrl: null,
      locale: 'en',
      timezone: 'UTC',
      updatedAt: createdAt,
    };

    this.identities.set(userId, identity);
    this.profiles.set(userId, profile);
    this.identityFileStore.write(userId, identity);
    this.profileFileStore.write(userId, profile);

    return { identity, profile };
  }

  // R16 — creates an identity for a user whose FIRST authentication ever
  // was a verified enterprise IdP (JIT) or a SCIM provisioning call, never
  // a local signup form. accountState starts ACTIVE (not
  // PENDING_VERIFICATION) because a successful signature-verified IdP
  // login/SCIM-authenticated create IS the verification — there is no
  // separate email-link step to wait on, and gating it behind one would
  // block the very SSO flow that just proved the user's identity.
  // passwordHash is deliberately empty: verifyPassword() can never match
  // an empty combined-hash string, so this account structurally cannot
  // log in via the local password form until/unless a real password is
  // set through the normal password-change flow.
  public createEnterpriseAccount(email: string, authProvider: 'oidc' | 'saml' | 'scim'): { identity: IdentityRecord; profile: ProfileRecord } {
    const normEmail = this.normalizeEmail(email);
    // R16 §24 — deliberately NOT "return existing if found": an existing
    // identity at this email (local or otherwise) must never be silently
    // reused/merged just because a new IdP login happens to share the
    // address. Callers (the JIT provisioning service) are responsible for
    // checking getByEmail() themselves BEFORE calling this and routing to
    // the explicit, authenticated account-linking flow (§25) instead when
    // a collision exists — this method only ever creates a brand new
    // identity, exactly like createAccount() does for local signups.
    if (this.getByEmail(normEmail)) {
      throw new NagexError({
        code: 'AUTH_EMAIL_ALREADY_EXISTS',
        category: 'VALIDATION',
        message: 'An account with this email address already exists.',
        request_id: `req_id_create_${Date.now()}`,
      });
    }

    const userId = generateResourceId('usr');
    const createdAt = this.now();

    const identity: IdentityRecord = {
      userId,
      email: normEmail,
      passwordHash: '',
      authProvider,
      verificationStatus: 'VERIFIED',
      accountState: 'ACTIVE',
      createdAt,
      lastLoginAt: null,
      passwordChangedAt: null,
      disabledAt: null,
      deletionRequestedAt: null,
      scheduledPurgeAt: null,
    };

    const displayName = normEmail.split('@')[0] || 'User';
    const profile: ProfileRecord = {
      userId,
      displayName,
      avatarUrl: null,
      locale: 'en',
      timezone: 'UTC',
      updatedAt: createdAt,
    };

    this.identities.set(userId, identity);
    this.profiles.set(userId, profile);
    this.identityFileStore.write(userId, identity);
    this.profileFileStore.write(userId, profile);

    return { identity, profile };
  }

  public transitionState(userId: string, targetState: AccountState): IdentityRecord {
    const identity = this.identities.get(userId);
    if (!identity) {
      throw new NagexError({ code: 'AUTH_ACCOUNT_NOT_FOUND', category: 'NOT_FOUND', message: 'Account not found.', request_id: `req_id_tr_${Date.now()}` });
    }

    const currentState = identity.accountState;
    if (currentState === targetState) return identity;

    const allowed = ALLOWED_TRANSITIONS[currentState];
    if (!allowed || !allowed.has(targetState)) {
      throw new NagexError({
        code: 'AUTH_INVALID_STATE_TRANSITION',
        category: 'POLICY',
        message: `State transition from '${currentState}' to '${targetState}' is not allowed.`,
        request_id: `req_id_tr_${Date.now()}`,
      });
    }

    identity.accountState = targetState;
    const nowIso = this.now();

    if (targetState === 'ACTIVE' && currentState === 'PENDING_VERIFICATION') {
      identity.verificationStatus = 'VERIFIED';
    } else if (targetState === 'DISABLED') {
      identity.disabledAt = nowIso;
    } else if (targetState === 'ACTIVE' && currentState === 'DISABLED') {
      identity.disabledAt = null;
    } else if (targetState === 'DELETION_PENDING') {
      identity.deletionRequestedAt = nowIso;
      // 14 day grace period
      identity.scheduledPurgeAt = new Date(new Date(nowIso).getTime() + 14 * 24 * 60 * 60 * 1000).toISOString();
    } else if (targetState === 'ACTIVE' && currentState === 'DELETION_PENDING') {
      identity.deletionRequestedAt = null;
      identity.scheduledPurgeAt = null;
    }

    this.identityFileStore.write(userId, identity);
    return identity;
  }

  public updatePassword(userId: string, newPasswordHash: string): IdentityRecord {
    const identity = this.identities.get(userId);
    if (!identity) throw new NagexError({ code: 'AUTH_ACCOUNT_NOT_FOUND', category: 'NOT_FOUND', message: 'Account not found.', request_id: `req_id_pw_${Date.now()}` });
    identity.passwordHash = newPasswordHash;
    identity.passwordChangedAt = this.now();
    this.identityFileStore.write(userId, identity);
    return identity;
  }

  public updateEmail(userId: string, newEmail: string): IdentityRecord {
    const identity = this.identities.get(userId);
    if (!identity) throw new NagexError({ code: 'AUTH_ACCOUNT_NOT_FOUND', category: 'NOT_FOUND', message: 'Account not found.', request_id: `req_id_em_${Date.now()}` });
    const norm = this.normalizeEmail(newEmail);
    const existing = this.getByEmail(norm);
    if (existing && existing.userId !== userId) {
      throw new NagexError({ code: 'AUTH_EMAIL_ALREADY_EXISTS', category: 'VALIDATION', message: 'An account with this email address already exists.', request_id: `req_id_em_${Date.now()}` });
    }
    identity.email = norm;
    this.identityFileStore.write(userId, identity);
    return identity;
  }

  public updateLastLogin(userId: string): IdentityRecord {
    const identity = this.identities.get(userId);
    if (!identity) throw new NagexError({ code: 'AUTH_ACCOUNT_NOT_FOUND', category: 'NOT_FOUND', message: 'Account not found.', request_id: `req_id_ll_${Date.now()}` });
    identity.lastLoginAt = this.now();
    this.identityFileStore.write(userId, identity);
    return identity;
  }

  public updateProfile(userId: string, patch: Partial<Omit<ProfileRecord, 'userId'>>): ProfileRecord {
    let profile = this.profiles.get(userId);
    if (!profile) {
      profile = {
        userId,
        displayName: 'User',
        avatarUrl: null,
        locale: 'en',
        timezone: 'UTC',
        updatedAt: this.now(),
      };
    }

    if (patch.displayName !== undefined) profile.displayName = patch.displayName.trim();
    if (patch.avatarUrl !== undefined) profile.avatarUrl = patch.avatarUrl;
    if (patch.locale !== undefined) profile.locale = patch.locale;
    if (patch.timezone !== undefined) profile.timezone = patch.timezone;
    profile.updatedAt = this.now();

    this.profiles.set(userId, profile);
    this.profileFileStore.write(userId, profile);
    return profile;
  }

  public purgeAccountData(userId: string): void {
    const identity = this.identities.get(userId);
    if (!identity) return;
    this.transitionState(userId, 'DELETED');
    // Anonymize profile
    const profile = this.profiles.get(userId);
    if (profile) {
      profile.displayName = 'Deleted User';
      profile.avatarUrl = null;
      profile.updatedAt = this.now();
      this.profileFileStore.write(userId, profile);
    }
  }
}
