import { NagexError } from '../../common/errors.js';

// Scopes configured on the NAgex Google Cloud OAuth client — must match exactly
// what was registered there, not a broader or narrower set chosen independently.
export const GOOGLE_CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.events.freebusy',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
] as const;

// A single scope covers every Gmail tool NAgex implements (search, read
// thread, create/manage drafts, send, reply) short of permanent deletion —
// see MASTER.md's Gmail LIVE section. Requesting the narrowest sufficient
// scope rather than one scope per tool.
export const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.modify'] as const;

// The full set requested at the OAuth consent screen — one Google
// connection covers both Calendar and Gmail. An account connected before
// Gmail scopes existed will not have gmail.modify granted yet and must
// reconnect once (see ToolRegistry's live-status checks, which verify the
// scope is actually present, not just that a connection exists).
export const GOOGLE_OAUTH_SCOPES = [...GOOGLE_CALENDAR_SCOPES, ...GMAIL_SCOPES] as const;

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface GoogleTokenResponse {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number; // epoch ms
  scope: string;
  tokenType?: string | null;
}

type FetchFn = typeof fetch;

export function readGoogleOAuthConfig(env: NodeJS.ProcessEnv = process.env): GoogleOAuthConfig | null {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  const redirectUri = env.GOOGLE_REDIRECT_URI?.trim();
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri };
}

export function buildGoogleAuthorizeUrl(config: GoogleOAuthConfig, state: string): string {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', GOOGLE_OAUTH_SCOPES.join(' '));
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('state', state);
  return url.toString();
}

interface GoogleTokenApiPayload {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

async function postToken(body: URLSearchParams, fetchFn: FetchFn, requestId: string, now: () => number): Promise<GoogleTokenResponse> {
  let response: Response;
  try {
    response = await fetchFn('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch {
    throw new NagexError({
      code: 'GOOGLE_OAUTH_NETWORK_ERROR',
      category: 'PROVIDER',
      message: 'Could not reach Google OAuth token endpoint.',
      request_id: requestId,
    });
  }

  const payload = (await response.json().catch(() => ({}))) as GoogleTokenApiPayload;

  if (!response.ok || !payload.access_token) {
    throw new NagexError({
      code: 'GOOGLE_OAUTH_TOKEN_EXCHANGE_FAILED',
      category: response.status === 401 || response.status === 403 ? 'AUTHENTICATION' : 'PROVIDER',
      message: payload.error_description || payload.error || `Google OAuth token exchange failed with HTTP ${response.status}.`,
      request_id: requestId,
    });
  }

  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? null,
    expiresAt: now() + Math.max(0, (payload.expires_in ?? 3600) - 60) * 1000, // refresh 60s early
    scope: payload.scope ?? GOOGLE_OAUTH_SCOPES.join(' '),
    tokenType: payload.token_type ?? null,
  };
}

export async function exchangeGoogleAuthorizationCode(
  config: GoogleOAuthConfig,
  code: string,
  fetchFn: FetchFn,
  requestId: string,
  now: () => number = Date.now,
): Promise<GoogleTokenResponse> {
  const body = new URLSearchParams({
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    grant_type: 'authorization_code',
  });
  return postToken(body, fetchFn, requestId, now);
}

export async function refreshGoogleAccessToken(
  config: GoogleOAuthConfig,
  refreshToken: string,
  fetchFn: FetchFn,
  requestId: string,
  now: () => number = Date.now,
): Promise<GoogleTokenResponse> {
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: 'refresh_token',
  });
  const refreshed = await postToken(body, fetchFn, requestId, now);
  // Google does not resend the refresh token on refresh; keep the original.
  return { ...refreshed, refreshToken: refreshed.refreshToken ?? refreshToken };
}

// Best-effort: revoking with Google must never block a local disconnect —
// network failure or an already-invalid token here is not fatal.
export async function revokeGoogleToken(token: string, fetchFn: FetchFn): Promise<void> {
  try {
    await fetchFn(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: 'POST' });
  } catch {
    /* ignore — local disconnect proceeds regardless */
  }
}
