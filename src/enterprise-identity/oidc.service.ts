// R16 §6-10 — OIDC Authorization Code + PKCE flow and real, from-scratch
// (no jose/jsonwebtoken dependency — matches this codebase's established
// "hand-roll with node:crypto" convention, see src/device-agent/
// device-transport-security.ts's crypto.verify() usage) ID token
// verification: signature (RS256 only — "alg: none" and any other
// algorithm are explicitly rejected, not just "not handled"), issuer,
// audience, expiration, and nonce.
//
// Every external HTTP call takes an explicit fetchFn: typeof fetch
// parameter (never reaches for global fetch internally) — the same
// dependency-injection convention src/integrations/google/oauth.client.ts
// already uses, for the same reason: tests inject a stub, production
// passes real global fetch at the call site.
import crypto from 'node:crypto';
import { NagexError } from '../common/errors.js';
import type { OidcProviderConfig } from './enterprise-identity.types.js';

export interface JsonWebKey {
  kty: string;
  kid?: string;
  use?: string;
  alg?: string;
  n?: string;
  e?: string;
  [key: string]: unknown;
}

export interface JwksDocument {
  keys: JsonWebKey[];
}

export interface DecodedIdTokenClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean;
  [key: string]: unknown;
}

function base64UrlDecode(input: string): Buffer {
  return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function base64UrlEncode(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function fetchJwks(jwksUri: string, fetchFn: typeof fetch): Promise<JwksDocument> {
  let response: Response;
  try {
    response = await fetchFn(jwksUri);
  } catch (error) {
    throw new NagexError({ code: 'OIDC_JWKS_FETCH_FAILED', category: 'PROVIDER', message: `Could not reach jwks_uri: ${error instanceof Error ? error.message : String(error)}` });
  }
  if (!response.ok) {
    throw new NagexError({ code: 'OIDC_JWKS_FETCH_FAILED', category: 'PROVIDER', message: `jwks_uri returned HTTP ${response.status}` });
  }
  const body = (await response.json()) as JwksDocument;
  if (!body || !Array.isArray(body.keys)) {
    throw new NagexError({ code: 'OIDC_JWKS_INVALID', category: 'PROVIDER', message: 'jwks_uri did not return a valid JWK Set.' });
  }
  return body;
}

export interface OidcDiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

// R16 §7 — "가능하면 OIDC discovery 지원" (best-effort). Never required —
// callers may always configure the four endpoints directly instead.
export async function discoverOidcConfiguration(issuer: string, fetchFn: typeof fetch): Promise<OidcDiscoveryDocument> {
  const base = issuer.endsWith('/') ? issuer.slice(0, -1) : issuer;
  const url = `${base}/.well-known/openid-configuration`;
  let response: Response;
  try {
    response = await fetchFn(url);
  } catch (error) {
    throw new NagexError({ code: 'OIDC_DISCOVERY_FAILED', category: 'PROVIDER', message: `Could not reach discovery endpoint: ${error instanceof Error ? error.message : String(error)}` });
  }
  if (!response.ok) {
    throw new NagexError({ code: 'OIDC_DISCOVERY_FAILED', category: 'PROVIDER', message: `Discovery endpoint returned HTTP ${response.status}` });
  }
  const doc = (await response.json()) as Partial<OidcDiscoveryDocument>;
  if (!doc.issuer || !doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
    throw new NagexError({ code: 'OIDC_DISCOVERY_INVALID', category: 'PROVIDER', message: 'Discovery document is missing required fields.' });
  }
  return doc as OidcDiscoveryDocument;
}

export function buildAuthorizationUrl(config: OidcProviderConfig, params: { state: string; nonce: string; codeVerifier: string; redirectUri: string }): string {
  const codeChallenge = base64UrlEncode(crypto.createHash('sha256').update(params.codeVerifier).digest());
  const url = new URL(config.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('scope', config.scopes.join(' '));
  url.searchParams.set('state', params.state);
  url.searchParams.set('nonce', params.nonce);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export interface TokenExchangeResult {
  idToken: string;
  accessToken: string | null;
}

export async function exchangeAuthorizationCode(
  config: OidcProviderConfig,
  clientSecret: string,
  code: string,
  redirectUri: string,
  codeVerifier: string,
  fetchFn: typeof fetch,
): Promise<TokenExchangeResult> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: config.clientId,
    client_secret: clientSecret,
    code_verifier: codeVerifier,
  });
  let response: Response;
  try {
    response = await fetchFn(config.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch (error) {
    throw new NagexError({ code: 'OIDC_TOKEN_EXCHANGE_FAILED', category: 'PROVIDER', message: `Could not reach token_endpoint: ${error instanceof Error ? error.message : String(error)}` });
  }
  if (!response.ok) {
    // Never surface the raw response body — it may echo back the code/
    // client_secret in an error payload from a misbehaving IdP.
    throw new NagexError({ code: 'OIDC_TOKEN_EXCHANGE_FAILED', category: 'AUTHENTICATION', message: `token_endpoint returned HTTP ${response.status}` });
  }
  const json = (await response.json()) as { id_token?: string; access_token?: string };
  if (!json.id_token) {
    throw new NagexError({ code: 'OIDC_TOKEN_EXCHANGE_FAILED', category: 'AUTHENTICATION', message: 'Token response did not include an id_token.' });
  }
  return { idToken: json.id_token, accessToken: json.access_token ?? null };
}

// R16 §10/§70 — every one of these checks is mandatory; any single
// failure denies authentication. The algorithm allowlist (RS256 only) is
// checked BEFORE any attempt to verify a signature, closing off the
// classic "alg: none" / algorithm-confusion JWT forgery class entirely —
// an attacker cannot get an unsigned or symmetric-key-signed token
// treated as valid no matter what the token header claims.
export function verifyIdToken(idToken: string, options: { issuer: string; audience: string; jwks: JwksDocument; expectedNonce: string; now?: number }): DecodedIdTokenClaims {
  const now = options.now ?? Date.now();
  const parts = idToken.split('.');
  if (parts.length !== 3) {
    throw new NagexError({ code: 'OIDC_TOKEN_MALFORMED', category: 'AUTHENTICATION', message: 'ID token is not a well-formed JWT.' });
  }
  const [headerB64, payloadB64, signatureB64] = parts;

  let header: { alg?: string; kid?: string };
  let claims: DecodedIdTokenClaims;
  try {
    header = JSON.parse(base64UrlDecode(headerB64).toString('utf8'));
    claims = JSON.parse(base64UrlDecode(payloadB64).toString('utf8'));
  } catch {
    throw new NagexError({ code: 'OIDC_TOKEN_MALFORMED', category: 'AUTHENTICATION', message: 'ID token header/payload is not valid JSON.' });
  }

  if (header.alg !== 'RS256') {
    throw new NagexError({ code: 'OIDC_SIGNATURE_INVALID', category: 'AUTHENTICATION', message: `Unsupported or forged signing algorithm "${String(header.alg)}" — only RS256 is accepted.` });
  }

  const jwk = options.jwks.keys.find((k) => (header.kid ? k.kid === header.kid : true) && k.kty === 'RSA');
  if (!jwk) {
    throw new NagexError({ code: 'OIDC_SIGNATURE_INVALID', category: 'AUTHENTICATION', message: 'No matching RSA key found in jwks_uri for this token\'s kid.' });
  }

  let publicKey: crypto.KeyObject;
  try {
    const jwkInput = { key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: 'jwk' } as unknown as Parameters<typeof crypto.createPublicKey>[0];
    publicKey = crypto.createPublicKey(jwkInput);
  } catch {
    throw new NagexError({ code: 'OIDC_SIGNATURE_INVALID', category: 'AUTHENTICATION', message: 'Could not import the JWKS RSA key.' });
  }

  const signingInput = `${headerB64}.${payloadB64}`;
  const signatureValid = (() => {
    try {
      return crypto.verify('RSA-SHA256', Buffer.from(signingInput, 'utf8'), { key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING }, base64UrlDecode(signatureB64));
    } catch {
      return false;
    }
  })();
  if (!signatureValid) {
    throw new NagexError({ code: 'OIDC_SIGNATURE_INVALID', category: 'AUTHENTICATION', message: 'ID token signature verification failed.' });
  }

  if (claims.iss !== options.issuer) {
    throw new NagexError({ code: 'OIDC_ISSUER_MISMATCH', category: 'AUTHENTICATION', message: 'ID token issuer does not match the configured provider issuer.' });
  }

  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(options.audience)) {
    throw new NagexError({ code: 'OIDC_AUDIENCE_MISMATCH', category: 'AUTHENTICATION', message: 'ID token audience does not include this provider\'s client_id.' });
  }

  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now) {
    throw new NagexError({ code: 'OIDC_TOKEN_EXPIRED', category: 'AUTHENTICATION', message: 'ID token has expired.' });
  }

  if (claims.nonce !== options.expectedNonce) {
    throw new NagexError({ code: 'OIDC_NONCE_MISMATCH', category: 'AUTHENTICATION', message: 'ID token nonce does not match the value issued for this login attempt.' });
  }

  return claims;
}
