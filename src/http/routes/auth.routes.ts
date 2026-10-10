// R13 Identity & Account Lifecycle - Authentication HTTP Route Registrar
import type { IdentityStore } from '../../identity/identity.store.js';
import type { IdentityTokenStore } from '../../identity/identity.tokens.js';
import type { IdentityAuditStore } from '../../identity/identity.audit.js';
import type { AuthAbuseGuard } from '../../identity/auth-abuse-guard.js';
import type { SessionStore } from '../../sessions/session.store.js';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';
import { getSessionIdFromHeaders } from '../session-credential.js';
import { clientIpOf } from '../client-ip.js';
import { clearSessionCookieHeader } from '../session-cookie.js';

export interface AuthRoutesDependencies {
  identityStore: IdentityStore;
  identityTokenStore: IdentityTokenStore;
  identityAuditStore: IdentityAuditStore;
  sessionStore: SessionStore;
  /** S2E - defaults to the process-wide guard; injectable so a test can use its own policy and clock. */
  authAbuseGuard?: AuthAbuseGuard;
}

export { getSessionIdFromHeaders } from '../session-credential.js';

const CLEAR_COOKIE_HEADER = () => ({ 'Set-Cookie': clearSessionCookieHeader() });
const PASSWORD_AUTH_DISABLED_RESPONSE: ApiResult = {
  status: 410,
  data: {
    error: {
      code: 'EMAIL_PASSWORD_AUTH_DISABLED',
      category: 'AUTH_POLICY',
      message: 'Email/password authentication is not available. Continue with Google or Microsoft.',
    },
  },
};

export const handleAuthRoutes: AsyncRouteRegistrar<AuthRoutesDependencies> = async (
  method,
  pathname,
  _body,
  headers,
  _query,
  deps
): Promise<ApiResult | undefined> => {
  const clientIp = clientIpOf(headers);
  const rawUserAgent = Array.isArray(headers['user-agent']) ? headers['user-agent'][0] : headers['user-agent'];
  const userAgent = rawUserAgent || null;

  if (
    method === 'POST'
    && [
      '/api/v1/auth/signup',
      '/api/v1/auth/verify-email',
      '/api/v1/auth/resend-verification',
      '/api/v1/auth/login',
      '/api/v1/auth/forgot-password',
      '/api/v1/auth/reset-password',
    ].includes(pathname)
  ) {
    return PASSWORD_AUTH_DISABLED_RESPONSE;
  }

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
      headers: CLEAR_COOKIE_HEADER(),
      data: { message: 'Logged out successfully.' },
    };
  }

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
      headers: CLEAR_COOKIE_HEADER(),
      data: { message: 'All sessions revoked.' },
    };
  }

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

  return undefined;
};
