// Request identity — Security Gate S1 (Identity Boundary).
//
// Canonical basis: docs/canonical/NAgex_Trust_Identity_Privacy_and_Approval.md
// (§6 identity must not be inferred from client state; §13 TENANT_OR_OWNER_MISMATCH
// -> NOT_FOUND / DENY) and docs/NAgex_AI_Development_Governance.md §10.
//
// THE RULE
//   Identity originates from a server-side credential: a valid, unexpired,
//   unrevoked session whose account still exists. Nothing the client types —
//   X-Principal-Id, X-NAgex-Tenant, a body field, a query string — is ever
//   authority. There is no default principal, no default tenant and no
//   built-in admin that an unauthenticated request can fall back to.
//
// HOW IT WORKS (one architecture, not two)
//   1. canonicalizeRequestHeaders() runs at both HTTP entry points. It returns
//      a COPY of the headers with every client identity header removed, and —
//      if a valid session is presented — records the session's identity in a
//      module-private registry keyed by that copy.
//   2. route-access.ts decides, per route, whether anonymous access is allowed.
//      Every route that is not explicitly public or self-authenticating
//      requires an identity from step 1 or is answered 401.
//   3. A route reads the caller with callerIdentity(headers). That works only
//      for a headers object that went through step 1; a raw object carrying a
//      forged X-Principal-Id yields no identity at all (it throws).
//
// resolveAuthenticatedIdentity() remains the single session resolver.
import { NagexError } from '../common/errors.js';
import { DEMO_OWNER_ID, DEMO_TENANT_ID } from '../demo/demo-identity.js';
import type { IdentityStore } from '../identity/identity.store.js';
import type { SessionStore } from '../sessions/session.store.js';
import { getSessionIdFromHeaders } from './session-credential.js';
import { carryResolvedClientIp } from './client-ip.js';

export { getSessionIdFromHeaders } from './session-credential.js';

type HeaderBag = Record<string, string | string[] | undefined>;

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

// SESSION: a real authenticated account.
// DEMO: the fixed, server-defined synthetic demo persona, granted only by
//       route-access.ts on an explicit read-only allow-list (see there).
export type CallerIdentitySource = 'SESSION' | 'DEMO';

export interface CallerIdentity {
  tenantId: string;
  principalId: string;
  source: CallerIdentitySource;
  sessionId?: string;
}

// Identities established by the server for a specific (canonicalized) headers
// object. WeakMap: no leak, and a copy/spread of the headers object does NOT
// carry the identity along, so it can never be inherited by accident.
const VERIFIED_CALLER = new WeakMap<object, CallerIdentity>();

export function resolveAuthenticatedIdentity(headers: HeaderBag, deps: AuthIdentityDeps): AuthenticatedIdentity | null {
  const sessionId = getSessionIdFromHeaders(headers);
  if (!sessionId) return null;
  const session = deps.sessionStore.getSession(sessionId);
  if (!session) return null;
  const identity = deps.identityStore.getByUserId(session.principalId);
  if (!identity || identity.accountState === 'DELETED') return null;
  return { userId: identity.userId, principalId: identity.userId, tenantId: session.tenantId, sessionId: session.sessionId };
}

// Client-asserted identity. These headers are never read as authority; they are
// removed so no downstream code can ever mistake them for it.
const CLIENT_IDENTITY_HEADERS = new Set(['x-nagex-tenant', 'x-principal-id', 'x-tenant-id', 'x-user-id']);

export function canonicalizeRequestHeaders(headers: HeaderBag, deps: AuthIdentityDeps): HeaderBag {
  const out: HeaderBag = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!CLIENT_IDENTITY_HEADERS.has(key.toLowerCase())) out[key] = value;
  }
  // S2E — the address the HTTP layer resolved for this request (if any) travels with the canonical copy; a header value
  // such as X-Forwarded-For is just a stripped-nothing header and is never read as an address.
  carryResolvedClientIp(headers, out);
  const auth = resolveAuthenticatedIdentity(headers, deps);
  if (auth) VERIFIED_CALLER.set(out, { tenantId: auth.tenantId, principalId: auth.principalId, source: 'SESSION', sessionId: auth.sessionId });
  return out;
}

// Used by route-access.ts for the explicit demo allow-list only.
export function attachDemoIdentity(headers: HeaderBag): CallerIdentity {
  const demo: CallerIdentity = { tenantId: DEMO_TENANT_ID, principalId: DEMO_OWNER_ID, source: 'DEMO' };
  VERIFIED_CALLER.set(headers, demo);
  return demo;
}

export function tryGetCallerIdentity(headers: HeaderBag | undefined): CallerIdentity | null {
  if (!headers || typeof headers !== 'object') return null;
  return VERIFIED_CALLER.get(headers) ?? null;
}

// The ONLY way a route obtains tenant/principal. Fails closed.
export function callerIdentity(headers: HeaderBag | undefined): CallerIdentity {
  const caller = tryGetCallerIdentity(headers);
  if (!caller) {
    throw new NagexError({ code: 'AUTHENTICATION_REQUIRED', category: 'AUTHENTICATION', message: 'Sign in to continue.', request_id: 'req_auth_required' });
  }
  return caller;
}
