// S1 — TEST-ONLY helper: sign a synthetic caller in through the REAL identity boundary.
//
// After Security Gate S1 the server derives identity only from a server-side session; a request
// that merely carries X-Principal-Id / X-NAgex-Tenant has no authority. A test that needs "a
// caller in tenant T acting as principal P" therefore creates a real account record and a real
// session in the same stores the server uses, and sends the session cookie — exactly what a
// browser does. This file lives under tests/ and is compiled only into the test build; nothing
// here is reachable from production code or any HTTP route.
import { identityStore as defaultIdentityStore, sessionStore as defaultSessionStore } from '../src/server_web.js';
import type { IdentityStore } from '../src/identity/identity.store.js';
import type { SessionStore } from '../src/sessions/session.store.js';
import { canonicalizeRequestHeaders, tryGetCallerIdentity } from '../src/http/request-identity.js';

export interface TestAuthStores {
  identityStore?: IdentityStore;
  sessionStore?: SessionStore;
}

const registered = new WeakMap<IdentityStore, Set<string>>();
const cookieCache = new WeakMap<SessionStore, Map<string, string>>();

// Registers (once) an ACTIVE account whose userId is exactly `principalId`. In-memory only: it is
// written into the store's map and never persisted or reachable through signup.
export function ensureTestAccount(principalId: string, identityStore: IdentityStore = defaultIdentityStore): void {
  let ids = registered.get(identityStore);
  if (!ids) registered.set(identityStore, (ids = new Set()));
  if (ids.has(principalId) || identityStore.getByUserId(principalId)) { ids.add(principalId); return; }
  const now = new Date().toISOString();
  (identityStore as unknown as { identities: Map<string, unknown> }).identities.set(principalId, {
    userId: principalId,
    email: `${principalId}@s1-test.invalid`,
    passwordHash: '',
    authProvider: 'local',
    verificationStatus: 'VERIFIED',
    accountState: 'ACTIVE',
    createdAt: now,
    lastLoginAt: null,
    passwordChangedAt: null,
    disabledAt: null,
    deletionRequestedAt: null,
    scheduledPurgeAt: null,
  });
  ids.add(principalId);
}

// A real session for (tenantId, principalId); returns the headers a browser would send, ALREADY passed
// through the same canonicalization the server applies at its HTTP entry points. That makes the object
// usable both ways: sent over HTTP / to handleApiRequest (which canonicalizes again from the cookie), and
// handed straight to a route registrar in a unit test (which needs the verified-identity registration).
// Spreading it into a new object drops the registration (by design) but keeps the cookie.
export function authAs(tenantId: string, principalId: string, stores: TestAuthStores = {}): { cookie: string } {
  const identityStore = stores.identityStore ?? defaultIdentityStore;
  const sessionStore = stores.sessionStore ?? defaultSessionStore;
  ensureTestAccount(principalId, identityStore);
  let cache = cookieCache.get(sessionStore);
  if (!cache) cookieCache.set(sessionStore, (cache = new Map()));
  const key = `${tenantId}\u0000${principalId}`;
  let id = cache.get(key);
  if (!id || !sessionStore.getSession(id)) {
    id = sessionStore.createAuthSession(tenantId, principalId, 'MAIN').sessionId;
    cache.set(key, id);
  }
  const raw = { cookie: `nagex_session=${encodeURIComponent(id)}` };
  return canonicalizeRequestHeaders(raw, { sessionStore, identityStore }) as { cookie: string };
}

// ── "the caller" wrapper for tests whose SUBJECT is product behavior, not authentication ──
//
// Many older tests drive handleApiRequest / handleAsyncApiRequest with no headers at all and relied on
// the (now removed) default-admin fallback to be "the user". This wraps an entry point so that a call
// that carries no credential of its own is made as a real signed-in account — a real account record and
// a real session — instead. A call that already carries a cookie / bearer token / verified identity is
// passed through untouched, so a test can still make an anonymous-style call by building its own headers.
// Tests about authentication itself (forged headers, anonymous denial) must NOT use this wrapper.
export const TEST_DEFAULT_TENANT = 'ten_production_01';
export const TEST_DEFAULT_PRINCIPAL = 'usr_admin_001';

type Headers = Record<string, string | string[] | undefined>;

export function withDefaultCaller<F extends (...args: any[]) => any>(entryPoint: F, who: { tenantId?: string; principalId?: string } = {}): F {
  return ((method: string, pathname: string, body: unknown, headers?: Headers, ...rest: unknown[]) => {
    const carriesCredential = Boolean(headers && (headers['cookie'] || headers['Cookie'] || headers['authorization'] || headers['Authorization'] || tryGetCallerIdentity(headers)));
    const effective = carriesCredential ? headers : { ...(headers ?? {}), cookie: authAs(who.tenantId ?? TEST_DEFAULT_TENANT, who.principalId ?? TEST_DEFAULT_PRINCIPAL).cookie };
    return entryPoint(method, pathname, body, effective, ...rest);
  }) as F;
}

// authAs() plus extra NON-identity headers (x-request-id, content-type, ...), still canonicalized so the
// result can be handed straight to a route registrar. Identity headers in `extra` are discarded.
export function authAsWith(tenantId: string, principalId: string, extra: Record<string, string>, stores: TestAuthStores = {}): Record<string, string> {
  const identityStore = stores.identityStore ?? defaultIdentityStore;
  const sessionStore = stores.sessionStore ?? defaultSessionStore;
  const { cookie } = authAs(tenantId, principalId, stores);
  return canonicalizeRequestHeaders({ ...extra, cookie }, { sessionStore, identityStore }) as Record<string, string>;
}

// ── for tests that stand up their OWN http server in front of a route registrar ──
// Such a server must do what the real server does — canonicalize the request headers from the session
// cookie before the route sees them — and the browser must carry a session cookie.
export function canonicalizeForTestServer(headers: Record<string, string | string[] | undefined>, stores: TestAuthStores = {}): Record<string, string | string[] | undefined> {
  return canonicalizeRequestHeaders(headers, { sessionStore: stores.sessionStore ?? defaultSessionStore, identityStore: stores.identityStore ?? defaultIdentityStore });
}

// A Playwright cookie for a real signed-in session of (tenantId, principalId) against `origin`.
export function sessionCookie(origin: string, tenantId: string, principalId: string, stores: TestAuthStores = {}): { name: string; value: string; url: string } {
  const { cookie } = authAs(tenantId, principalId, stores);
  return { name: 'nagex_session', value: decodeURIComponent(cookie.split('=')[1]), url: origin };
}
