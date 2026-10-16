// The one place that knows the service's public address. Deployments set NAGEX_PUBLIC_URL once (the canonical origin people use, for example https://nagex.agex.site);
// every address that has to match what the browser and the identity providers see - the OAuth redirect URIs, the enterprise SSO callback - is derived from it unless that
// integration has its own explicit setting. Nothing else in the code names a host.
//
//   * origin only: https, or http for a loopback host (local development); no credentials, path, query or fragment
//   * an invalid value is ignored (and reported by describePublicUrl) - it never silently becomes a redirect URI
//   * unset: nothing is derived, so an integration without its own explicit redirect URI stays "not configured"

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])$/i;

export interface PublicUrlStatus {
  configured: boolean;
  value: string | null;
  problem: 'NOT_AN_URL' | 'NOT_AN_ORIGIN' | 'INSECURE_SCHEME' | null;
}

export function describePublicUrl(env: NodeJS.ProcessEnv = process.env): PublicUrlStatus {
  const raw = (env.NAGEX_PUBLIC_URL ?? '').trim();
  if (!raw) return { configured: false, value: null, problem: null };
  let url: URL;
  try { url = new URL(raw); } catch { return { configured: true, value: null, problem: 'NOT_AN_URL' }; }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) return { configured: true, value: null, problem: 'NOT_AN_ORIGIN' };
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.test(url.hostname))) return { configured: true, value: null, problem: 'INSECURE_SCHEME' };
  return { configured: true, value: url.origin, problem: null };
}

/** The canonical origin ("https://host"), or null when none is configured or the setting is invalid. */
export function canonicalPublicUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  return describePublicUrl(env).value;
}

/** The redirect URI of an integration: its explicit setting wins; otherwise it is derived from the canonical origin; otherwise there is none. */
export function redirectUriFor(explicit: string | undefined, path: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const own = explicit?.trim();
  if (own) return own;
  const base = canonicalPublicUrl(env);
  return base ? base + path : undefined;
}

// The callback paths the routes serve - the only place they are spelled out, so the routes' own tests and the deployment documentation can be checked against them.
export const OAUTH_CALLBACK_PATHS = Object.freeze({
  googleConnection: '/api/v1/oauth/google/callback',
  githubConnection: '/api/v1/oauth/github/callback',
  googleLogin: '/api/v1/auth/oauth/google/callback',
  microsoftLogin: '/api/v1/auth/oauth/microsoft/callback',
  enterpriseOidc: '/api/v1/auth/oidc/callback',
});
