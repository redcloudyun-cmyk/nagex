import { refreshGoogleAccessToken, type GoogleOAuthConfig, type GoogleTokenResponse } from './oauth.client.js';

interface StoredGoogleToken {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  scope: string;
  connectedAt: string;
}

export interface GoogleConnectionStatus {
  connected: boolean;
  scope: string | null;
  connectedAt: string | null;
}

type FetchFn = typeof fetch;

// Server-side only. Tokens never leave this process — no API route returns
// accessToken/refreshToken, and callers must not spread StoredGoogleToken into
// any response body or audit detail object.
export class GoogleTokenStore {
  private readonly tokensByTenant = new Map<string, StoredGoogleToken>();

  public save(tenantId: string, token: GoogleTokenResponse): void {
    const existing = this.tokensByTenant.get(tenantId);
    this.tokensByTenant.set(tenantId, {
      accessToken: token.accessToken,
      refreshToken: token.refreshToken ?? existing?.refreshToken ?? null,
      expiresAt: token.expiresAt,
      scope: token.scope,
      connectedAt: existing?.connectedAt ?? new Date().toISOString(),
    });
  }

  public clear(tenantId: string): void {
    this.tokensByTenant.delete(tenantId);
  }

  public isConnected(tenantId: string): boolean {
    return this.tokensByTenant.has(tenantId);
  }

  public getStatus(tenantId: string): GoogleConnectionStatus {
    const token = this.tokensByTenant.get(tenantId);
    if (!token) return { connected: false, scope: null, connectedAt: null };
    return { connected: true, scope: token.scope, connectedAt: token.connectedAt };
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
      this.clear(tenantId);
      return null;
    }
  }
}

// This app is single-tenant in its current hackathon form (see server_web.ts's
// 'ten_production_01' default), so the tool registry's live-status check below
// reads this one shared store rather than threading tenantId through PlanResolver.
export const DEFAULT_GOOGLE_TENANT_ID = 'ten_production_01';
export const googleTokenStore = new GoogleTokenStore();
