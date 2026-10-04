// R13 Identity & Account Lifecycle — Account Management HTTP Route Registrar
import { NagexError } from '../../common/errors.js';
import { AUTH_EMAIL_DELIVERY, devAuthTokenFields } from '../../identity/dev-auth-tokens.js';
import type { IdentityStore } from '../../identity/identity.store.js';
import type { IdentityTokenStore } from '../../identity/identity.tokens.js';
import type { IdentityAuditStore } from '../../identity/identity.audit.js';
import type { SessionRecord, SessionStore } from '../../sessions/session.store.js';
import { hashPassword, verifyPassword } from '../../identity/identity.crypto.js';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';
import { getSessionIdFromHeaders } from '../session-credential.js';
import type { AuthAbuseGuard } from '../../identity/auth-abuse-guard.js';
import { clientIpOf } from '../client-ip.js';
import { defaultAuthAbuseGuard, throttleSubject, throttledResponse } from '../auth-throttle.js';

export interface AccountRoutesDependencies {
  identityStore: IdentityStore;
  identityTokenStore: IdentityTokenStore;
  identityAuditStore: IdentityAuditStore;
  sessionStore: SessionStore;
  /** S2E — defaults to the process-wide guard; injectable so a test can use its own policy and clock. */
  authAbuseGuard?: AuthAbuseGuard;
}

function requireAuth(headers: Record<string, string | string[] | undefined>, deps: AccountRoutesDependencies): { session: SessionRecord; userId: string; tenantId: string } | null {
  const sessionId = getSessionIdFromHeaders(headers);
  if (!sessionId) return null;
  const session = deps.sessionStore.getSession(sessionId);
  if (!session) return null;

  const identity = deps.identityStore.getByUserId(session.principalId);
  if (!identity || identity.accountState === 'DELETED') return null;

  return { session, userId: identity.userId, tenantId: session.tenantId };
}

export const handleAccountRoutes: AsyncRouteRegistrar<AccountRoutesDependencies> = async (
  method,
  pathname,
  body,
  headers,
  _query,
  deps
): Promise<ApiResult | undefined> => {
  // S2E — the address comes from the trusted resolver, never from a request header.
  const clientIp = clientIpOf(headers);
  const guard = deps.authAbuseGuard ?? defaultAuthAbuseGuard;
  const rawUserAgent = Array.isArray(headers['user-agent']) ? headers['user-agent'][0] : headers['user-agent'];
  const userAgent = rawUserAgent || null;

  // 1. GET /api/v1/account
  if (pathname === '/api/v1/account' && method === 'GET') {
    const auth = requireAuth(headers, deps);
    if (!auth) {
      return { status: 401, data: { error: { code: 'UNAUTHORIZED', message: 'Authentication required.' } } };
    }
    const identity = deps.identityStore.getByUserId(auth.userId)!;
    const profile = deps.identityStore.getProfile(auth.userId);

    return {
      status: 200,
      data: {
        account: {
          userId: identity.userId,
          email: identity.email,
          verificationStatus: identity.verificationStatus,
          accountState: identity.accountState,
          createdAt: identity.createdAt,
          lastLoginAt: identity.lastLoginAt,
          passwordChangedAt: identity.passwordChangedAt,
          disabledAt: identity.disabledAt,
          deletionRequestedAt: identity.deletionRequestedAt,
          scheduledPurgeAt: identity.scheduledPurgeAt,
        },
        profile: profile ? { displayName: profile.displayName, avatarUrl: profile.avatarUrl, locale: profile.locale, timezone: profile.timezone, updatedAt: profile.updatedAt } : null,
      },
    };
  }

  // 2. PATCH /api/v1/account/profile
  if (pathname === '/api/v1/account/profile' && method === 'PATCH') {
    const auth = requireAuth(headers, deps);
    if (!auth) {
      return { status: 401, data: { error: { code: 'UNAUTHORIZED', message: 'Authentication required.' } } };
    }

    const data = body || {};
    const { displayName, avatarUrl, locale, timezone } = data as Record<string, any>;
    let updated;
    try {
      updated = deps.identityStore.updateProfile(auth.userId, { displayName, avatarUrl, locale, timezone });
    } catch (err) {
      // R24.6B — an unsupported locale is a client error, never silently stored.
      if (err instanceof NagexError && err.code === 'INVALID_LOCALE') {
        return { status: 400, data: { error: { code: err.code, message: err.message } } };
      }
      throw err;
    }

    return {
      status: 200,
      data: {
        profile: { displayName: updated.displayName, avatarUrl: updated.avatarUrl, locale: updated.locale, timezone: updated.timezone, updatedAt: updated.updatedAt },
        message: 'Profile updated successfully.',
      },
    };
  }

  // 3. POST /api/v1/account/password
  if (pathname === '/api/v1/account/password' && method === 'POST') {
    const auth = requireAuth(headers, deps);
    if (!auth) {
      return { status: 401, data: { error: { code: 'UNAUTHORIZED', message: 'Authentication required.' } } };
    }

    const data = body || {};
    const { currentPassword, newPassword, newPasswordConfirmation } = data as Record<string, any>;
    if (!currentPassword || !newPassword || !newPasswordConfirmation) {
      return { status: 400, data: { error: { code: 'INVALID_PASSWORD', message: 'Current password, new password, and confirmation are required.' } } };
    }

    const identity = deps.identityStore.getByUserId(auth.userId)!;
    if (!verifyPassword(currentPassword, identity.passwordHash)) {
      deps.identityAuditStore.recordEvent(auth.userId, 'password.changed', 'FAILURE', { sessionId: auth.session.sessionId, ip: clientIp, userAgent });
      return { status: 400, data: { error: { code: 'AUTH_INVALID_CREDENTIALS', message: 'Current password is incorrect.' } } };
    }

    if (newPassword.length < 8 || newPassword !== newPasswordConfirmation) {
      return { status: 400, data: { error: { code: 'PASSWORD_MISMATCH', message: 'New password must be at least 8 characters and match confirmation.' } } };
    }

    const newHash = hashPassword(newPassword);
    deps.identityStore.updatePassword(auth.userId, newHash);
    // Keep current session, revoke all other sessions
    deps.sessionStore.revokeAllUserSessions(auth.tenantId, auth.userId, auth.session.sessionId);
    deps.identityAuditStore.recordEvent(auth.userId, 'password.changed', 'SUCCESS', { sessionId: auth.session.sessionId, ip: clientIp, userAgent });

    return { status: 200, data: { message: 'Password changed successfully. Other active sessions have been revoked.' } };
  }

  // 4. POST /api/v1/account/email/change-request
  if (pathname === '/api/v1/account/email/change-request' && method === 'POST') {
    const auth = requireAuth(headers, deps);
    if (!auth) {
      return { status: 401, data: { error: { code: 'UNAUTHORIZED', message: 'Authentication required.' } } };
    }

    const data = body || {};
    const { currentPassword, newEmail } = data as Record<string, any>;
    if (!currentPassword || !newEmail || typeof newEmail !== 'string' || !newEmail.includes('@')) {
      return { status: 400, data: { error: { code: 'INVALID_EMAIL', message: 'Current password and a valid new email address are required.' } } };
    }

    const identity = deps.identityStore.getByUserId(auth.userId)!;
    if (!verifyPassword(currentPassword, identity.passwordHash)) {
      return { status: 400, data: { error: { code: 'AUTH_INVALID_CREDENTIALS', message: 'Current password is incorrect.' } } };
    }

    const normNewEmail = deps.identityStore.normalizeEmail(newEmail);
    const existing = deps.identityStore.getByEmail(normNewEmail);
    if (existing) {
      return { status: 409, data: { error: { code: 'AUTH_EMAIL_ALREADY_EXISTS', message: 'An account with this email address already exists.' } } };
    }

    const { rawToken } = deps.identityTokenStore.createToken('EMAIL_CHANGE', auth.userId, 24 * 60 * 60 * 1000, normNewEmail);
    deps.identityAuditStore.recordEvent(auth.userId, 'email.change.requested', 'SUCCESS', { sessionId: auth.session.sessionId, ip: clientIp, userAgent });

    return {
      status: 200,
      data: {
        message: 'Email change request recorded. Email delivery is not configured on this server yet, so no verification message was sent.',
        delivery: AUTH_EMAIL_DELIVERY,
        ...devAuthTokenFields('devVerificationToken', rawToken),
      },
    };
  }

  // 5. POST /api/v1/account/email/confirm
  if (pathname === '/api/v1/account/email/confirm' && method === 'POST') {
    const data = body || {};
    const { token } = data as Record<string, any>;
    if (!token || typeof token !== 'string') {
      return { status: 400, data: { error: { code: 'INVALID_TOKEN', message: 'Verification token is required.' } } };
    }

    const tokenRecord = deps.identityTokenStore.consumeToken('EMAIL_CHANGE', token);
    if (!tokenRecord || !tokenRecord.newEmail) {
      return { status: 400, data: { error: { code: 'INVALID_VERIFICATION_TOKEN', message: 'Token is invalid, expired, or already used.' } } };
    }

    const updated = deps.identityStore.updateEmail(tokenRecord.userId, tokenRecord.newEmail);
    deps.identityAuditStore.recordEvent(tokenRecord.userId, 'email.changed', 'SUCCESS', { ip: clientIp, userAgent });

    return {
      status: 200,
      data: {
        user: { userId: updated.userId, email: updated.email },
        message: 'Email changed successfully.',
      },
    };
  }

  // 6. GET /api/v1/account/sessions
  if (pathname === '/api/v1/account/sessions' && method === 'GET') {
    const auth = requireAuth(headers, deps);
    if (!auth) {
      return { status: 401, data: { error: { code: 'UNAUTHORIZED', message: 'Authentication required.' } } };
    }

    const sessions = deps.sessionStore.listUserSessions(auth.tenantId, auth.userId).map((s) => ({
      sessionId: s.sessionId,
      createdAt: s.createdAt,
      lastActiveAt: s.lastActiveAt,
      expiresAt: s.expiresAt,
      userAgent: s.userAgent,
      ipAddress: s.ipAddress,
      isCurrent: s.sessionId === auth.session.sessionId,
    }));

    return { status: 200, data: { sessions } };
  }

  // 7. DELETE /api/v1/account/sessions/:sessionId
  if (pathname.startsWith('/api/v1/account/sessions/') && method === 'DELETE') {
    const auth = requireAuth(headers, deps);
    if (!auth) {
      return { status: 401, data: { error: { code: 'UNAUTHORIZED', message: 'Authentication required.' } } };
    }

    const targetSessionId = pathname.replace('/api/v1/account/sessions/', '').trim();
    if (!targetSessionId) {
      return { status: 400, data: { error: { code: 'INVALID_SESSION_ID', message: 'Session ID is required.' } } };
    }

    // IDOR Protection: ensure target session belongs to current user
    const userSessions = deps.sessionStore.listUserSessions(auth.tenantId, auth.userId);
    const targetOwned = userSessions.find((s) => s.sessionId === targetSessionId);

    if (!targetOwned) {
      deps.identityAuditStore.recordEvent(auth.userId, 'session.revoked', 'FAILURE', { sessionId: auth.session.sessionId, ip: clientIp, userAgent, details: { targetSessionId, reason: 'IDOR_BLOCKED' } });
      return { status: 403, data: { error: { code: 'FORBIDDEN', message: 'You do not have permission to revoke this session.' } } };
    }

    deps.sessionStore.revokeSession(targetSessionId);
    deps.identityAuditStore.recordEvent(auth.userId, 'session.revoked', 'SUCCESS', { sessionId: auth.session.sessionId, ip: clientIp, userAgent, details: { targetSessionId } });

    return { status: 200, data: { message: 'Session revoked successfully.' } };
  }

  // 8. POST /api/v1/account/disable
  if (pathname === '/api/v1/account/disable' && method === 'POST') {
    const auth = requireAuth(headers, deps);
    if (!auth) {
      return { status: 401, data: { error: { code: 'UNAUTHORIZED', message: 'Authentication required.' } } };
    }

    const data = body || {};
    const { password } = data as Record<string, any>;
    if (!password || typeof password !== 'string') {
      return { status: 400, data: { error: { code: 'AUTH_INVALID_CREDENTIALS', message: 'Password confirmation is required.' } } };
    }

    const identity = deps.identityStore.getByUserId(auth.userId)!;
    if (!verifyPassword(password, identity.passwordHash)) {
      return { status: 400, data: { error: { code: 'AUTH_INVALID_CREDENTIALS', message: 'Password confirmation failed.' } } };
    }

    deps.identityStore.transitionState(auth.userId, 'DISABLED');
    deps.sessionStore.revokeAllUserSessions(auth.tenantId, auth.userId);
    deps.identityAuditStore.recordEvent(auth.userId, 'account.disabled', 'SUCCESS', { sessionId: auth.session.sessionId, ip: clientIp, userAgent });

    return { status: 200, data: { message: 'Account disabled. All active sessions have been revoked.' } };
  }

  // 9. POST /api/v1/account/reactivate
  if (pathname === '/api/v1/account/reactivate' && method === 'POST') {
    const data = body || {};
    const { email, password } = data as Record<string, any>;
    if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
      return { status: 400, data: { error: { code: 'AUTH_INVALID_CREDENTIALS', message: 'Email and password are required.' } } };
    }

    // S2E — this unauthenticated route tests a password, so it shares the login guess budget and is refused BEFORE any
    // hashing while throttled.
    const subject = throttleSubject('credential', headers, email);
    const decision = guard.check(subject);
    if (!decision.allowed) {
      return throttledResponse(decision, 'Too many attempts. Please try again later.');
    }

    // A wrong password, an unknown address and a correct password on an account that is NOT disabled are all the same
    // answer and all count as a failed guess: the response must not reveal account state to someone who may not know the
    // password, and the reverse (state first) must not confirm a guessed password.
    const identity = deps.identityStore.getByEmail(email);
    if (!identity || !verifyPassword(password, identity.passwordHash) || identity.accountState !== 'DISABLED') {
      guard.hit(subject);
      return { status: 401, data: { error: { code: 'AUTH_INVALID_CREDENTIALS', message: 'Invalid email or password.' } } };
    }

    guard.clearAccount(subject);
    deps.identityStore.transitionState(identity.userId, 'ACTIVE');
    deps.identityAuditStore.recordEvent(identity.userId, 'account.reactivated', 'SUCCESS', { ip: clientIp, userAgent });

    return { status: 200, data: { message: 'Account reactivated successfully. You may now sign in.' } };
  }

  // 10. POST /api/v1/account/delete
  if (pathname === '/api/v1/account/delete' && method === 'POST') {
    const auth = requireAuth(headers, deps);
    if (!auth) {
      return { status: 401, data: { error: { code: 'UNAUTHORIZED', message: 'Authentication required.' } } };
    }

    const data = body || {};
    const { password } = data as Record<string, any>;
    if (!password || typeof password !== 'string') {
      return { status: 400, data: { error: { code: 'AUTH_INVALID_CREDENTIALS', message: 'Password confirmation is required.' } } };
    }

    const identity = deps.identityStore.getByUserId(auth.userId)!;
    if (!verifyPassword(password, identity.passwordHash)) {
      return { status: 400, data: { error: { code: 'AUTH_INVALID_CREDENTIALS', message: 'Password confirmation failed.' } } };
    }

    const updated = deps.identityStore.transitionState(auth.userId, 'DELETION_PENDING');
    deps.sessionStore.revokeAllUserSessions(auth.tenantId, auth.userId);
    deps.identityAuditStore.recordEvent(auth.userId, 'account.deletion.requested', 'SUCCESS', { sessionId: auth.session.sessionId, ip: clientIp, userAgent });

    return {
      status: 200,
      data: {
        accountState: updated.accountState,
        deletionRequestedAt: updated.deletionRequestedAt,
        scheduledPurgeAt: updated.scheduledPurgeAt,
        message: 'Account deletion requested. Your data will be permanently purged in 14 days unless cancelled.',
      },
    };
  }

  // 11. POST /api/v1/account/delete/cancel
  if (pathname === '/api/v1/account/delete/cancel' && method === 'POST') {
    const data = body || {};
    const { email, password } = data as Record<string, any>;
    if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
      return { status: 400, data: { error: { code: 'AUTH_INVALID_CREDENTIALS', message: 'Email and password are required.' } } };
    }

    // S2E — same shared guess budget and same uniform answer as reactivate (see there).
    const subject = throttleSubject('credential', headers, email);
    const decision = guard.check(subject);
    if (!decision.allowed) {
      return throttledResponse(decision, 'Too many attempts. Please try again later.');
    }

    const identity = deps.identityStore.getByEmail(email);
    if (!identity || !verifyPassword(password, identity.passwordHash) || identity.accountState !== 'DELETION_PENDING') {
      guard.hit(subject);
      return { status: 401, data: { error: { code: 'AUTH_INVALID_CREDENTIALS', message: 'Invalid email or password.' } } };
    }

    guard.clearAccount(subject);
    const restored = deps.identityStore.transitionState(identity.userId, 'ACTIVE');
    deps.identityAuditStore.recordEvent(identity.userId, 'account.deletion.cancelled', 'SUCCESS', { ip: clientIp, userAgent });

    return {
      status: 200,
      data: {
        accountState: restored.accountState,
        message: 'Account deletion cancelled. Your account is active.',
      },
    };
  }

  return undefined;
};
