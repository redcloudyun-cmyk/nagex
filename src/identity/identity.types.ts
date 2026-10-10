// R13 Identity & Account Lifecycle — Core Domain Types
//
// Separates Identity (credentials, authentication status, security timestamps)
// from Profile (display_name, avatar, locale, timezone).
// Enforces immutable UUID user_id (never email as PK).

export type AccountState =
  | 'PENDING_VERIFICATION'
  | 'ACTIVE'
  | 'LOCKED'
  | 'DISABLED'
  | 'DELETION_PENDING'
  | 'DELETED';

export type VerificationStatus = 'UNVERIFIED' | 'VERIFIED';

// R16 — 'oidc'/'saml' mark an account whose ORIGINAL creation was via
// enterprise federation (JIT-provisioned); 'scim' marks one created by an
// IdP's SCIM provisioning client. None of these three ever carry a usable
// local password (passwordHash is empty on creation) — local login
// remains possible only if the organization's local-login policy allows
// it AND the user separately sets a password, which never happens
// automatically. This is a display/provenance field only, never used as
// an authorization decision by itself — see EnterpriseIdentityLinkStore
// for the actual provider/subject binding RBAC-adjacent code relies on.
export interface IdentityRecord {
  userId: string;               // UUID immutable identifier (e.g. user_550e8400-e29b-41d4-a716-446655440000)
  email: string;                // Normalized, lowercase email
  passwordHash: string;         // Salted password hash (crypto.scrypt); empty for enterprise/SCIM-provisioned accounts
  authProvider: 'local' | 'google' | 'microsoft' | 'oidc' | 'saml' | 'scim';
  verificationStatus: VerificationStatus;
  accountState: AccountState;
  createdAt: string;            // ISO date string
  lastLoginAt: string | null;
  passwordChangedAt: string | null;
  disabledAt: string | null;
  deletionRequestedAt: string | null;
  scheduledPurgeAt: string | null;
}

// R24.6B — canonical account locale. Same convention as the runtime
// (NAGEX_I18N.getLocale(), the x-nagex-locale header, creation documents):
// lowercase 'en' | 'ko'. Legacy/uppercase aliases are canonicalized at the
// store boundary (see normalizeLocale in identity.store.ts).
export type AccountLocale = 'en' | 'ko';

// R24.6B — per-user settings preferences. Owned by the user's profile record
// (one durable, user-scoped record per account) — not a separate settings
// store. Both are PREFERENCE-ONLY today: no runtime component reads them
// (the API reports runtime_effect: 'NONE' so the UI can say so truthfully).
export type AutonomyLevelPreference = 'L0' | 'L1' | 'L2' | 'L3';
export interface QuickWakePreferences {
  floating_button: boolean;
  quick_settings_tile: boolean;
  lock_screen_shortcut: boolean;
  voice_wake: boolean;
  double_tap_shortcut: boolean;
}
export interface NotificationPreferences {
  web: boolean;
  desktop: boolean;
  dailyBrief: boolean;
  proactive: boolean;
}
export interface PrivacyPreferences {
  includeMemoryInSearch: boolean;
  includeVaultInSearch: boolean;
  shareDiagnostics: boolean;
}
export interface AmbientSourceConsentPreference {
  sourceType: string;
  provider: string;
  accountRef: string;
  connected: boolean;
  observeAllowed: boolean;
  backgroundAllowed: boolean;
  contentReadAllowed: boolean;
  attachmentAllowed: boolean;
  proactiveUseAllowed: boolean;
  draftAllowed: boolean;
  executeAllowed: boolean;
  scope: string;
  purpose: string;
  retention: string;
  grantedAt: string;
  updatedAt: string;
  revokedAt?: string | null;
}
export interface AmbientMonitoringPreferences {
  enabled: boolean;
  dailyBrief: boolean;
  proactiveSuggestions: boolean;
  sourceConsents?: Record<string, AmbientSourceConsentPreference>;
}
export interface DeviceSettingsPreferences {
  allowNewDeviceEnrollment: boolean;
  requireTrustedDevices: boolean;
}
export interface ConnectionSettingsPreferences {
  autoReconnect: boolean;
  showUnavailableProviders: boolean;
}
export interface UserPreferences {
  quickWake?: Partial<QuickWakePreferences>;
  autonomyLevel?: AutonomyLevelPreference;
  notifications?: Partial<NotificationPreferences>;
  privacy?: Partial<PrivacyPreferences>;
  ambientMonitoring?: Partial<AmbientMonitoringPreferences>;
  deviceSettings?: Partial<DeviceSettingsPreferences>;
  connectionSettings?: Partial<ConnectionSettingsPreferences>;
}

export interface ProfileRecord {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  locale: string;               // canonical: AccountLocale ('en' | 'ko'); legacy values are normalized on load
  timezone: string;             // e.g. 'Asia/Seoul' or 'UTC'
  preferences?: UserPreferences;
  updatedAt: string;
}

export type IdentityAuditEventType =
  | 'account.created'
  | 'email.verified'
  | 'login.succeeded'
  | 'login.failed'
  | 'logout'
  | 'logout.all'
  | 'password.changed'
  | 'password.reset.requested'
  | 'password.reset.completed'
  | 'email.change.requested'
  | 'email.changed'
  | 'account.disabled'
  | 'account.reactivated'
  | 'account.deletion.requested'
  | 'account.deletion.cancelled'
  | 'account.deleted'
  | 'session.revoked'
  | 'organization.created'
  | 'organization.updated'
  | 'organization.deletion.requested'
  | 'organization.deletion.cancelled'
  | 'organization.deleted'
  | 'workspace.created'
  | 'workspace.updated'
  | 'workspace.archived'
  | 'workspace.restored'
  | 'workspace.deletion.requested'
  | 'invitation.created'
  | 'invitation.accepted'
  | 'invitation.revoked'
  | 'member.joined'
  | 'member.removed'
  | 'member.left'
  | 'owner.transferred';

export interface IdentityAuditEvent {
  eventId: string;
  timestamp: string;
  userId: string;
  sessionId?: string | null;
  eventType: IdentityAuditEventType;
  ip?: string | null;
  userAgent?: string | null;
  result: 'SUCCESS' | 'FAILURE';
  details?: Record<string, unknown>;
}
