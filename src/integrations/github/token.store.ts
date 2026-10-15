// Per-user GitHub OAuth grants. Same persistence model as the Google store: AES-256-GCM envelope (NAGEX_TOKEN_ENCRYPTION_KEY),
// atomic 0600 file writes, keyed by tenant + user. Without a key it behaves in memory only (a warning is logged once).
//
// A grant GitHub no longer honours is NOT deleted: the connection stays visible as REAUTH_REQUIRED and the dead secret is purged.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NagexError } from '../../common/errors.js';
import { resolveNagexDataFile } from '../../governance/file-record.store.js';
import { decryptJson, encryptJson, loadEncryptionKey, type EncryptedEnvelope } from '../google/token.crypto.js';
import { refreshGitHubAccessToken, revokeGitHubGrant, type GitHubOAuthConfig, type GitHubTokenResponse } from './oauth.client.js';

type FetchFn = typeof fetch;

export interface GitHubAccount {
  login: string;
  id: number;
}

export type GitHubReauthReason = 'TOKEN_REVOKED' | 'TOKEN_EXPIRED_NO_REFRESH' | 'TOKEN_REJECTED';

interface StoredGitHubToken {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  scope: string;
  tokenType: string | null;
  connectedAt: string;
  account: GitHubAccount | null;
  verifiedAt: string | null;
  authState?: 'ACTIVE' | 'REAUTH_REQUIRED';
  reauthReason?: GitHubReauthReason;
  reauthAt?: string;
}

export interface GitHubStoredStatus {
  authState: 'NONE' | 'ACTIVE' | 'REAUTH_REQUIRED';
  scopes: string[];
  account: GitHubAccount | null;
  connectedAt: string | null;
  verifiedAt: string | null;
  reauthReason: GitHubReauthReason | null;
}

export type GitHubAccessTokenResult =
  | { ok: true; accessToken: string }
  | { ok: false; reason: 'NOT_CONNECTED' | 'REAUTH_REQUIRED' | 'PROVIDER_TIMEOUT' | 'PROVIDER_ERROR' | 'INTERNAL_ERROR'; reauthReason?: GitHubReauthReason };

export interface GitHubTokenStore {
  saveForPrincipal(tenantId: string, principalId: string, token: GitHubTokenResponse, account: GitHubAccount | null): void;
  getStatusForPrincipal(tenantId: string, principalId: string): GitHubStoredStatus;
  noteVerifiedForPrincipal(tenantId: string, principalId: string, at: string, account?: GitHubAccount): void;
  acquireAccessTokenForPrincipal(tenantId: string, principalId: string, config: GitHubOAuthConfig | null, fetchFn: FetchFn, requestId: string, now?: () => number): Promise<GitHubAccessTokenResult>;
  markReauthRequiredForPrincipal(tenantId: string, principalId: string, reason: GitHubReauthReason): void;
  revokeForPrincipal(tenantId: string, principalId: string, config: GitHubOAuthConfig | null, fetchFn: FetchFn): Promise<void>;
  clearForPrincipal(tenantId: string, principalId: string): void;
}

function ownerKey(tenantId: string, principalId: string): string {
  return `${tenantId}::${principalId}`;
}

function isValidStoredToken(value: unknown): value is StoredGitHubToken {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.accessToken === 'string'
    && (v.refreshToken === null || typeof v.refreshToken === 'string')
    && (v.expiresAt === null || typeof v.expiresAt === 'number')
    && typeof v.scope === 'string'
    && typeof v.connectedAt === 'string'
    && (v.authState === undefined || v.authState === 'ACTIVE' || v.authState === 'REAUTH_REQUIRED');
}

export class InMemoryGitHubTokenStore implements GitHubTokenStore {
  protected readonly tokens = new Map<string, StoredGitHubToken>();
  private readonly refreshesInFlight = new Map<string, Promise<GitHubAccessTokenResult>>();

  public saveForPrincipal(tenantId: string, principalId: string, token: GitHubTokenResponse, account: GitHubAccount | null): void {
    const key = ownerKey(tenantId, principalId);
    this.tokens.set(key, {
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiresAt: token.expiresAt,
      scope: token.scope,
      tokenType: token.tokenType,
      connectedAt: new Date().toISOString(),
      account,
      // Set by the caller only after an authorized call succeeded.
      verifiedAt: account ? new Date().toISOString() : null,
      authState: 'ACTIVE',
    });
    this.onChange();
  }

  public getStatusForPrincipal(tenantId: string, principalId: string): GitHubStoredStatus {
    const token = this.tokens.get(ownerKey(tenantId, principalId));
    if (!token) return { authState: 'NONE', scopes: [], account: null, connectedAt: null, verifiedAt: null, reauthReason: null };
    const needsReauth = token.authState === 'REAUTH_REQUIRED';
    return {
      authState: needsReauth ? 'REAUTH_REQUIRED' : 'ACTIVE',
      scopes: token.scope.split(/[\s,]+/).filter(Boolean),
      account: token.account,
      connectedAt: token.connectedAt,
      verifiedAt: token.verifiedAt,
      reauthReason: needsReauth ? token.reauthReason ?? 'TOKEN_REVOKED' : null,
    };
  }

  public noteVerifiedForPrincipal(tenantId: string, principalId: string, at: string, account?: GitHubAccount): void {
    const key = ownerKey(tenantId, principalId);
    const token = this.tokens.get(key);
    if (!token || token.authState === 'REAUTH_REQUIRED') return;
    this.tokens.set(key, { ...token, verifiedAt: at, account: account ?? token.account });
    this.onChange();
  }

  public async acquireAccessTokenForPrincipal(tenantId: string, principalId: string, config: GitHubOAuthConfig | null, fetchFn: FetchFn, requestId: string, now: () => number = Date.now): Promise<GitHubAccessTokenResult> {
    const key = ownerKey(tenantId, principalId);
    const token = this.tokens.get(key);
    if (!token) return { ok: false, reason: 'NOT_CONNECTED' };
    if (token.authState === 'REAUTH_REQUIRED') return { ok: false, reason: 'REAUTH_REQUIRED', reauthReason: token.reauthReason ?? 'TOKEN_REVOKED' };
    if (token.expiresAt === null || token.expiresAt > now()) return { ok: true, accessToken: token.accessToken };
    if (!token.refreshToken || !config) {
      this.markReauthRequiredForPrincipal(tenantId, principalId, 'TOKEN_EXPIRED_NO_REFRESH');
      return { ok: false, reason: 'REAUTH_REQUIRED', reauthReason: 'TOKEN_EXPIRED_NO_REFRESH' };
    }
    const inFlight = this.refreshesInFlight.get(key);
    if (inFlight) return inFlight;
    const refreshing = this.refresh(tenantId, principalId, token, config, fetchFn, requestId, now).finally(() => { this.refreshesInFlight.delete(key); });
    this.refreshesInFlight.set(key, refreshing);
    return refreshing;
  }

  private async refresh(tenantId: string, principalId: string, token: StoredGitHubToken, config: GitHubOAuthConfig, fetchFn: FetchFn, requestId: string, now: () => number): Promise<GitHubAccessTokenResult> {
    try {
      const refreshed = await refreshGitHubAccessToken(config, token.refreshToken as string, fetchFn, requestId, now);
      this.saveForPrincipal(tenantId, principalId, { ...refreshed, scope: refreshed.scope || token.scope }, token.account);
      return { ok: true, accessToken: refreshed.accessToken };
    } catch (error) {
      if (!(error instanceof NagexError)) return { ok: false, reason: 'INTERNAL_ERROR' };
      if (error.code === 'GITHUB_OAUTH_TIMEOUT') return { ok: false, reason: 'PROVIDER_TIMEOUT' };
      if (error.code === 'GITHUB_OAUTH_TOKEN_EXCHANGE_FAILED') {
        const oauthError = error.details?.oauthError;
        if (oauthError === 'bad_refresh_token' || oauthError === 'invalid_grant') {
          this.markReauthRequiredForPrincipal(tenantId, principalId, 'TOKEN_REVOKED');
          return { ok: false, reason: 'REAUTH_REQUIRED', reauthReason: 'TOKEN_REVOKED' };
        }
      }
      return { ok: false, reason: 'PROVIDER_ERROR' };
    }
  }

  public markReauthRequiredForPrincipal(tenantId: string, principalId: string, reason: GitHubReauthReason): void {
    const key = ownerKey(tenantId, principalId);
    const token = this.tokens.get(key);
    if (!token) return;
    this.tokens.set(key, { ...token, accessToken: '', refreshToken: null, expiresAt: 0, authState: 'REAUTH_REQUIRED', reauthReason: reason, reauthAt: new Date().toISOString() });
    this.onChange();
  }

  public async revokeForPrincipal(tenantId: string, principalId: string, config: GitHubOAuthConfig | null, fetchFn: FetchFn): Promise<void> {
    const token = this.tokens.get(ownerKey(tenantId, principalId));
    if (token?.accessToken && config) await revokeGitHubGrant(config, token.accessToken, fetchFn);
    this.clearForPrincipal(tenantId, principalId);
  }

  public clearForPrincipal(tenantId: string, principalId: string): void {
    this.tokens.delete(ownerKey(tenantId, principalId));
    this.onChange();
  }

  protected onChange(): void {}

  protected setAll(entries: Iterable<[string, StoredGitHubToken]>): void {
    this.tokens.clear();
    for (const [key, token] of entries) this.tokens.set(key, token);
  }

  protected entries(): Array<[string, StoredGitHubToken]> {
    return [...this.tokens.entries()];
  }
}

export function resolveDefaultGitHubTokenStorePath(env: NodeJS.ProcessEnv = process.env): string {
  return resolveNagexDataFile('github-oauth.json', 'NAGEX_GITHUB_TOKEN_STORE_PATH', env);
}

export class PersistentGitHubTokenStore extends InMemoryGitHubTokenStore {
  private readonly filePath: string;
  private readonly encryptionKey: Buffer | null;

  constructor(options: { filePath?: string; env?: NodeJS.ProcessEnv } = {}) {
    super();
    const env = options.env ?? process.env;
    this.filePath = options.filePath ?? resolveDefaultGitHubTokenStorePath(env);
    this.encryptionKey = loadEncryptionKey(env);
    if (!this.encryptionKey) return; // memory only; the Google store already logs the missing-key warning once
    this.restore();
  }

  private restore(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error(JSON.stringify({ event: 'github_oauth_token_file_read_failed', code: (error as NodeJS.ErrnoException).code }));
      return;
    }
    try {
      const envelope = JSON.parse(raw) as EncryptedEnvelope;
      if (envelope.version !== 1) throw new Error('unsupported token file version');
      const map = decryptJson<Record<string, unknown>>(this.encryptionKey as Buffer, envelope);
      const valid: Array<[string, StoredGitHubToken]> = [];
      for (const [key, token] of Object.entries(map ?? {})) {
        if (isValidStoredToken(token)) valid.push([key, { ...token, tokenType: token.tokenType ?? null, account: token.account ?? null, verifiedAt: token.verifiedAt ?? null }]);
      }
      this.setAll(valid);
    } catch {
      console.error(JSON.stringify({ event: 'github_oauth_token_file_invalid', message: 'Could not decrypt or parse the persisted GitHub token file; treating all GitHub connections as disconnected.' }));
    }
  }

  protected onChange(): void {
    if (!this.encryptionKey) return;
    const dir = path.dirname(this.filePath);
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (this.entries().length === 0) {
        fs.rmSync(this.filePath, { force: true });
        return;
      }
      const envelope = encryptJson(this.encryptionKey, Object.fromEntries(this.entries()));
      const tmpPath = path.join(dir, `.github-oauth.json.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
      const fd = fs.openSync(tmpPath, 'w', 0o600);
      try {
        fs.writeSync(fd, JSON.stringify(envelope));
        try { fs.fsyncSync(fd); } catch { /* best effort */ }
      } finally {
        fs.closeSync(fd);
      }
      fs.chmodSync(tmpPath, 0o600);
      fs.renameSync(tmpPath, this.filePath);
      fs.chmodSync(this.filePath, 0o600);
    } catch (error) {
      console.error(JSON.stringify({ event: 'github_oauth_token_persist_failed', code: (error as NodeJS.ErrnoException).code ?? 'UNKNOWN' }));
    }
  }
}

export const githubTokenStore: GitHubTokenStore = new PersistentGitHubTokenStore();
