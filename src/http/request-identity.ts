// R23.7C-C — Shared Artifact/Request Identity Resolver.
//
// Canonical basis: docs/canonical/NAgex_Trust_Identity_Privacy_and_Approval.md
// Section 6 ("user-facing identity and authentication state must not be
// inferred from UI-only state") and Section 13
// (TENANT_OR_OWNER_MISMATCH -> NOT_FOUND / DENY).
//
// A real authenticated nagex_session (R13) is the only identity source a
// native browser request can carry automatically — an <img>/<video>/<a>
// tag can never attach a custom header, only same-origin cookies. When a
// valid session is present it is authoritative: caller-supplied
// X-NAgex-Tenant/X-Principal-Id headers are never consulted, which is what
// closes the impersonation gap (a signed-in user's session cannot be
// outvoted by a spoofed header).
//
// When no valid session exists, resolution falls back to the existing
// header/default behavior unchanged, field-for-field — this preserves demo
// mode and every current caller (including this repo's own tests and the
// existing admin/default single-tenant flow) exactly as before. Removing
// that fallback is explicitly out of scope here; see the recorded
// IMAGE_BROWSER_AUTH_DEBT — header/default identity is not production
// multi-user authentication.
//
// Every artifact-serving route (images today; video/presentation/report
// later, per R23.7C-C Phase 8) should call this instead of re-implementing
// header/session precedence on its own.
import { DEFAULT_GOOGLE_TENANT_ID } from '../integrations/google/token.store.js';
import type { IdentityStore } from '../identity/identity.store.js';
import type { SessionStore } from '../sessions/session.store.js';
import { getSessionIdFromHeaders } from './routes/auth.routes.js';

export type RequestIdentitySource = 'SESSION' | 'HEADER' | 'DEFAULT';

export interface RequestIdentity {
  tenantId: string;
  principalId: string;
  source: RequestIdentitySource;
}

export interface ResolveRequestIdentityDeps {
  sessionStore?: SessionStore;
}

function getHeaderValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function parseSessionCookie(headers: Record<string, string | string[] | undefined>): string | undefined {
  const cookieHeader = getHeaderValue(headers, 'cookie');
  if (!cookieHeader) return undefined;
  const match = cookieHeader.match(/(?:^|;\s*)nagex_session=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : undefined;
}

export function resolveRequestIdentity(
  headers: Record<string, string | string[] | undefined>,
  deps: ResolveRequestIdentityDeps
): RequestIdentity {
  if (deps.sessionStore) {
    const sessionId = parseSessionCookie(headers);
    if (sessionId) {
      const session = deps.sessionStore.getSession(sessionId);
      if (session) {
        return { tenantId: session.tenantId, principalId: session.principalId, source: 'SESSION' };
      }
    }
  }

  const headerTenant = getHeaderValue(headers, 'x-nagex-tenant');
  const headerPrincipal = getHeaderValue(headers, 'x-principal-id');
  if (headerTenant || headerPrincipal) {
    return {
      tenantId: headerTenant || DEFAULT_GOOGLE_TENANT_ID,
      principalId: headerPrincipal || 'usr_admin_001',
      source: 'HEADER',
    };
  }

  return { tenantId: DEFAULT_GOOGLE_TENANT_ID, principalId: 'usr_admin_001', source: 'DEFAULT' };
}

// ─────────────────────────────────────────────────────────────────────────
// R24.6C — Settings identity boundary.
//
// Two rules, enforced from one place so they cannot drift per route:
//
//  1. AUTHENTICATED OWNERSHIP IS SERVER-SIDE. resolveAuthenticatedIdentity()
//     is the only thing a personal-Settings route may use to decide WHO is
//     calling: a valid, unexpired, unrevoked session whose account still
//     exists. userId/tenantId/principalId come from the session record
//     (tenant = ten_<userId>, the account's personal tenant). A body, a
//     query string, or X-Principal-Id / X-NAgex-Tenant are never consulted.
//
//  2. CLIENT IDENTITY HEADERS CANNOT OVERRIDE OWNERSHIP ANYWHERE.
//     canonicalizeRequestHeaders() runs at both HTTP entry points before any
//     route sees the request:
//       - valid session  -> the identity headers are REPLACED by the
//         session's identity, so every route that still reads them (memory
//         capture, Daily Brief, calendar, ...) acts as the signed-in user and
//         a forged header cannot name another user or tenant;
//       - no session     -> the legacy default/demo behavior is unchanged,
//         EXCEPT that a header naming a real registered account (or that
//         account's personal tenant) is stripped — an anonymous caller can
//         never impersonate a real user by typing their id.
//     Headers naming non-account principals (the default admin, demo users)
//     keep working for unauthenticated legacy/demo flows; that fallback is
//     the recorded IMAGE_BROWSER_AUTH_DEBT and is out of scope here.
// ─────────────────────────────────────────────────────────────────────────
export interface AuthenticatedIdentity {
  userId: string;
  principalId: string;
  tenantId: string;
  sessionId: string;
}

export interface AuthIdentityDeps {
  sessionStore: SessionStore;
  identityStore: IdentityStore;
}

export function resolveAuthenticatedIdentity(
  headers: Record<string, string | string[] | undefined>,
  deps: AuthIdentityDeps
): AuthenticatedIdentity | null {
  const sessionId = getSessionIdFromHeaders(headers);
  if (!sessionId) return null;
  const session = deps.sessionStore.getSession(sessionId);
  if (!session) return null;
  const identity = deps.identityStore.getByUserId(session.principalId);
  if (!identity || identity.accountState === 'DELETED') return null;
  return { userId: identity.userId, principalId: identity.userId, tenantId: session.tenantId, sessionId: session.sessionId };
}

const CLIENT_IDENTITY_HEADERS = new Set(['x-nagex-tenant', 'x-principal-id']);

export function canonicalizeRequestHeaders(
  headers: Record<string, string | string[] | undefined>,
  deps: AuthIdentityDeps
): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!CLIENT_IDENTITY_HEADERS.has(key.toLowerCase())) out[key] = value;
  }

  const auth = resolveAuthenticatedIdentity(headers, deps);
  if (auth) {
    out['x-nagex-tenant'] = auth.tenantId;
    out['x-principal-id'] = auth.principalId;
    return out;
  }

  const claimedTenant = getHeaderValue(headers, 'x-nagex-tenant');
  const claimedPrincipal = getHeaderValue(headers, 'x-principal-id');
  const personalTenantOwner = claimedTenant && claimedTenant.startsWith('ten_') ? claimedTenant.slice(4) : undefined;
  const namesRealAccount =
    (claimedPrincipal !== undefined && deps.identityStore.getByUserId(claimedPrincipal) !== null) ||
    (personalTenantOwner !== undefined && deps.identityStore.getByUserId(personalTenantOwner) !== null);
  if (!namesRealAccount) {
    if (claimedTenant !== undefined) out['x-nagex-tenant'] = claimedTenant;
    if (claimedPrincipal !== undefined) out['x-principal-id'] = claimedPrincipal;
  }
  return out;
}
