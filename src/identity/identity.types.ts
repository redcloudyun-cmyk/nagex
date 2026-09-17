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
  authProvider: 'local' | 'oidc' | 'saml' | 'scim';
  verificationStatus: VerificationStatus;
  accountState: AccountState;
  createdAt: string;            // ISO date string
  lastLoginAt: string | null;
  passwordChangedAt: string | null;
  disabledAt: string | null;
  deletionRequestedAt: string | null;
  scheduledPurgeAt: string | null;
}

export interface ProfileRecord {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  locale: string;               // e.g. 'en' or 'kr'
  timezone: string;             // e.g. 'Asia/Seoul' or 'UTC'
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
