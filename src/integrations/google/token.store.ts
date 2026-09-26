import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { refreshGoogleAccessToken, revokeGoogleToken, type GoogleOAuthConfig, type GoogleTokenResponse } from './oauth.client.js';
import { loadEncryptionKey, encryptJson, decryptJson, type EncryptedEnvelope } from './token.crypto.js';

interface StoredGoogleToken {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  scope: string;
  tokenType: string | null;
  connectedAt: string;
}

export interface GoogleConnectionStatus {
  connected: boolean;
  scopes: string[];
  expiresAt: string | null;
}

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
    typeof v.connectedAt === 'string'
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
    return this.tokensByOwner.has(ownerKey(tenantId, principalId));
  }

  public getStatus(tenantId: string): GoogleConnectionStatus {
    return this.getStatusForPrincipal(tenantId, DEFAULT_GOOGLE_PRINCIPAL_ID);
  }

  public getStatusForPrincipal(tenantId: string, principalId: string): GoogleConnectionStatus {
    const token = this.tokensByOwner.get(ownerKey(tenantId, principalId));
    if (!token) return { connected: false, scopes: [], expiresAt: null };
    return {
      connected: true,
      scopes: token.scope.split(' ').filter(Boolean),
      expiresAt: new Date(token.expiresAt).toISOString(),
    };
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
    const token = this.tokensByOwner.get(ownerKey(tenantId, principalId));
    if (!token) return null;
    if (token.expiresAt > now()) return token.accessToken;
    if (!token.refreshToken) {
      this.clearForPrincipal(tenantId, principalId);
      return null;
    }
    try {
      const refreshed = await refreshGoogleAccessToken(config, token.refreshToken, fetchFn, requestId, now);
      this.saveForPrincipal(tenantId, principalId, refreshed);
      return refreshed.accessToken;
    } catch {
      // Refresh failed (commonly: authorization revoked) — fail closed and
      // drop the now-invalid credential rather than keep retrying with it.
      this.clearForPrincipal(tenantId, principalId);
      return null;
    }
  }

  public async revoke(tenantId: string, fetchFn: FetchFn, requestId: string): Promise<void> {
    return this.revokeForPrincipal(tenantId, DEFAULT_GOOGLE_PRINCIPAL_ID, fetchFn, requestId);
  }

  public async revokeForPrincipal(tenantId: string, principalId: string, fetchFn: FetchFn, _requestId: string): Promise<void> {
    const token = this.tokensByOwner.get(ownerKey(tenantId, principalId));
    if (token) await revokeGoogleToken(token.accessToken, fetchFn);
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
// (see docs/DEPLOYMENT.md for the one-time `sudo mkdir` setup). Falls back to
// a per-user data directory when that path doesn't exist or isn't writable
// yet (fresh checkout, local dev, Windows) rather than crashing the process.
export function resolveDefaultGoogleTokenStorePath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.NAGEX_GOOGLE_TOKEN_STORE_PATH) return env.NAGEX_GOOGLE_TOKEN_STORE_PATH;
  const preferred = '/var/lib/nagex/google-oauth.json';
  try {
    fs.accessSync(path.dirname(preferred), fs.constants.W_OK);
    return preferred;
  } catch {
    return path.join(os.homedir(), '.local', 'share', 'nagex', 'google-oauth.json');
  }
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
        if (isValidStoredToken(token)) validEntries.push([tenantId, { ...token, tokenType: token.tokenType ?? null }]);
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
