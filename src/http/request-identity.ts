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
import type { SessionStore } from '../sessions/session.store.js';

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
