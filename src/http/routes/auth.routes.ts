// R13 Identity & Account Lifecycle — Authentication HTTP Route Registrar
import { NagexError } from '../../common/errors.js';
import type { IdentityStore } from '../../identity/identity.store.js';
import type { IdentityTokenStore } from '../../identity/identity.tokens.js';
import type { IdentityAuditStore } from '../../identity/identity.audit.js';
import { IdentityRateLimiter } from '../../identity/identity.rate-limiter.js';
import { hashPassword, verifyPassword } from '../../identity/identity.crypto.js';
import type { SessionStore } from '../../sessions/session.store.js';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';

export interface AuthRoutesDependencies {
  identityStore: IdentityStore;
  identityTokenStore: IdentityTokenStore;
  identityAuditStore: IdentityAuditStore;
  sessionStore: SessionStore;
}

const rateLimiter = new IdentityRateLimiter({ windowMs: 15 * 60 * 1000, maxHits: 5 });

function getSessionIdFromHeaders(headers: Record<string, string | string[] | undefined>): string | null {
  const cookieHeader = Array.isArray(headers['cookie']) ? headers['cookie'][0] : headers['cookie'];
  if (cookieHeader) {
    const match = cookieHeader.match(/nagex_session=([^;]+)/);
    if (match) return decodeURIComponent(match[1]);
  }
  const authHeader = Array.isArray(headers['authorization']) ? headers['authorization'][0] : headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7).trim();
  }
  return null;
}

const COOKIE_HEADER = (sessionId: string) => ({ 'Set-Cookie': `nagex_session=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax` });
const CLEAR_COOKIE_HEADER = { 'Set-Cookie': `nagex_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` };

export const handleAuthRoutes: AsyncRouteRegistrar<AuthRoutesDependencies> = async (
  method,
  pathname,
  body,
  headers,
  _query,
  deps
): Promise<ApiResult | undefined> => {
  const rawForwarded = Array.isArray(headers['x-forwarded-for']) ? headers['x-forwarded-for'][0] : headers['x-forwarded-for'];
  const clientIp = rawForwarded || '127.0.0.1';
  const rawUserAgent = Array.isArray(headers['user-agent']) ? headers['user-agent'][0] : headers['user-agent'];
  const userAgent = rawUserAgent || null;

  // 1. POST /api/v1/auth/signup
  if (pathname === '/api/v1/auth/signup' && method === 'POST') {
    const rateCheck = rateLimiter.check(`signup:${clientIp}`);
    if (!rateCheck.allowed) {
      return { status: 429, data: { error: { code: 'AUTH_RATE_LIMITED', message: 'Too many signup attempts. Please try again later.' } } };
    }
    rateLimiter.record(`signup:${clientIp}`);

    const data = body || {};
    const { email, password, passwordConfirmation, termsAccepted, privacyAccepted } = data as Record<string, any>;
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return { status: 400, data: { error: { code: 'INVALID_EMAIL', message: 'A valid email address is required.' } } };
    }
    if (!password || typeof password !== 'string' || password.length < 8) {
      return { status: 400, data: { error: { code: 'WEAK_PASSWORD', message: 'Password must be at least 8 characters long.' } } };
    }
    if (password !== passwordConfirmation) {
      return { status: 400, data: { error: { code: 'PASSWORD_MISMATCH', message: 'Passwords do not match.' } } };
    }
    if (!termsAccepted || !privacyAccepted) {
      return { status: 400, data: { error: { code: 'TERMS_NOT_ACCEPTED', message: 'You must accept the Terms of Service and Privacy Policy.' } } };
    }

    try {
      const passwordHash = hashPassword(password);
      const { identity, profile } = deps.identityStore.createAccount(email, passwordHash);
      const { rawToken } = deps.identityTokenStore.createToken('EMAIL_VERIFY', identity.userId, 24 * 60 * 60 * 1000);

      deps.identityAuditStore.recordEvent(identity.userId, 'account.created', 'SUCCESS', { ip: clientIp, userAgent });

      return {
        status: 201,
        data: {
          status: 'PENDING_VERIFICATION',
          user: { userId: identity.userId, email: identity.email, accountState: identity.accountState },
          profile: { displayName: profile.displayName, locale: profile.locale, timezone: profile.timezone },
          message: 'Account created. Please verify your email address.',
          devVerificationToken: rawToken,
        },
      };
    } catch (err: any) {
      if (err instanceof NagexError) {
        return { status: err.code === 'AUTH_EMAIL_ALREADY_EXISTS' ? 409 : 400, data: { error: { code: err.code, message: err.message } } };
      }
      return { status: 500, data: { error: { code: 'SERVER_ERROR', message: 'Internal server error.' } } };
    }
  }

  // 2. POST /api/v1/auth/verify-email
  if (pathname === '/api/v1/auth/verify-email' && method === 'POST') {
    const data = body || {};
    const { token } = data as Record<string, any>;
    if (!token || typeof token !== 'string') {
      return { status: 400, data: { error: { code: 'INVALID_TOKEN', message: 'Verification token is required.' } } };
    }

    const tokenRecord = deps.identityTokenStore.consumeToken('EMAIL_VERIFY', token);
    if (!tokenRecord) {
      return { status: 400, data: { error: { code: 'INVALID_VERIFICATION_TOKEN', message: 'Verification token is invalid, expired, or already used.' } } };
    }

    const identity = deps.identityStore.transitionState(tokenRecord.userId, 'ACTIVE');
    deps.identityAuditStore.recordEvent(identity.userId, 'email.verified', 'SUCCESS', { ip: clientIp, userAgent });

    return {
      status: 200,
      data: {
        status: 'ACTIVE',
        user: { userId: identity.userId, email: identity.email, accountState: identity.accountState },
        message: 'Email verified successfully.',
      },
    };
  }

  // 3. POST /api/v1/auth/resend-verification
  if (pathname === '/api/v1/auth/resend-verification' && method === 'POST') {
    const data = body || {};
    const { email } = data as Record<string, any>;
    if (email && typeof email === 'string') {
      const rateCheck = rateLimiter.check(`resend:${email}`);
      if (rateCheck.allowed) {
        rateLimiter.record(`resend:${email}`);
        const identity = deps.identityStore.getByEmail(email);
        if (identity && identity.accountState === 'PENDING_VERIFICATION') {
          const { rawToken } = deps.identityTokenStore.createToken('EMAIL_VERIFY', identity.userId, 24 * 60 * 60 * 1000);
          return {
            status: 200,
            data: {
              message: 'If an unverified account exists, verification instructions have been sent.',
              devVerificationToken: rawToken,
            },
          };
        }
      }
    }
    return { status: 200, data: { message: 'If an unverified account exists, verification instructions have been sent.' } };
  }

  // 4. POST /api/v1/auth/login
  if (pathname === '/api/v1/auth/login' && method === 'POST') {
    const data = body || {};
    const { email, password } = data as Record<string, any>;

    const rateKey = `login:${clientIp}:${email || 'unknown'}`;
    const rateCheck = rateLimiter.check(rateKey);
    if (!rateCheck.allowed) {
      return { status: 429, data: { error: { code: 'AUTH_RATE_LIMITED', message: 'Too many login attempts. Please try again later.' } } };
    }

    if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
      return { status: 400, data: { error: { code: 'AUTH_INVALID_CREDENTIALS', message: 'Invalid email or password.' } } };
    }

    const identity = deps.identityStore.getByEmail(email);
    if (!identity || !verifyPassword(password, identity.passwordHash)) {
      rateLimiter.record(rateKey);
      if (identity) {
        deps.identityAuditStore.recordEvent(identity.userId, 'login.failed', 'FAILURE', { ip: clientIp, userAgent });
      }
      return { status: 401, data: { error: { code: 'AUTH_INVALID_CREDENTIALS', message: 'Invalid email or password.' } } };
    }

    // Account state checks
    if (identity.accountState === 'PENDING_VERIFICATION') {
      return { status: 403, data: { error: { code: 'AUTH_UNVERIFIED_EMAIL', message: 'Please verify your email address before signing in.' } } };
    }
    if (identity.accountState === 'DISABLED') {
      return { status: 403, data: { error: { code: 'AUTH_ACCOUNT_DISABLED', message: 'This account has been disabled.' } } };
    }
    if (identity.accountState === 'LOCKED') {
      return { status: 403, data: { error: { code: 'AUTH_ACCOUNT_LOCKED', message: 'This account is locked due to security policy.' } } };
    }
    if (identity.accountState === 'DELETED') {
      return { status: 401, data: { error: { code: 'AUTH_INVALID_CREDENTIALS', message: 'Invalid email or password.' } } };
    }

    rateLimiter.reset(rateKey);

    // Create session & rotate token
    const tenantId = `ten_${identity.userId}`;
    const session = deps.sessionStore.createAuthSession(tenantId, identity.userId, 'MAIN', { userAgent, ipAddress: clientIp });
    deps.identityStore.updateLastLogin(identity.userId);
    deps.identityAuditStore.recordEvent(identity.userId, 'login.succeeded', 'SUCCESS', { sessionId: session.sessionId, ip: clientIp, userAgent });

    const profile = deps.identityStore.getProfile(identity.userId);

    return {
      status: 200,
      headers: COOKIE_HEADER(session.sessionId),
      data: {
        status: 'SUCCESS',
        session: { sessionId: session.sessionId, expiresAt: session.expiresAt },
        user: { userId: identity.userId, email: identity.email, accountState: identity.accountState },
        profile: profile ? { displayName: profile.displayName, locale: profile.locale, timezone: profile.timezone } : null,
      },
    };
  }

  // 5. POST /api/v1/auth/logout
  if (pathname === '/api/v1/auth/logout' && method === 'POST') {
    const sessionId = getSessionIdFromHeaders(headers);
    if (sessionId) {
      const session = deps.sessionStore.getSession(sessionId);
      if (session) {
        deps.sessionStore.revokeSession(sessionId);
        deps.identityAuditStore.recordEvent(session.principalId, 'logout', 'SUCCESS', { sessionId, ip: clientIp, userAgent });
      }
    }
    return {
      status: 200,
      headers: CLEAR_COOKIE_HEADER,
      data: { message: 'Logged out successfully.' },
    };
  }

  // 6. POST /api/v1/auth/logout-all
  if (pathname === '/api/v1/auth/logout-all' && method === 'POST') {
    const sessionId = getSessionIdFromHeaders(headers);
    if (!sessionId) {
      return { status: 401, data: { error: { code: 'UNAUTHORIZED', message: 'Authentication required.' } } };
    }
    const session = deps.sessionStore.getSession(sessionId);
    if (!session) {
      return { status: 401, data: { error: { code: 'UNAUTHORIZED', message: 'Invalid or expired session.' } } };
    }

    deps.sessionStore.revokeAllUserSessions(session.tenantId, session.principalId);
    deps.identityAuditStore.recordEvent(session.principalId, 'logout.all', 'SUCCESS', { sessionId, ip: clientIp, userAgent });
    return {
      status: 200,
      headers: CLEAR_COOKIE_HEADER,
      data: { message: 'All sessions revoked.' },
    };
  }

  // 7. GET /api/v1/auth/session
  if (pathname === '/api/v1/auth/session' && method === 'GET') {
    const sessionId = getSessionIdFromHeaders(headers);
    if (!sessionId) {
      return { status: 200, data: { authenticated: false } };
    }
    const session = deps.sessionStore.getSession(sessionId);
    if (!session) {
      return { status: 200, data: { authenticated: false } };
    }
    const identity = deps.identityStore.getByUserId(session.principalId);
    if (!identity || identity.accountState === 'DISABLED' || identity.accountState === 'DELETED') {
      return { status: 200, data: { authenticated: false } };
    }
    const profile = deps.identityStore.getProfile(identity.userId);

    return {
      status: 200,
      data: {
        authenticated: true,
        session: { sessionId: session.sessionId, createdAt: session.createdAt, lastActiveAt: session.lastActiveAt, expiresAt: session.expiresAt },
        user: { userId: identity.userId, email: identity.email, accountState: identity.accountState },
        profile: profile ? { displayName: profile.displayName, locale: profile.locale, timezone: profile.timezone } : null,
      },
    };
  }

  // 8. POST /api/v1/auth/forgot-password
  if (pathname === '/api/v1/auth/forgot-password' && method === 'POST') {
    const data = body || {};
    const { email } = data as Record<string, any>;
    if (email && typeof email === 'string') {
      const rateKey = `forgot:${clientIp}:${email}`;
      const rateCheck = rateLimiter.check(rateKey);
      if (rateCheck.allowed) {
        rateLimiter.record(rateKey);
        const identity = deps.identityStore.getByEmail(email);
        if (identity && identity.accountState === 'ACTIVE') {
          const { rawToken } = deps.identityTokenStore.createToken('PASSWORD_RESET', identity.userId, 60 * 60 * 1000);
          deps.identityAuditStore.recordEvent(identity.userId, 'password.reset.requested', 'SUCCESS', { ip: clientIp, userAgent });
          return {
            status: 200,
            data: {
              message: 'If an account exists for this address, password reset instructions have been sent.',
              devResetToken: rawToken,
            },
          };
        }
      }
    }
    return { status: 200, data: { message: 'If an account exists for this address, password reset instructions have been sent.' } };
  }

  // 9. POST /api/v1/auth/reset-password
  if (pathname === '/api/v1/auth/reset-password' && method === 'POST') {
    const data = body || {};
    const { token, newPassword, newPasswordConfirmation } = data as Record<string, any>;
    if (!token || typeof token !== 'string') {
      return { status: 400, data: { error: { code: 'INVALID_TOKEN', message: 'Reset token is required.' } } };
    }
    if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 8) {
      return { status: 400, data: { error: { code: 'WEAK_PASSWORD', message: 'Password must be at least 8 characters long.' } } };
    }
    if (newPassword !== newPasswordConfirmation) {
      return { status: 400, data: { error: { code: 'PASSWORD_MISMATCH', message: 'Passwords do not match.' } } };
    }

    const tokenRecord = deps.identityTokenStore.consumeToken('PASSWORD_RESET', token);
    if (!tokenRecord) {
      return { status: 400, data: { error: { code: 'INVALID_RESET_TOKEN', message: 'Reset token is invalid, expired, or already used.' } } };
    }

    const identity = deps.identityStore.getByUserId(tokenRecord.userId);
    if (!identity) {
      return { status: 400, data: { error: { code: 'AUTH_ACCOUNT_NOT_FOUND', message: 'Account not found.' } } };
    }

    const newHash = hashPassword(newPassword);
    deps.identityStore.updatePassword(identity.userId, newHash);
    const tenantId = `ten_${identity.userId}`;
    deps.sessionStore.revokeAllUserSessions(tenantId, identity.userId);
    deps.identityAuditStore.recordEvent(identity.userId, 'password.reset.completed', 'SUCCESS', { ip: clientIp, userAgent });

    return { status: 200, data: { message: 'Password has been reset successfully. Please sign in with your new password.' } };
  }

  return undefined;
};
