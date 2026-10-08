// Route access policy — Security Gate S1 (Identity Boundary).
//
// DEFAULT DENY. A request may proceed without an authenticated identity ONLY if
// its (method, path) matches a rule below; every other route needs an identity
// established by request-identity.ts (a valid server-side session) and is
// answered 401 otherwise. A new route is therefore protected by default — it
// must be added here, with a reason, to become reachable anonymously.
//
// Rule classes
//   PUBLIC              pre-authentication by protocol (signup, login, SSO
//                       callbacks, catalog, health). Reachable by anyone.
//   SELF_AUTHENTICATED  the handler itself requires a session/bearer/signature
//                       and fails closed. Listed so the gate does not change its
//                       established error contract. tests/security_s1_* proves
//                       every one of these denies an anonymous caller.
//   SIGNED_WEBHOOK     an inbound platform webhook (Telegram, Slack). There is no session: the request must prove it came from
//                       the platform. The handler verifies the server-configured secret / signature BEFORE any trusted
//                       processing and fails closed (src/integrations/webhook-auth.ts, Security Gate S2A, ADR-0007).
//   ANONYMOUS_PRESERVED Routes S0 classified UNKNOWN that never used the legacy
//                       identity mechanism. S1 does not change them; each is
//                       owned by a later Security Gate phase (noted per rule).
//
// Demo: a request carrying X-NAgex-Demo: 1 may reach the READ-ONLY routes in
// DEMO_READ_ROUTES as the fixed synthetic demo persona (src/demo/demo-identity.ts).
// It is a server-defined constant, not a client-supplied value, and it grants no
// write, no model, no browser and no Gmail/Calendar tool access.
import type { ApiResult } from './http-types.js';
import { attachDemoIdentity, tryGetCallerIdentity } from './request-identity.js';

export type RouteAccessClass = 'PUBLIC' | 'SELF_AUTHENTICATED' | 'SIGNED_WEBHOOK' | 'ANONYMOUS_PRESERVED';

export interface RouteAccessRule {
  methods: readonly string[] | '*';
  pattern: RegExp;
  access: RouteAccessClass;
  reason: string;
}

const rule = (methods: readonly string[] | '*', pattern: RegExp, access: RouteAccessClass, reason: string): RouteAccessRule => ({ methods, pattern, access, reason });

export const ROUTE_ACCESS_RULES: readonly RouteAccessRule[] = [
  // ── PUBLIC (protocol requires pre-auth access) ──
  rule(['GET'], /^\/api\/v1\/health$/, 'PUBLIC', 'liveness probe'),
  rule(['POST'], /^\/api\/v1\/auth\/(signup|verify-email|resend-verification|login|logout|forgot-password|reset-password)$/, 'PUBLIC', 'account entry flows; each carries its own credential or one-time token'),
  rule(['GET'], /^\/api\/v1\/auth\/session$/, 'PUBLIC', 'reports "unauthenticated" to a signed-out browser'),
  rule(['GET'], /^\/api\/v1\/auth\/providers$/, 'PUBLIC', 'configured sign-in provider catalog for the login UI'),
  rule(['GET'], /^\/api\/v1\/auth\/oauth\/(google|microsoft)\/(start|callback)$/, 'PUBLIC', 'social sign-in: the provider redirects an unauthenticated browser here'),
  rule(['GET', 'POST'], /^\/api\/v1\/auth\/oauth\/migration\/[^/]+$/, 'PUBLIC', 'explicit one-time legacy account OAuth migration confirmation'),
  rule(['GET'], /^\/api\/(?:v1\/)?auth\/sso\/discover$/, 'PUBLIC', 'SSO discovery before sign-in'),
  rule(['GET'], /^\/api\/(?:v1\/)?auth\/oidc\/[^/]+\/start$/, 'PUBLIC', 'OIDC login start'),
  rule(['GET'], /^\/api\/(?:v1\/)?auth\/oidc\/callback$/, 'PUBLIC', 'OIDC redirect callback (state + nonce + PKCE bound)'),
  rule(['GET'], /^\/api\/(?:v1\/)?auth\/saml\/[^/]+\/start$/, 'PUBLIC', 'SAML login start'),
  rule(['POST'], /^\/api\/(?:v1\/)?auth\/saml\/callback$/, 'PUBLIC', 'SAML ACS (signature + InResponseTo + replay bound)'),
  rule(['POST'], /^\/api\/v1\/account\/(email\/confirm|reactivate|delete\/cancel)$/, 'PUBLIC', 'credential-in-body / one-time-token account recovery (password-testing routes share the S2E auth-abuse guard: per-IP, per-account and pair throttling, refused before hashing)'),
  rule(['GET'], /^\/api\/v1\/(skills|tools|agents)$/, 'PUBLIC', 'static product catalog, no tenant data'),
  rule(['GET'], /^\/api\/v1\/capabilities\/status$/, 'PUBLIC', 'capability availability flag, no tenant data'),
  rule(['POST'], /^\/api\/v1\/device-agent\/message$/, 'PUBLIC', 'device transport: authenticated by the enrolled device signature, not a session'),

  // ── SELF_AUTHENTICATED (handler enforces a session / bearer token and fails closed) ──
  rule(['POST'], /^\/api\/v1\/auth\/logout-all$/, 'SELF_AUTHENTICATED', 'requires a session'),
  rule('*', /^\/api\/v1\/account(\/|$)/, 'SELF_AUTHENTICATED', 'account routes require a session (public recovery routes listed above)'),
  rule('*', /^\/api\/(?:v1\/)?organizations(\/|$)/, 'SELF_AUTHENTICATED', 'organization, RBAC and enterprise-identity admin require a session'),
  rule(['POST'], /^\/api\/v1\/invitations\/[^/]+\/accept$/, 'SELF_AUTHENTICATED', 'requires a session'),
  rule('*', /^\/scim\/v2(\/|$)/, 'SELF_AUTHENTICATED', 'SCIM bearer token scoped to one organization'),
  rule('*', /^\/api\/v1\/oauth\/google\/(start|start-url|callback|status|disconnect)$/, 'SELF_AUTHENTICATED', 'Google connection: session + state nonce'),
  rule('*', /^\/api\/v1\/connections(\/|$)/, 'SELF_AUTHENTICATED', 'requires a session'),
  rule('*', /^\/api\/v1\/mobile\/messages(\/|$)/, 'SELF_AUTHENTICATED', 'requires a session'),
  rule(['POST'], /^\/api\/v1\/device-agent\/enroll$/, 'SELF_AUTHENTICATED', 'requires a session'),
  rule(['POST'], /^\/api\/v1\/device-agent\/devices\/[^/]+\/validate$/, 'SELF_AUTHENTICATED', 'requires a session and validates a cached local binding'),
  rule('*', /^\/api\/v1\/(quickwake|autonomy)\/config$/, 'SELF_AUTHENTICATED', 'personal settings, requires a session'),
  rule('*', /^\/api\/v1\/memory\/settings$/, 'SELF_AUTHENTICATED', 'personal settings, requires a session'),
  rule('*', /^\/api\/v1\/proactive-assistant\/config$/, 'SELF_AUTHENTICATED', 'personal settings, requires a session'),
  rule(['POST'], /^\/api\/v1\/plans$/, 'SELF_AUTHENTICATED', 'plan create, requires a session (ADR-0005)'),
  rule(['PUT'], /^\/api\/v1\/plans\/[^/]+$/, 'SELF_AUTHENTICATED', 'plan update, requires a session (ADR-0005)'),
  rule(['POST'], /^\/api\/v1\/artifacts\/[^/]+\/ask$/, 'SELF_AUTHENTICATED', 'Canvas Ask, requires a session (R24.7B)'),

  // ── ANONYMOUS_PRESERVED (S0 UNKNOWN; no legacy-identity dependency; owned by a later phase) ──
  rule(['GET'], /^\/api\/v1\/vcs\/status$/, 'ANONYMOUS_PRESERVED', 'S0-15 information disclosure — later phase'),
  rule(['GET'], /^\/api\/v1\/providers\/status$/, 'ANONYMOUS_PRESERVED', 'S0-15 — later phase (provider names/status only)'),
  rule('*', /^\/api\/v1\/desktop\/quickwake\//, 'ANONYMOUS_PRESERVED', 'local Electron shell control surface — later phase'),
  rule(['POST'], /^\/api\/v1\/capture\/link$/, 'ANONYMOUS_PRESERVED', 'S0-05 SSRF — later phase (no model, no tenant data)'),
  rule(['GET'], /^\/api\/v1\/integrations\/(telegram|slack)\/status$/, 'ANONYMOUS_PRESERVED', 'S0-06 — later phase (configured flag only)'),

  // ── SIGNED_WEBHOOK (platform-to-server; authenticated by secret / signature, not by a session) ──
  rule(['POST'], /^\/api\/v1\/integrations\/telegram\/webhook$/, 'SIGNED_WEBHOOK', 'S2A — Telegram secret-token header verified by the handler before any processing; fails closed'),
  rule(['POST'], /^\/api\/v1\/integrations\/slack\/events$/, 'SIGNED_WEBHOOK', 'S2A — Slack request signature over the raw body + replay window verified by the handler before any processing; fails closed'),
];

// Read-only routes the synthetic demo persona may reach (no model, no mutation).
const DEMO_READ_ROUTES: readonly RegExp[] = [
  /^\/api\/v1\/personal\/(home|right-now|context|suggestions)$/,
  /^\/api\/v1\/(my-space|workspace\/my-space)$/,
  /^\/api\/v1\/(tasks|approvals|notifications|activity|candidates|knowledge|memory)$/,
  /^\/api\/v1\/workspace\/(vault|inbox)$/,
];

export function classifyRouteAccess(method: string, pathname: string): RouteAccessRule | undefined {
  const m = method.toUpperCase();
  return ROUTE_ACCESS_RULES.find((r) => (r.methods === '*' || r.methods.includes(m)) && r.pattern.test(pathname));
}

function isDemoRequest(headers: Record<string, string | string[] | undefined>): boolean {
  const value = headers['x-nagex-demo'] ?? headers['X-NAgex-Demo'];
  return (Array.isArray(value) ? value[0] : value) === '1';
}

export const AUTHENTICATION_REQUIRED_RESULT = (): ApiResult => ({
  status: 401,
  data: { error: { code: 'AUTHENTICATION_REQUIRED', category: 'AUTHENTICATION', message: 'Sign in to continue.' } },
});

// `headers` MUST be the canonicalized object (request-identity.canonicalizeRequestHeaders).
// Returns null when the request may proceed, or the 401 result when it may not.
export function denyIfUnauthorized(method: string, pathname: string, headers: Record<string, string | string[] | undefined>): ApiResult | null {
  if (tryGetCallerIdentity(headers)) return null;
  if (classifyRouteAccess(method, pathname)) return null;
  if (isDemoRequest(headers) && method.toUpperCase() === 'GET' && DEMO_READ_ROUTES.some((p) => p.test(pathname))) {
    attachDemoIdentity(headers);
    return null;
  }
  return AUTHENTICATION_REQUIRED_RESULT();
}
