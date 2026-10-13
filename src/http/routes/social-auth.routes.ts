import crypto from 'node:crypto';
import type { IdentityStore } from '../../identity/identity.store.js';
import type { SocialIdentityStore, SocialProvider } from '../../identity/social-identity.store.js';
import type { SessionStore } from '../../sessions/session.store.js';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';
import { sessionCookieHeader } from '../session-cookie.js';
import type { IdentityAuditStore } from '../../identity/identity.audit.js';

interface Deps { identityStore: IdentityStore; socialIdentityStore: SocialIdentityStore; sessionStore: SessionStore; identityAuditStore?: IdentityAuditStore }
const pendingStates = new Map<string, { provider: SocialProvider; expiresAt: number }>();
const pendingMigrations = new Map<string, { provider: SocialProvider; subject: string; email: string; userId: string; expiresAt: number; used: boolean }>();
// A provider sign-in on a DISABLED or DELETION_PENDING account does not open a session. The provider has just proved who the person is, so it only issues this one-time,
// short-lived token that lets them explicitly reactivate the account or cancel the pending deletion (or leave it as it is).
const pendingRecoveries = new Map<string, { userId: string; state: 'DISABLED' | 'DELETION_PENDING'; expiresAt: number; used: boolean }>();
const COOKIE = (id: string) => ({ 'Set-Cookie': sessionCookieHeader(id) });

export function socialAuthProviderConfig(provider: SocialProvider, env: NodeJS.ProcessEnv = process.env): { clientId: string; clientSecret: string; redirectUri: string; authorize: string; token: string; scopes: string[] } | null {
  if (provider === 'google') {
    const clientId = env.NAGEX_GOOGLE_LOGIN_CLIENT_ID; const clientSecret = env.NAGEX_GOOGLE_LOGIN_CLIENT_SECRET; const redirectUri = env.NAGEX_GOOGLE_LOGIN_REDIRECT_URI;
    return clientId && clientSecret && redirectUri ? { clientId, clientSecret, redirectUri, authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', scopes: ['openid', 'email', 'profile'] } : null;
  }
  const clientId = env.NAGEX_MICROSOFT_LOGIN_CLIENT_ID; const clientSecret = env.NAGEX_MICROSOFT_LOGIN_CLIENT_SECRET; const redirectUri = env.NAGEX_MICROSOFT_LOGIN_REDIRECT_URI;
  return clientId && clientSecret && redirectUri ? { clientId, clientSecret, redirectUri, authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize', token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token', scopes: ['openid', 'email', 'profile'] } : null;
}

export function socialAuthProviderAvailability(env: NodeJS.ProcessEnv = process.env): { google: { enabled: boolean }; microsoft: { enabled: boolean } } {
  return {
    google: { enabled: Boolean(socialAuthProviderConfig('google', env)) },
    microsoft: { enabled: Boolean(socialAuthProviderConfig('microsoft', env)) },
  };
}

async function verifiedClaims(provider: SocialProvider, idToken: string, accessToken: string): Promise<{ sub: string; email: string; emailVerified: boolean; name?: string } | null> {
  const response = provider === 'google'
    ? await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`)
    : await fetch('https://graph.microsoft.com/oidc/userinfo', { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok) return null;
  const claims = await response.json() as Record<string, unknown>;
  const sub = typeof claims.sub === 'string' ? claims.sub : '';
  const email = typeof claims.email === 'string' ? claims.email : '';
  const rawVerified = claims.email_verified ?? claims.emailVerified;
  const emailVerified = rawVerified === true || rawVerified === 'true';
  return sub && email ? { sub, email, emailVerified, name: typeof claims.name === 'string' ? claims.name : undefined } : null;
}

export const handleSocialAuthRoutes: AsyncRouteRegistrar<Deps> = async (method, pathname, _body, _headers, query, deps): Promise<ApiResult | undefined> => {
  if (pathname === '/api/v1/auth/providers' && method === 'GET') {
    return { status: 200, data: { providers: socialAuthProviderAvailability() } };
  }
  const migrationMatch = pathname.match(/^\/api\/v1\/auth\/oauth\/migration\/([^/]+)$/);
  if (migrationMatch && (method === 'GET' || method === 'POST')) {
    const token = decodeURIComponent(migrationMatch[1]);
    const migration = pendingMigrations.get(token);
    if (!migration || migration.used || migration.expiresAt < Date.now()) {
      if (migration) pendingMigrations.delete(token);
      return { status: 410, data: { error: { code: 'OAUTH_MIGRATION_EXPIRED', message: 'This migration request expired.' } } };
    }
    const identity = deps.identityStore.getByUserId(migration.userId);
    if (!identity || identity.accountState !== 'ACTIVE' || deps.identityStore.normalizeEmail(identity.email) !== migration.email) {
      pendingMigrations.delete(token);
      return { status: 409, data: { error: { code: 'OAUTH_MIGRATION_NOT_ELIGIBLE', message: 'This account can no longer be migrated.' } } };
    }
    const existingLink = deps.socialIdentityStore.get(migration.provider, migration.subject);
    if (existingLink && existingLink.userId !== migration.userId) {
      pendingMigrations.delete(token);
      return { status: 409, data: { error: { code: 'OAUTH_IDENTITY_CONFLICT', message: 'This external identity is already linked.' } } };
    }
    if (method === 'GET') {
      return { status: 200, data: { migration: { provider: migration.provider, email: migration.email, userId: migration.userId, expiresAt: new Date(migration.expiresAt).toISOString() } } };
    }
    migration.used = true;
    deps.socialIdentityStore.create(migration.provider, migration.subject, migration.userId);
    pendingMigrations.delete(token);
    const session = deps.sessionStore.createAuthSession(`ten_${migration.userId}`, migration.userId, 'MAIN');
    deps.identityStore.updateLastLogin(migration.userId);
    return { status: 200, headers: COOKIE(session.sessionId), data: { status: 'SUCCESS', userId: migration.userId } };
  }
  const recoveryMatch = pathname.match(/^\/api\/v1\/auth\/oauth\/recovery\/([^/]+)$/);
  if (recoveryMatch && (method === 'GET' || method === 'POST')) {
    const token = decodeURIComponent(recoveryMatch[1]);
    const recovery = pendingRecoveries.get(token);
    if (!recovery || recovery.used || recovery.expiresAt < Date.now()) {
      if (recovery) pendingRecoveries.delete(token);
      return { status: 410, data: { error: { code: 'ACCOUNT_RECOVERY_EXPIRED', message: 'This request expired. Sign in again.' } } };
    }
    const identity = deps.identityStore.getByUserId(recovery.userId);
    if (!identity || identity.accountState !== recovery.state) {
      pendingRecoveries.delete(token);
      return { status: 409, data: { error: { code: 'ACCOUNT_RECOVERY_NOT_ELIGIBLE', message: 'The account changed. Sign in again.' } } };
    }
    if (method === 'GET') {
      return { status: 200, data: { recovery: { state: recovery.state, email: identity.email, scheduledPurgeAt: identity.scheduledPurgeAt ?? null, expiresAt: new Date(recovery.expiresAt).toISOString() } } };
    }
    const action = typeof (_body as { action?: unknown } | null)?.action === 'string' ? String((_body as { action: string }).action) : '';
    const expected = recovery.state === 'DISABLED' ? 'REACTIVATE' : 'CANCEL_DELETION';
    if (action !== expected) {
      return { status: 400, data: { error: { code: 'ACCOUNT_RECOVERY_ACTION_INVALID', message: `This account can only be recovered with ${expected}.` } } };
    }
    recovery.used = true;
    pendingRecoveries.delete(token);
    deps.identityStore.transitionState(identity.userId, 'ACTIVE');
    deps.identityAuditStore?.recordEvent(identity.userId, recovery.state === 'DISABLED' ? 'account.reactivated' : 'account.deletion.cancelled', 'SUCCESS', { details: { method: 'PROVIDER_SIGN_IN' } });
    const session = deps.sessionStore.createAuthSession(`ten_${identity.userId}`, identity.userId, 'MAIN');
    deps.identityStore.updateLastLogin(identity.userId);
    return { status: 200, headers: COOKIE(session.sessionId), data: { status: 'SUCCESS', accountState: 'ACTIVE' } };
  }
  const match = pathname.match(/^\/api\/v1\/auth\/oauth\/(google|microsoft)\/(start|callback)$/);
  const isGet = method === 'GET';
  if (!match || !isGet) return undefined;
  const provider = match[1] as SocialProvider; const action = match[2]; const cfg = socialAuthProviderConfig(provider);
  if (!cfg) return { status: 302, data: null, redirectTo: '/?auth=provider&status=unavailable' };
  if (action === 'start') {
    const state = crypto.randomUUID(); pendingStates.set(state, { provider, expiresAt: Date.now() + 10 * 60_000 });
    const params = new URLSearchParams({ client_id: cfg.clientId, redirect_uri: cfg.redirectUri, response_type: 'code', scope: cfg.scopes.join(' '), state, prompt: 'select_account' });
    return { status: 302, data: null, redirectTo: `${cfg.authorize}?${params.toString()}` };
  }
  const state = typeof query?.state === 'string' ? query.state : ''; const code = typeof query?.code === 'string' ? query.code : '';
  const pending = pendingStates.get(state); pendingStates.delete(state);
  if (!pending || pending.provider !== provider || pending.expiresAt < Date.now() || !code) return { status: 302, data: null, redirectTo: '/?auth=provider&status=error' };
  const tokenResponse = await fetch(cfg.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: cfg.redirectUri, grant_type: 'authorization_code' }) });
  if (!tokenResponse.ok) return { status: 302, data: null, redirectTo: '/?auth=provider&status=error' };
  const token = await tokenResponse.json() as Record<string, unknown>;
  const claims = await verifiedClaims(provider, String(token.id_token || ''), String(token.access_token || ''));
  if (!claims) return { status: 302, data: null, redirectTo: '/?auth=provider&status=error' };
  const linked = deps.socialIdentityStore.get(provider, claims.sub);
  let identity = linked ? deps.identityStore.getByUserId(linked.userId) : undefined;
  if (!identity) {
    const existing = deps.identityStore.getByEmail(claims.email);
    if (existing) {
      const eligibleLegacy = existing.accountState === 'ACTIVE' && existing.authProvider === 'local' && Boolean(existing.passwordHash) && claims.emailVerified;
      if (!eligibleLegacy) return { status: 302, data: null, redirectTo: '/?auth=provider&status=link-required' };
      const token = crypto.randomUUID();
      pendingMigrations.set(token, {
        provider,
        subject: claims.sub,
        email: deps.identityStore.normalizeEmail(claims.email),
        userId: existing.userId,
        expiresAt: Date.now() + 10 * 60_000,
        used: false,
      });
      return { status: 302, data: null, redirectTo: `/?auth=provider&status=migration-required&migration=${encodeURIComponent(token)}` };
    }
    identity = deps.identityStore.createSocialAccount(claims.email, provider).identity;
    deps.socialIdentityStore.create(provider, claims.sub, identity.userId);
  }
  if (identity.accountState === 'DELETED') return { status: 302, data: null, redirectTo: '/?auth=provider&status=account-deleted' };
  if (identity.accountState === 'DISABLED' || identity.accountState === 'DELETION_PENDING') {
    const recoveryToken = crypto.randomUUID();
    pendingRecoveries.set(recoveryToken, { userId: identity.userId, state: identity.accountState, expiresAt: Date.now() + 10 * 60_000, used: false });
    return { status: 302, data: null, redirectTo: `/?auth=provider&status=${identity.accountState === 'DISABLED' ? 'account-disabled' : 'deletion-pending'}&recovery=${encodeURIComponent(recoveryToken)}` };
  }
  const session = deps.sessionStore.createAuthSession(`ten_${identity.userId}`, identity.userId, 'MAIN');
  deps.identityStore.updateLastLogin(identity.userId);
  return { status: 302, headers: COOKIE(session.sessionId), data: null, redirectTo: '/' };
};
