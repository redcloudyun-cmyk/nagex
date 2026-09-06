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
  save(tenantId: string, token: GoogleTokenResponse): void;
  clear(tenantId: string): void;
  isConnected(tenantId: string): boolean;
  getStatus(tenantId: string): GoogleConnectionStatus;
  getValidAccessToken(
    tenantId: string,
    config: GoogleOAuthConfig,
    fetchFn: FetchFn,
    requestId: string,
    now?: () => number,
  ): Promise<string | null>;
  // Best-effort revokes with Google (never throws) then always clears local
  // state, persisted or otherwise — used by POST .../oauth/google/disconnect.
  revoke(tenantId: string, fetchFn: FetchFn, requestId: string): Promise<void>;
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
  protected readonly tokensByTenant = new Map<string, StoredGoogleToken>();

  public save(tenantId: string, token: GoogleTokenResponse): void {
    const existing = this.tokensByTenant.get(tenantId);
    this.tokensByTenant.set(tenantId, {
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
    this.tokensByTenant.delete(tenantId);
    this.onChange();
  }

  public isConnected(tenantId: string): boolean {
    return this.tokensByTenant.has(tenantId);
  }

  public getStatus(tenantId: string): GoogleConnectionStatus {
    const token = this.tokensByTenant.get(tenantId);
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
    const token = this.tokensByTenant.get(tenantId);
    if (!token) return null;
    if (token.expiresAt > now()) return token.accessToken;
    if (!token.refreshToken) {
      this.clear(tenantId);
      return null;
    }
    try {
      const refreshed = await refreshGoogleAccessToken(config, token.refreshToken, fetchFn, requestId, now);
      this.save(tenantId, refreshed);
      return refreshed.accessToken;
    } catch {
      // Refresh failed (commonly: authorization revoked) — fail closed and
      // drop the now-invalid credential rather than keep retrying with it.
      this.clear(tenantId);
      return null;
    }
  }

  public async revoke(tenantId: string, fetchFn: FetchFn, _requestId: string): Promise<void> {
    const token = this.tokensByTenant.get(tenantId);
    if (token) await revokeGoogleToken(token.accessToken, fetchFn);
    this.clear(tenantId);
  }

  // Hook for subclasses (PersistentGoogleOAuthTokenStore) to persist to disk
  // on every mutation. No-op here.
  protected onChange(): void {}

  protected setAll(entries: Iterable<[string, StoredGoogleToken]>): void {
    this.tokensByTenant.clear();
    for (const [tenantId, token] of entries) this.tokensByTenant.set(tenantId, token);
  }

  protected entries(): Array<[string, StoredGoogleToken]> {
    return [...this.tokensByTenant.entries()];
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
