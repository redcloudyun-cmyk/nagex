// Production coordinator for MCP OAuth: one fail-closed object that turns the operator's registration + LIVE, verified provider metadata into the trusted
// registry, pending-state store and encrypted credential store the HTTP routes need. Nothing is active unless NAGEX_MCP_OAUTH_ENABLED=1 AND a provider is
// completely configured AND its published metadata verifies under the SSRF policy. Any other situation is reported as DISABLED / SETUP_REQUIRED / UNAVAILABLE
// with a reason code; the routes then answer 503 and no Connect button is shown.
//
// Single-process limitation (documented): pending authorization states live in memory. After a restart, or with several workers, an unfinished flow fails
// closed and the person starts again. Stored credentials are encrypted and durable (see PersistentMcpOAuthCredentialStore).
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { getMcpOAuthMetadata } from './mcp-oauth-discovery.js';
import { PersistentMcpOAuthCredentialStore } from './mcp-oauth-persistent-store.js';
import { McpOAuthProviderRegistry, type McpOAuthProviderRegistration } from './mcp-oauth-provider-registry.js';
import { createMcpOAuthStateStore, type McpOAuthStateStore, type PendingMcpOAuth } from './mcp-oauth-state.js';
import { resolveMcpOAuthClientSecret, readMcpOAuthOperatorConfig, type McpOAuthOperatorProviderStatus, type McpOAuthProviderTemplate, type McpOAuthSetupItem } from './mcp-oauth-providers.js';
import type { McpOAuthCallbackDeps } from './mcp-oauth-callback.js';
import type { McpOAuthBearer, McpOAuthBearerResolver, McpOAuthBinding, McpOAuthOwnerRef } from './mcp-oauth-binding.js';
import type { exchangeMcpOAuthCode } from './mcp-oauth-token.js';
import type { McpUrlPolicyOptions } from './mcp-url-policy.js';

export type McpOAuthProviderState = 'DISABLED' | 'SETUP_REQUIRED' | 'UNAVAILABLE' | 'AVAILABLE';
export interface McpOAuthProviderStatus {
  id: string;
  displayName: string;
  state: McpOAuthProviderState;
  // Which setup items the OPERATOR still has to provide (never any value). Empty unless SETUP_REQUIRED.
  missing: McpOAuthSetupItem[];
  // Why a configured provider is UNAVAILABLE (a stable code, never provider text).
  reason: string | null;
  scopes: string[];
}

export interface McpOAuthCoordinator {
  providerRegistry: McpOAuthProviderRegistry;
  pendingStates: McpOAuthStateStore;
  oauth: McpOAuthCallbackDeps;
}

export interface McpOAuthRuntimeOptions {
  env?: NodeJS.ProcessEnv;
  // Injectable for tests. Defaults to the SSRF-guarded, redirect-free metadata GET.
  getMetadata?: (url: string, requestId: string) => Promise<unknown>;
  exchange?: typeof exchangeMcpOAuthCode;
  // Provider templates (default: the NAgex-reviewed list). Injectable so tests can stand a local fake provider in for Slack.
  templates?: readonly McpOAuthProviderTemplate[];
  policy?: McpUrlPolicyOptions;
  storeFile?: string;
  now?: () => number;
  successTtlMs?: number;
  failureTtlMs?: number;
}

export function resolveDefaultMcpOAuthStorePath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.NAGEX_MCP_OAUTH_STORE_FILE && path.isAbsolute(env.NAGEX_MCP_OAUTH_STORE_FILE)) return env.NAGEX_MCP_OAUTH_STORE_FILE;
  const preferred = '/var/lib/nagex/mcp-oauth-credentials.json';
  try { fs.accessSync(path.dirname(preferred), fs.constants.W_OK); return preferred; } catch { return path.join(os.homedir(), '.local', 'share', 'nagex', 'mcp-oauth-credentials.json'); }
}

const EXPIRY_SKEW_MS = 60_000;

export class McpOAuthRuntime implements McpOAuthBearerResolver {
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;
  private readonly states = createMcpOAuthStateStore();
  private store: PersistentMcpOAuthCredentialStore | null = null;
  private storeError: string | null = null;
  private cache: { at: number; ttl: number; statuses: McpOAuthProviderStatus[]; coordinator: McpOAuthCoordinator | null } | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(private readonly options: McpOAuthRuntimeOptions = {}) {
    this.env = options.env ?? process.env;
    this.now = options.now ?? (() => Date.now());
    this.openStore();
  }

  // The credential store is opened eagerly (not lazily with the metadata) so stored credentials are usable after a restart even before the first start request.
  private openStore(): void {
    const configs = readMcpOAuthOperatorConfig(this.env, this.options.templates);
    if (configs.every((c) => c.state === 'DISABLED')) return;
    try {
      this.store = new PersistentMcpOAuthCredentialStore({ file: this.options.storeFile ?? resolveDefaultMcpOAuthStorePath(this.env), env: this.env });
    } catch (error) {
      // Wrong key, corrupt file, symlink, schema: never an empty "connected" state. Reported, not hidden.
      this.store = null;
      this.storeError = error instanceof Error && /^MCP_OAUTH_[A-Z_]+$/.test(error.message) ? error.message : 'MCP_OAUTH_STORE_UNAVAILABLE';
    }
  }

  public get credentialStore(): PersistentMcpOAuthCredentialStore | null { return this.store; }

  // ── McpOAuthBearerResolver ──────────────────────────────────────────────────────────────────────────────────────
  public bearerFor(owner: McpOAuthOwnerRef, binding: McpOAuthBinding, now: number = this.now()): McpOAuthBearer {
    if (!this.store) return { state: 'MISSING' };
    let stored;
    try { stored = this.store.load({ tenantId: owner.tenantId, principalId: owner.principalId, resource: binding.resource, issuer: binding.issuer, clientId: binding.clientId }); }
    catch { return { state: 'MISSING' }; }
    if (!stored) return { state: 'MISSING' };
    if (stored.tokens.expiresIn !== null && now >= stored.storedAt + stored.tokens.expiresIn * 1000 - EXPIRY_SKEW_MS) return { state: 'EXPIRED' };
    return { state: 'OK', token: stored.tokens.accessToken };
  }

  public remove(owner: McpOAuthOwnerRef, binding: McpOAuthBinding): void {
    if (!this.store) return;
    this.store.remove({ tenantId: owner.tenantId, principalId: owner.principalId, resource: binding.resource, issuer: binding.issuer, clientId: binding.clientId });
  }

  // ── status / coordinator ───────────────────────────────────────────────────────────────────────────────────────
  public async statuses(): Promise<McpOAuthProviderStatus[]> {
    await this.refresh();
    return this.cache!.statuses.map((s) => ({ ...s, missing: [...s.missing], scopes: [...s.scopes] }));
  }

  // The trusted coordinator, or null when nothing is available (the routes then answer MCP_OAUTH_NOT_CONFIGURED).
  public async coordinator(): Promise<McpOAuthCoordinator | null> {
    await this.refresh();
    return this.cache!.coordinator;
  }

  private async refresh(): Promise<void> {
    const t = this.now();
    if (this.cache && t - this.cache.at < this.cache.ttl) return;
    if (!this.inFlight) this.inFlight = this.build().finally(() => { this.inFlight = null; });
    await this.inFlight;
  }

  private async build(): Promise<void> {
    const operator = readMcpOAuthOperatorConfig(this.env, this.options.templates);
    const statuses: McpOAuthProviderStatus[] = [];
    const registrations: McpOAuthProviderRegistration[] = [];
    let anyFailure = false;
    for (const entry of operator) {
      const base = { id: entry.id, displayName: entry.displayName, scopes: entry.config?.scopes ?? [] };
      if (entry.state === 'DISABLED') { statuses.push({ ...base, state: 'DISABLED', missing: [], reason: null }); continue; }
      if (entry.state === 'SETUP_REQUIRED') { statuses.push({ ...base, state: 'SETUP_REQUIRED', missing: entry.missing, reason: null }); continue; }
      const unavailable = (reason: string) => { anyFailure = true; statuses.push({ ...base, state: 'UNAVAILABLE', missing: [], reason }); };
      if (!this.store) { unavailable(this.storeError ?? 'MCP_OAUTH_STORE_UNAVAILABLE'); continue; }
      const registration = await this.verify(entry);
      if (typeof registration === 'string') { unavailable(registration); continue; }
      registrations.push(registration);
      statuses.push({ ...base, state: 'AVAILABLE', missing: [], reason: null });
    }
    let coordinator: McpOAuthCoordinator | null = null;
    if (registrations.length > 0 && this.store) {
      const registry = new McpOAuthProviderRegistry(registrations);
      const store = this.store;
      const env = this.env;
      coordinator = {
        providerRegistry: registry,
        pendingStates: this.states,
        oauth: {
          stateStore: this.states,
          vault: store,
          resolveRequestedScopes: (pending: PendingMcpOAuth) => registry.requestedScopesFor(pending),
          resolveTrustedTokenEndpoint: async (pending: PendingMcpOAuth) => registry.resolveTrustedTokenEndpoint(pending),
          resolveClientAuthentication: (pending: PendingMcpOAuth) => {
            const pinned = registry.tokenClientAuthFor(pending);
            if (pinned.method === 'none') return { clientAuth: { method: 'none' as const }, responseProfile: pinned.responseProfile };
            const secret = pinned.secretRef ? resolveMcpOAuthClientSecret(pinned.secretRef, env) : undefined;
            if (!secret) throw new Error('MCP_OAUTH_CLIENT_SECRET_UNAVAILABLE');
            return { clientAuth: { method: 'client_secret_post' as const, clientSecret: secret }, responseProfile: pinned.responseProfile };
          },
          ...(this.options.exchange ? { exchange: this.options.exchange } : {}),
        },
      };
    }
    this.cache = { at: this.now(), ttl: anyFailure ? (this.options.failureTtlMs ?? 30_000) : (this.options.successTtlMs ?? 10 * 60_000), statuses, coordinator };
  }

  // Fetches the provider's published metadata (exact vendor-documented URLs from the template) and returns a registration only if it verifies. A string is a reason code.
  private async verify(entry: McpOAuthOperatorProviderStatus): Promise<McpOAuthProviderRegistration | string> {
    const config = entry.config!;
    const { template } = config;
    const get = this.options.getMetadata ?? ((url: string, requestId: string) => getMcpOAuthMetadata(url, requestId, this.options.policy ? { policy: this.options.policy } : {}));
    try {
      const protectedResourceMetadata = await get(template.protectedResourceMetadataUrl, `req_mcp_oauth_${template.id}_resource`);
      const authorizationServerMetadata = await get(template.authorizationServerMetadataUrl, `req_mcp_oauth_${template.id}_issuer`);
      const registration: McpOAuthProviderRegistration = {
        id: template.id, clientId: config.clientId, redirectUri: config.redirectUri, requestedScopes: config.scopes,
        protectedResourceMetadata, authorizationServerMetadata, resource: template.resource, issuer: template.resource,
        tokenAuthMethod: template.tokenAuthMethod, clientSecretRef: template.tokenAuthMethod === 'client_secret_post' ? config.secretRef : undefined,
        mcpEndpoint: template.mcpEndpoint, responseProfile: template.responseProfile, displayName: template.displayName,
      };
      // Validate in isolation so one provider's failure never takes the others down.
      new McpOAuthProviderRegistry([registration]);
      return registration;
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (/^MCP_OAUTH_[A-Z_]+$/.test(message)) return message;
      const details = (error as { details?: { reason?: unknown } })?.details;
      const code = (error as { code?: unknown })?.code;
      const reason = typeof details?.reason === 'string' && /^[A-Z_]{1,48}$/.test(details.reason) ? details.reason : 'VERIFICATION_FAILED';
      return typeof code === 'string' && /^MCP_[A-Z_]{1,48}$/.test(code) ? `${code}:${reason}` : reason;
    }
  }
}
