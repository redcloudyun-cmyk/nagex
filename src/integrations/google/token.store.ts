import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NagexError } from '../../common/errors.js';
import { resolveNagexDataFile } from '../../governance/file-record.store.js';
import { refreshGoogleAccessToken, revokeGoogleToken, type GoogleOAuthConfig, type GoogleTokenResponse } from './oauth.client.js';
import { loadEncryptionKey, encryptJson, decryptJson, type EncryptedEnvelope } from './token.crypto.js';

interface StoredGoogleToken {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  scope: string;
  tokenType: string | null;
  connectedAt: string;
  providerAccountRef: string;
  // A grant Google no longer honours (revoked, or expired without a refresh token) is NOT deleted: the connection
  // metadata stays so the user is told to reauthorize, but the unusable secrets are purged at once.
  authState?: 'ACTIVE' | 'REAUTH_REQUIRED';
  reauthReason?: GoogleReauthReason;
  reauthAt?: string;
}

export type GoogleReauthReason = 'TOKEN_REVOKED' | 'TOKEN_EXPIRED_NO_REFRESH' | 'TOKEN_REJECTED';

export interface GoogleConnectionStatus {
  // true only while a usable grant exists; a connection that needs reauthorization is NOT connected.
  connected: boolean;
  scopes: string[];
  expiresAt: string | null;
  authState: 'NONE' | 'ACTIVE' | 'REAUTH_REQUIRED';
  reauthReason: GoogleReauthReason | null;
  reauthAt: string | null;
}

export type GoogleAccessTokenFailure = 'NOT_CONNECTED' | 'REAUTH_REQUIRED' | 'PROVIDER_TIMEOUT' | 'PROVIDER_ERROR' | 'INTERNAL_ERROR';

// Discriminated outcome of obtaining a usable access token, so callers can tell "no connection" from "must reauthorize"
// from a transient provider problem (which keeps the connection) instead of treating every failure as "disconnected".
export type GoogleAccessTokenResult =
  | { ok: true; accessToken: string }
  | { ok: false; reason: GoogleAccessTokenFailure; reauthReason?: GoogleReauthReason; code?: string };

type FetchFn = typeof fetch;

// Abstraction boundary for OAuth token persistence. PersistentGoogleOAuthTokenStore
// (below) is the current implementation; a future DB-backed implementation of
// this same interface can replace it without touching any caller (ToolRegistry,
// GoogleCalendarService, or the OAuth routes).
export interface GoogleOAuthTokenStore {
  // Legacy/default-principal compatibility methods.
  save(tenantId: string, token: GoogleTokenResponse): void;
  saveForPrincipal(tenantId: string, principalId: string, token: GoogleTokenResponse): void;
  clear(tenantId: string): void;
  clearForPrincipal(tenantId: string, principalId: string): void;
  isConnected(tenantId: string): boolean;
  isConnectedForPrincipal(tenantId: string, principalId: string): boolean;
  getStatus(tenantId: string): GoogleConnectionStatus;
  getStatusForPrincipal(tenantId: string, principalId: string): GoogleConnectionStatus;
  getProviderAccountRefForPrincipal(tenantId: string, principalId: string): string | null;
  acquireAccessTokenForPrincipal(
    tenantId: string,
    principalId: string,
    config: GoogleOAuthConfig,
    fetchFn: FetchFn,
    requestId: string,
    now?: () => number,
  ): Promise<GoogleAccessTokenResult>;
  // Marks the connection as needing reauthorization (e.g. Google rejected the access token) and purges its secrets.
  markReauthRequiredForPrincipal(tenantId: string, principalId: string, reason: GoogleReauthReason): void;
  getValidAccessToken(
    tenantId: string,
    config: GoogleOAuthConfig,
    fetchFn: FetchFn,
    requestId: string,
    now?: () => number,
  ): Promise<string | null>;
  getValidAccessTokenForPrincipal(
    tenantId: string,
    principalId: string,
    config: GoogleOAuthConfig,
    fetchFn: FetchFn,
    requestId: string,
    now?: () => number,
  ): Promise<string | null>;
  // Best-effort revokes with Google (never throws) then always clears local
  // state, persisted or otherwise — used by POST .../oauth/google/disconnect.
  revoke(tenantId: string, fetchFn: FetchFn, requestId: string): Promise<void>;
  revokeForPrincipal(tenantId: string, principalId: string, fetchFn: FetchFn, requestId: string): Promise<void>;
}

function isValidStoredToken(value: unknown): value is StoredGoogleToken {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.accessToken === 'string' &&
    (v.refreshToken === null || typeof v.refreshToken === 'string') &&
    typeof v.expiresAt === 'number' &&
    typeof v.scope === 'string' &&
    (v.tokenType === undefined || v.tokenType === null || typeof v.tokenType === 'string') &&
    typeof v.connectedAt === 'string' &&
    (v.providerAccountRef === undefined || typeof v.providerAccountRef === 'string') &&
    (v.authState === undefined || v.authState === 'ACTIVE' || v.authState === 'REAUTH_REQUIRED') &&
    (v.reauthReason === undefined || typeof v.reauthReason === 'string') &&
    (v.reauthAt === undefined || typeof v.reauthAt === 'string')
  );
}

// In-memory only — used directly in tests as a lightweight harness, and as the
// base behavior PersistentGoogleOAuthTokenStore adds disk persistence on top of.
export class InMemoryGoogleOAuthTokenStore implements GoogleOAuthTokenStore {
  protected readonly tokensByOwner = new Map<string, StoredGoogleToken>();

  public save(tenantId: string, token: GoogleTokenResponse): void {
    this.saveForPrincipal(tenantId, DEFAULT_GOOGLE_PRINCIPAL_ID, token);
  }

  public saveForPrincipal(tenantId: string, principalId: string, token: GoogleTokenResponse): void {
    const key = ownerKey(tenantId, principalId);
    const existing = this.tokensByOwner.get(key);
    const accountChanged = Boolean(existing?.refreshToken && token.refreshToken && existing.refreshToken !== token.refreshToken);
    this.tokensByOwner.set(key, {
      accessToken: token.accessToken,
      // Google does not resend a refresh_token on every grant (e.g. a
      // reconnect that doesn't force a fresh consent) — never overwrite a
      // previously-persisted refresh token with null/undefined.
      refreshToken: token.refreshToken ?? existing?.refreshToken ?? null,
      expiresAt: token.expiresAt,
      scope: token.scope,
      tokenType: token.tokenType ?? existing?.tokenType ?? null,
      connectedAt: existing?.connectedAt ?? new Date().toISOString(),
      providerAccountRef: !accountChanged && existing?.providerAccountRef ? existing.providerAccountRef : `gacct_${crypto.randomUUID()}`,
    });
    this.onChange();
  }

  public clear(tenantId: string): void {
    this.clearForPrincipal(tenantId, DEFAULT_GOOGLE_PRINCIPAL_ID);
  }

  public clearForPrincipal(tenantId: string, principalId: string): void {
    this.tokensByOwner.delete(ownerKey(tenantId, principalId));
    this.onChange();
  }

  public isConnected(tenantId: string): boolean {
    return this.isConnectedForPrincipal(tenantId, DEFAULT_GOOGLE_PRINCIPAL_ID);
  }

  public isConnectedForPrincipal(tenantId: string, principalId: string): boolean {
    const token = this.tokensByOwner.get(ownerKey(tenantId, principalId));
    return Boolean(token) && token?.authState !== 'REAUTH_REQUIRED';
  }

  public getStatus(tenantId: string): GoogleConnectionStatus {
    return this.getStatusForPrincipal(tenantId, DEFAULT_GOOGLE_PRINCIPAL_ID);
  }

  public getStatusForPrincipal(tenantId: string, principalId: string): GoogleConnectionStatus {
    const token = this.tokensByOwner.get(ownerKey(tenantId, principalId));
    if (!token) return { connected: false, scopes: [], expiresAt: null, authState: 'NONE', reauthReason: null, reauthAt: null };
    const needsReauth = token.authState === 'REAUTH_REQUIRED';
    return {
      connected: !needsReauth,
      scopes: token.scope.split(' ').filter(Boolean),
      expiresAt: new Date(token.expiresAt).toISOString(),
      authState: needsReauth ? 'REAUTH_REQUIRED' : 'ACTIVE',
      reauthReason: needsReauth ? token.reauthReason ?? 'TOKEN_REVOKED' : null,
      reauthAt: needsReauth ? token.reauthAt ?? null : null,
    };
  }

  public getProviderAccountRefForPrincipal(tenantId: string, principalId: string): string | null {
    return this.tokensByOwner.get(ownerKey(tenantId, principalId))?.providerAccountRef ?? null;
  }

  // Returns a currently-valid access token, transparently refreshing it if
  // expired. Returns null (never throws) when there is no connection or the
  // refresh fails — callers must treat null as "fail closed to unavailable".
  public async getValidAccessToken(
    tenantId: string,
    config: GoogleOAuthConfig,
    fetchFn: FetchFn,
    requestId: string,
    now: () => number = Date.now,
  ): Promise<string | null> {
    return this.getValidAccessTokenForPrincipal(tenantId, DEFAULT_GOOGLE_PRINCIPAL_ID, config, fetchFn, requestId, now);
  }

  public async getValidAccessTokenForPrincipal(
    tenantId: string,
    principalId: string,
    config: GoogleOAuthConfig,
    fetchFn: FetchFn,
    requestId: string,
    now: () => number = Date.now,
  ): Promise<string | null> {
    const result = await this.acquireAccessTokenForPrincipal(tenantId, principalId, config, fetchFn, requestId, now);
    return result.ok ? result.accessToken : null;
  }

  private readonly refreshesInFlight = new Map<string, Promise<GoogleAccessTokenResult>>();

  // Obtains a usable access token, refreshing it when expired. Fails closed (never a token) but says WHY:
  //  - NOT_CONNECTED       no connection for this tenant+user
  //  - REAUTH_REQUIRED     Google no longer honours the grant (revoked / expired without refresh token): the connection
  //                        metadata is kept, the dead secrets are purged, and the user must reauthorize
  //  - PROVIDER_TIMEOUT/PROVIDER_ERROR  a transient Google failure: the connection and its secrets are kept untouched
  public async acquireAccessTokenForPrincipal(
    tenantId: string,
    principalId: string,
    config: GoogleOAuthConfig,
    fetchFn: FetchFn,
    requestId: string,
    now: () => number = Date.now,
  ): Promise<GoogleAccessTokenResult> {
    const key = ownerKey(tenantId, principalId);
    const token = this.tokensByOwner.get(key);
    if (!token) return { ok: false, reason: 'NOT_CONNECTED' };
    if (token.authState === 'REAUTH_REQUIRED') return { ok: false, reason: 'REAUTH_REQUIRED', reauthReason: token.reauthReason ?? 'TOKEN_REVOKED' };
    if (token.expiresAt > now()) return { ok: true, accessToken: token.accessToken };
    if (!token.refreshToken) {
      this.markReauthRequiredForPrincipal(tenantId, principalId, 'TOKEN_EXPIRED_NO_REFRESH');
      return { ok: false, reason: 'REAUTH_REQUIRED', reauthReason: 'TOKEN_EXPIRED_NO_REFRESH' };
    }
    const inFlight = this.refreshesInFlight.get(key);
    if (inFlight) return inFlight;
    const refreshing = this.refreshAccessToken(tenantId, principalId, token.refreshToken, config, fetchFn, requestId, now)
      .finally(() => { this.refreshesInFlight.delete(key); });
    this.refreshesInFlight.set(key, refreshing);
    return refreshing;
  }

  private async refreshAccessToken(
    tenantId: string,
    principalId: string,
    refreshToken: string,
    config: GoogleOAuthConfig,
    fetchFn: FetchFn,
    requestId: string,
    now: () => number,
  ): Promise<GoogleAccessTokenResult> {
    try {
      const refreshed = await refreshGoogleAccessToken(config, refreshToken, fetchFn, requestId, now);
      this.saveForPrincipal(tenantId, principalId, refreshed);
      return { ok: true, accessToken: refreshed.accessToken };
    } catch (error) {
      if (!(error instanceof NagexError)) return { ok: false, reason: 'INTERNAL_ERROR' };
      if (error.code === 'GOOGLE_OAUTH_TIMEOUT') return { ok: false, reason: 'PROVIDER_TIMEOUT', code: error.code };
      if (error.code === 'GOOGLE_OAUTH_TOKEN_EXCHANGE_FAILED') {
        const oauthError = error.details?.oauthError;
        // invalid_grant / unauthorized_client: Google says this grant is dead (revoked, expired, password change...).
        if (oauthError === 'invalid_grant' || oauthError === 'unauthorized_client') {
          this.markReauthRequiredForPrincipal(tenantId, principalId, 'TOKEN_REVOKED');
          return { ok: false, reason: 'REAUTH_REQUIRED', reauthReason: 'TOKEN_REVOKED', code: error.code };
        }
      }
      // network failure, 5xx, 429, a misconfigured OAuth client...: not the user's authorization — keep the connection.
      return { ok: false, reason: 'PROVIDER_ERROR', code: error.code };
    }
  }

  public markReauthRequiredForPrincipal(tenantId: string, principalId: string, reason: GoogleReauthReason): void {
    const key = ownerKey(tenantId, principalId);
    const token = this.tokensByOwner.get(key);
    if (!token) return;
    this.tokensByOwner.set(key, {
      ...token,
      // the grant is unusable: do not retain either secret
      accessToken: '',
      refreshToken: null,
      expiresAt: 0,
      authState: 'REAUTH_REQUIRED',
      reauthReason: reason,
      reauthAt: new Date().toISOString(),
    });
    this.onChange();
  }

  public async revoke(tenantId: string, fetchFn: FetchFn, requestId: string): Promise<void> {
    return this.revokeForPrincipal(tenantId, DEFAULT_GOOGLE_PRINCIPAL_ID, fetchFn, requestId);
  }

  public async revokeForPrincipal(tenantId: string, principalId: string, fetchFn: FetchFn, _requestId: string): Promise<void> {
    const token = this.tokensByOwner.get(ownerKey(tenantId, principalId));
    // a connection that already needs reauthorization holds no secret to revoke at Google
    if (token && token.accessToken) await revokeGoogleToken(token.accessToken, fetchFn);
    this.clearForPrincipal(tenantId, principalId);
  }

  // Hook for subclasses (PersistentGoogleOAuthTokenStore) to persist to disk
  // on every mutation. No-op here.
  protected onChange(): void {}

  protected setAll(entries: Iterable<[string, StoredGoogleToken]>): void {
    this.tokensByOwner.clear();
    for (const [key, token] of entries) {
      const { tenantId, principalId } = splitOwnerKey(key);
      this.tokensByOwner.set(ownerKey(tenantId, principalId), token);
    }
  }

  protected entries(): Array<[string, StoredGoogleToken]> {
    return [...this.tokensByOwner.entries()];
  }
}

export interface PersistentGoogleOAuthTokenStoreOptions {
  filePath?: string;
  env?: NodeJS.ProcessEnv;
}

// This app is single-tenant in its current hackathon form (see server_web.ts's
// 'ten_production_01' default), so the tool registry's live-status check below
// reads this one shared store rather than threading tenantId through PlanResolver.
export const DEFAULT_GOOGLE_TENANT_ID = 'ten_production_01';
export const DEFAULT_GOOGLE_PRINCIPAL_ID = 'usr_admin_001';

function ownerKey(tenantId: string, principalId: string): string {
  return `${tenantId}::${principalId}`;
}

function splitOwnerKey(key: string): { tenantId: string; principalId: string } {
  const separator = key.indexOf('::');
  if (separator < 0) {
    // Backward compatibility for pre-R23.4V persisted tenant-only entries.
    return { tenantId: key, principalId: DEFAULT_GOOGLE_PRINCIPAL_ID };
  }
  return { tenantId: key.slice(0, separator), principalId: key.slice(separator + 2) };
}

// Preferred path is a systemd-managed data directory outside the Git repo
// (see docs/canonical/NAgex_Operations_and_Deployment.md for the one-time `sudo mkdir` setup). Falls back to
// a per-user data directory when that path doesn't exist or isn't writable
// yet (fresh checkout, local dev, Windows) rather than crashing the process.
export function resolveDefaultGoogleTokenStorePath(env: NodeJS.ProcessEnv = process.env): string {
  return resolveNagexDataFile('google-oauth.json', 'NAGEX_GOOGLE_TOKEN_STORE_PATH', env);
}

// Persists the full tenant->token map as one AES-256-GCM encrypted envelope
// (see EncryptedEnvelope), written atomically (temp file in the same
// directory + fsync + rename) with 0600 permissions. Every mutation
// (save/clear/refresh) re-persists immediately. When no
// NAGEX_TOKEN_ENCRYPTION_KEY is configured, this behaves exactly like
// InMemoryGoogleOAuthTokenStore (a warning is logged once) rather than
// refusing to start — connections simply won't survive a restart until a
// key is set.
export class PersistentGoogleOAuthTokenStore extends InMemoryGoogleOAuthTokenStore {
  private readonly filePath: string;
  private readonly encryptionKey: Buffer | null;

  constructor(options: PersistentGoogleOAuthTokenStoreOptions = {}) {
    super();
    const env = options.env ?? process.env;
    this.filePath = options.filePath ?? resolveDefaultGoogleTokenStorePath(env);
    this.encryptionKey = loadEncryptionKey(env);
    if (!this.encryptionKey) {
      console.warn(JSON.stringify({
        event: 'google_oauth_persistence_disabled',
        message: 'NAGEX_TOKEN_ENCRYPTION_KEY is not set or invalid; Google OAuth connections will not survive a restart.',
      }));
      return;
    }
    this.restore();
  }

  private restore(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(JSON.stringify({ event: 'google_oauth_token_file_read_failed', code: (error as NodeJS.ErrnoException).code }));
      }
      return; // missing file -> disconnected, nothing to restore
    }
    try {
      const envelope = JSON.parse(raw) as EncryptedEnvelope;
      if (envelope.version !== 1) throw new Error(`unsupported token file version: ${String(envelope.version)}`);
      const map = decryptJson<Record<string, unknown>>(this.encryptionKey as Buffer, envelope);
      if (!map || typeof map !== 'object') throw new Error('persisted token map is not an object');
      const validEntries: Array<[string, StoredGoogleToken]> = [];
      for (const [tenantId, token] of Object.entries(map)) {
        if (isValidStoredToken(token)) validEntries.push([tenantId, { ...token, tokenType: token.tokenType ?? null, providerAccountRef: token.providerAccountRef ?? `gacct_${crypto.randomUUID()}` }]);
      }
      this.setAll(validEntries);
    } catch {
      // Corrupted JSON, wrong encryption key (GCM auth tag failure), an
      // unsupported version, or an unexpected structure — fail closed to
      // disconnected. Never log the raw file contents or the key.
      console.error(JSON.stringify({
        event: 'google_oauth_token_file_invalid',
        message: 'Could not decrypt or parse the persisted Google OAuth token file; treating all Google Calendar connections as disconnected.',
      }));
    }
  }

  protected onChange(): void {
    if (!this.encryptionKey) return;
    const dir = path.dirname(this.filePath);
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

      // No tenants left (e.g. after disconnect) — securely remove the file
      // entirely rather than persist an empty-but-still-valid envelope.
      if (this.entries().length === 0) {
        fs.rmSync(this.filePath, { force: true });
        return;
      }

      const map = Object.fromEntries(this.entries());
      const envelope = encryptJson(this.encryptionKey, map);
      const tmpPath = path.join(dir, `.google-oauth.json.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
      const fd = fs.openSync(tmpPath, 'w', 0o600);
      try {
        fs.writeSync(fd, JSON.stringify(envelope));
        try {
          fs.fsyncSync(fd);
        } catch {
          /* fsync not supported on this filesystem — best effort */
        }
      } finally {
        fs.closeSync(fd);
      }
      fs.chmodSync(tmpPath, 0o600);
      fs.renameSync(tmpPath, this.filePath); // atomic replace within the same directory
      fs.chmodSync(this.filePath, 0o600);
    } catch (error) {
      console.error(JSON.stringify({ event: 'google_oauth_token_persist_failed', code: (error as NodeJS.ErrnoException).code ?? 'UNKNOWN' }));
    }
  }
}

export const googleTokenStore: GoogleOAuthTokenStore = new PersistentGoogleOAuthTokenStore();
