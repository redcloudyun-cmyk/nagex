// GitHub connection state and read-only repository access — the single place that turns "what happened when we tried to use
// the user's GitHub grant" into a truthful, user-facing state, and the only code that talks to api.github.com.
//
//   NOT_CONNECTED   no connection for this tenant + user
//   CONNECTING      the user started authorization and it has not finished yet
//   CONNECTED       a usable grant exists (verifiedAt is set only when GitHub actually answered an authorized request)
//   REAUTH_REQUIRED the connection exists but must be authorized again (revoked/expired/rejected token)
//   ERROR           the connection is fine but GitHub failed (timeout, outage, rate limit) - retry, do not reconnect
//   UNAVAILABLE     this server cannot offer GitHub at all (OAuth App not configured)
//
// Identity is ALWAYS passed in by the caller from the server-verified session; this module never reads a default or
// client-supplied principal. Repository content is untrusted data: results carry `untrusted: true` and are never executed.
import { NagexError } from '../../common/errors.js';
import { exchangeGitHubAuthorizationCode, GITHUB_PROVIDER_TIMEOUT_MS, type GitHubOAuthConfig } from './oauth.client.js';
import type { GitHubAccount, GitHubTokenStore } from './token.store.js';

type FetchFn = typeof fetch;

export type GitHubConnectionState = 'NOT_CONNECTED' | 'CONNECTING' | 'CONNECTED' | 'REAUTH_REQUIRED' | 'ERROR' | 'UNAVAILABLE';

export type GitHubConnectionReason =
  | 'NO_CONNECTION'
  | 'AUTHORIZATION_PENDING'
  | 'OAUTH_NOT_CONFIGURED'
  | 'TOKEN_REVOKED'
  | 'TOKEN_EXPIRED_NO_REFRESH'
  | 'TOKEN_REJECTED'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_UNREACHABLE'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_FORBIDDEN'
  | 'PROVIDER_ERROR'
  | 'INTERNAL_ERROR';

export const GITHUB_CONNECT_PATH = '/api/v1/oauth/github/start';
export const GITHUB_MAX_FILE_BYTES = 256 * 1024;

export interface GitHubConnectionStatus {
  provider: 'github';
  state: GitHubConnectionState;
  reason: GitHubConnectionReason | null;
  retryable: boolean;
  scopes: string[];
  // The GitHub account the user connected (public login only); null until a verified connection exists.
  account: { login: string } | null;
  // true when the granted scopes let GitHub return private repositories
  privateAccess: boolean;
  connectPath: string | null;
  verifiedAt: string | null;
  message: string;
}

const MESSAGES: Record<GitHubConnectionReason | 'CONNECTED', string> = {
  CONNECTED: 'GitHub is connected.',
  NO_CONNECTION: 'GitHub is not connected.',
  AUTHORIZATION_PENDING: 'GitHub authorization is in progress.',
  OAUTH_NOT_CONFIGURED: 'GitHub is not available on this server.',
  TOKEN_REVOKED: 'GitHub access was revoked or has expired. Reconnect GitHub.',
  TOKEN_EXPIRED_NO_REFRESH: 'GitHub access has expired. Reconnect GitHub.',
  TOKEN_REJECTED: 'GitHub rejected the saved access. Reconnect GitHub.',
  PROVIDER_TIMEOUT: 'GitHub did not respond in time. Try again.',
  PROVIDER_UNREACHABLE: 'GitHub could not be reached. Try again.',
  PROVIDER_RATE_LIMITED: 'GitHub is limiting requests right now. Try again shortly.',
  PROVIDER_FORBIDDEN: 'GitHub refused this request. The repository may require organization approval.',
  PROVIDER_ERROR: 'GitHub returned an error. Try again.',
  INTERNAL_ERROR: 'NAgex could not read GitHub because of an internal error.',
};

interface Failure {
  state: Exclude<GitHubConnectionState, 'CONNECTED' | 'CONNECTING'>;
  reason: GitHubConnectionReason;
  retryable: boolean;
}

export interface GitHubIdentity {
  tenantId: string;
  principalId: string;
  requestId: string;
}

export interface GitHubConnectionDeps {
  tokenStore: GitHubTokenStore;
  getConfig: (env?: NodeJS.ProcessEnv) => GitHubOAuthConfig | null;
  fetchFn: FetchFn;
  hasPendingAuthorization: (tenantId: string, principalId: string) => boolean;
  now?: () => Date;
}

export interface GitHubRepository {
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
  fork: boolean;
  archived: boolean;
  description: string | null;
  defaultBranch: string;
  language: string | null;
  updatedAt: string | null;
  htmlUrl: string;
}

export interface GitHubDirectoryEntry {
  name: string;
  path: string;
  type: 'file' | 'dir' | 'symlink' | 'submodule';
  size: number;
}

export type GitHubReadOutcome<T> =
  | { connection: GitHubConnectionStatus; outcome: 'OK'; data: T }
  | { connection: GitHubConnectionStatus; outcome: 'NOT_FOUND' | 'TOO_LARGE' | 'BINARY' }
  | { connection: GitHubConnectionStatus; outcome: 'NOT_AVAILABLE' };

export interface GitHubFileContent {
  repository: string;
  path: string;
  ref: string | null;
  sha: string;
  size: number;
  content: string;
  truncated: boolean;
  untrusted: true;
}

export interface GitHubDirectoryListing {
  repository: string;
  path: string;
  ref: string | null;
  entries: GitHubDirectoryEntry[];
  untrusted: true;
}

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_PATTERN = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;
const REF_PATTERN = /^[A-Za-z0-9._\/-]{1,200}$/;

function invalid(message: string, requestId: string): NagexError {
  return new NagexError({ code: 'GITHUB_INVALID_REQUEST', category: 'VALIDATION', message, request_id: requestId });
}

// Only well-formed owner/repo/path/ref values ever reach a GitHub URL; path segments are percent-encoded one by one.
export function validateGitHubTarget(input: { owner: unknown; repo: unknown; path?: unknown; ref?: unknown }, requestId: string): { owner: string; repo: string; path: string; ref: string | null } {
  const owner = typeof input.owner === 'string' ? input.owner.trim() : '';
  const repo = typeof input.repo === 'string' ? input.repo.trim() : '';
  if (!OWNER_PATTERN.test(owner)) throw invalid('A valid repository owner is required.', requestId);
  if (!REPO_PATTERN.test(repo)) throw invalid('A valid repository name is required.', requestId);
  const rawPath = typeof input.path === 'string' ? input.path.trim().replace(/^\/+|\/+$/g, '') : '';
  const segments = rawPath ? rawPath.split('/') : [];
  if (segments.length > 40 || segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.length > 255 || /[\u0000-\u001f\\]/.test(segment))) {
    throw invalid('The file path is not valid.', requestId);
  }
  const ref = typeof input.ref === 'string' && input.ref.trim() ? input.ref.trim() : null;
  if (ref && (!REF_PATTERN.test(ref) || ref.includes('..'))) throw invalid('The branch or tag name is not valid.', requestId);
  return { owner, repo, path: segments.join('/'), ref };
}

type ApiResult =
  | { ok: true; status: number; body: unknown }
  | { ok: false; kind: 'NOT_FOUND' }
  | { ok: false; kind: 'FAILURE'; failure: Failure };

export class GitHubConnectionService {
  constructor(private readonly deps: GitHubConnectionDeps) {}

  private nowIso(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  private status(state: GitHubConnectionState, reason: GitHubConnectionReason | null, identity: { tenantId: string; principalId: string }, extra: { retryable?: boolean; verifiedAt?: string | null } = {}): GitHubConnectionStatus {
    const stored = this.deps.tokenStore.getStatusForPrincipal(identity.tenantId, identity.principalId);
    const canReconnect = state === 'NOT_CONNECTED' || state === 'REAUTH_REQUIRED';
    return {
      provider: 'github',
      state,
      reason,
      retryable: extra.retryable ?? false,
      scopes: stored.scopes,
      account: stored.account ? { login: stored.account.login } : null,
      privateAccess: stored.scopes.includes('repo'),
      connectPath: canReconnect ? GITHUB_CONNECT_PATH : null,
      verifiedAt: extra.verifiedAt ?? null,
      message: MESSAGES[reason ?? 'CONNECTED'],
    };
  }

  private fromFailure(failure: Failure, identity: { tenantId: string; principalId: string }): GitHubConnectionStatus {
    if (this.deps.hasPendingAuthorization(identity.tenantId, identity.principalId) && (failure.state === 'NOT_CONNECTED' || failure.state === 'REAUTH_REQUIRED')) {
      return this.status('CONNECTING', 'AUTHORIZATION_PENDING', identity);
    }
    return this.status(failure.state, failure.reason, identity, { retryable: failure.retryable });
  }

  // Cheap status: no call to GitHub unless `verify` is set. CONNECTED + verifiedAt only reflect a call that really succeeded.
  public async getStatus(identity: GitHubIdentity, options: { verify?: boolean } = {}): Promise<GitHubConnectionStatus> {
    const { tenantId, principalId } = identity;
    if (!tenantId || !principalId) return this.status('NOT_CONNECTED', 'NO_CONNECTION', { tenantId: '', principalId: '' });
    const stored = this.deps.tokenStore.getStatusForPrincipal(tenantId, principalId);
    const config = this.deps.getConfig();
    if (!config) return this.status('UNAVAILABLE', 'OAUTH_NOT_CONFIGURED', identity);
    if (stored.authState === 'NONE') return this.fromFailure({ state: 'NOT_CONNECTED', reason: 'NO_CONNECTION', retryable: false }, identity);
    if (stored.authState === 'REAUTH_REQUIRED') return this.fromFailure({ state: 'REAUTH_REQUIRED', reason: stored.reauthReason ?? 'TOKEN_REVOKED', retryable: false }, identity);
    if (options.verify) {
      const user = await this.api(identity, '/user');
      if (user.ok) {
        const account = parseAccount(user.body);
        const at = this.nowIso();
        this.deps.tokenStore.noteVerifiedForPrincipal(tenantId, principalId, at, account ?? undefined);
        return this.status('CONNECTED', null, identity, { verifiedAt: at });
      }
      return this.fromFailure(user.ok === false && user.kind === 'FAILURE' ? user.failure : { state: 'ERROR', reason: 'PROVIDER_ERROR', retryable: true }, identity);
    }
    // Local check only: the saved grant can still produce an access token.
    const acquired = await this.deps.tokenStore.acquireAccessTokenForPrincipal(tenantId, principalId, config, this.deps.fetchFn, identity.requestId);
    if (!acquired.ok) return this.fromFailure(this.failureForAcquire(acquired), identity);
    return this.status('CONNECTED', null, identity, { verifiedAt: stored.verifiedAt });
  }

  // Completes the OAuth callback: exchanges the code, PROVES the token with an authorized /user call, and only then stores it.
  public async completeAuthorization(identity: GitHubIdentity, code: string): Promise<GitHubConnectionStatus> {
    const config = this.deps.getConfig();
    if (!config) return this.status('UNAVAILABLE', 'OAUTH_NOT_CONFIGURED', identity);
    try {
      const token = await exchangeGitHubAuthorizationCode(config, code, this.deps.fetchFn, identity.requestId);
      const probe = await this.fetchJson(token.accessToken, '/user', identity.requestId);
      if (!probe.ok) {
        if (probe.kind === 'FAILURE') return this.fromFailure(probe.failure, identity);
        return this.status('ERROR', 'PROVIDER_ERROR', identity, { retryable: true });
      }
      const account = parseAccount(probe.body);
      this.deps.tokenStore.saveForPrincipal(identity.tenantId, identity.principalId, token, account);
      return this.status('CONNECTED', null, identity, { verifiedAt: this.nowIso() });
    } catch (error) {
      return this.fromFailure(classifyOAuthError(error), identity);
    }
  }

  public async disconnect(identity: GitHubIdentity): Promise<GitHubConnectionStatus> {
    await this.deps.tokenStore.revokeForPrincipal(identity.tenantId, identity.principalId, this.deps.getConfig(), this.deps.fetchFn);
    return this.getStatus(identity);
  }

  public async listRepositories(identity: GitHubIdentity, options: { query?: string; perPage?: number; page?: number } = {}): Promise<GitHubReadOutcome<{ repositories: GitHubRepository[]; hasMore: boolean }>> {
    const perPage = Math.min(100, Math.max(1, Math.floor(options.perPage ?? 30)));
    const page = Math.max(1, Math.floor(options.page ?? 1));
    const result = await this.api(identity, `/user/repos?per_page=${perPage}&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`);
    const gate = await this.gate(identity, result);
    if (gate) return gate;
    const list = Array.isArray((result as { body: unknown }).body) ? ((result as { body: unknown[] }).body) : [];
    let repositories = list.map(toRepository).filter((repo): repo is GitHubRepository => repo !== null);
    const needle = options.query?.trim().toLowerCase();
    if (needle) repositories = repositories.filter((repo) => repo.fullName.toLowerCase().includes(needle) || (repo.description ?? '').toLowerCase().includes(needle));
    return { connection: this.status('CONNECTED', null, identity, { verifiedAt: this.nowIso() }), outcome: 'OK', data: { repositories, hasMore: list.length === perPage } };
  }

  public async listDirectory(identity: GitHubIdentity, target: { owner: unknown; repo: unknown; path?: unknown; ref?: unknown }): Promise<GitHubReadOutcome<GitHubDirectoryListing>> {
    const t = validateGitHubTarget(target, identity.requestId);
    const result = await this.api(identity, contentsPath(t));
    const gate = await this.gate(identity, result);
    if (gate) return gate;
    const body = (result as { body: unknown }).body;
    if (!Array.isArray(body)) return { connection: this.status('CONNECTED', null, identity, { verifiedAt: this.nowIso() }), outcome: 'NOT_FOUND' };
    const entries = body.map(toEntry).filter((entry): entry is GitHubDirectoryEntry => entry !== null).sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    return { connection: this.status('CONNECTED', null, identity, { verifiedAt: this.nowIso() }), outcome: 'OK', data: { repository: `${t.owner}/${t.repo}`, path: t.path, ref: t.ref, entries, untrusted: true } };
  }

  public async readFile(identity: GitHubIdentity, target: { owner: unknown; repo: unknown; path: unknown; ref?: unknown }): Promise<GitHubReadOutcome<GitHubFileContent>> {
    const t = validateGitHubTarget(target, identity.requestId);
    if (!t.path) throw invalid('A file path is required.', identity.requestId);
    const result = await this.api(identity, contentsPath(t));
    const gate = await this.gate(identity, result);
    if (gate) return gate;
    const connected = this.status('CONNECTED', null, identity, { verifiedAt: this.nowIso() });
    const body = (result as { body: unknown }).body as Record<string, unknown> | unknown[];
    if (Array.isArray(body) || !body || typeof body !== 'object' || body.type !== 'file') return { connection: connected, outcome: 'NOT_FOUND' };
    const size = typeof body.size === 'number' ? body.size : 0;
    if (size > GITHUB_MAX_FILE_BYTES * 4 || typeof body.content !== 'string' || body.encoding !== 'base64') return { connection: connected, outcome: 'TOO_LARGE' };
    const bytes = Buffer.from(body.content.replace(/\s+/g, ''), 'base64');
    if (bytes.includes(0)) return { connection: connected, outcome: 'BINARY' };
    const truncated = bytes.length > GITHUB_MAX_FILE_BYTES;
    return {
      connection: connected,
      outcome: 'OK',
      data: { repository: `${t.owner}/${t.repo}`, path: t.path, ref: t.ref, sha: typeof body.sha === 'string' ? body.sha : '', size, content: bytes.subarray(0, GITHUB_MAX_FILE_BYTES).toString('utf8'), truncated, untrusted: true },
    };
  }

  // ── internals ────────────────────────────────────────────────────────────────────────────────────────────────

  private failureForAcquire(acquired: { reason: string; reauthReason?: string }): Failure {
    if (acquired.reason === 'NOT_CONNECTED') return { state: 'NOT_CONNECTED', reason: 'NO_CONNECTION', retryable: false };
    if (acquired.reason === 'REAUTH_REQUIRED') return { state: 'REAUTH_REQUIRED', reason: (acquired.reauthReason as GitHubConnectionReason) ?? 'TOKEN_REVOKED', retryable: false };
    if (acquired.reason === 'PROVIDER_TIMEOUT') return { state: 'ERROR', reason: 'PROVIDER_TIMEOUT', retryable: true };
    if (acquired.reason === 'PROVIDER_ERROR') return { state: 'ERROR', reason: 'PROVIDER_ERROR', retryable: true };
    return { state: 'ERROR', reason: 'INTERNAL_ERROR', retryable: true };
  }

  // Converts a failed/not-found API result into the read outcome the caller returns; undefined when the call succeeded.
  private async gate(identity: GitHubIdentity, result: ApiResult | { ok: false; kind: 'UNAVAILABLE' }): Promise<GitHubReadOutcome<never> | undefined> {
    if (result.ok) return undefined;
    if (result.kind === 'NOT_FOUND') return { connection: this.status('CONNECTED', null, identity, { verifiedAt: this.nowIso() }), outcome: 'NOT_FOUND' };
    if (result.kind === 'FAILURE') return { connection: this.fromFailure(result.failure, identity), outcome: 'NOT_AVAILABLE' };
    return { connection: this.status('UNAVAILABLE', 'OAUTH_NOT_CONFIGURED', identity), outcome: 'NOT_AVAILABLE' };
  }

  private async api(identity: GitHubIdentity, path: string): Promise<ApiResult | { ok: false; kind: 'UNAVAILABLE' }> {
    const { tenantId, principalId, requestId } = identity;
    if (!tenantId || !principalId) return { ok: false, kind: 'FAILURE', failure: { state: 'NOT_CONNECTED', reason: 'NO_CONNECTION', retryable: false } };
    const config = this.deps.getConfig();
    if (!config) return { ok: false, kind: 'UNAVAILABLE' };
    const acquired = await this.deps.tokenStore.acquireAccessTokenForPrincipal(tenantId, principalId, config, this.deps.fetchFn, requestId);
    if (!acquired.ok) return { ok: false, kind: 'FAILURE', failure: this.failureForAcquire(acquired) };
    const response = await this.fetchJson(acquired.accessToken, path, requestId);
    if (!response.ok && response.kind === 'FAILURE' && response.failure.state === 'REAUTH_REQUIRED') {
      // GitHub itself rejected the saved token: remember it so the next status does not claim CONNECTED.
      this.deps.tokenStore.markReauthRequiredForPrincipal(tenantId, principalId, 'TOKEN_REJECTED');
    }
    return response;
  }

  private async fetchJson(accessToken: string, path: string, _requestId: string): Promise<ApiResult> {
    let response: Response;
    try {
      response = await this.deps.fetchFn(`https://api.github.com${path}`, {
        method: 'GET',
        headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', Authorization: `Bearer ${accessToken}`, 'User-Agent': 'NAgex' },
        signal: AbortSignal.timeout(GITHUB_PROVIDER_TIMEOUT_MS),
      });
    } catch (error) {
      const name = error && typeof error === 'object' ? (error as { name?: unknown }).name : undefined;
      if (name === 'TimeoutError' || name === 'AbortError') return { ok: false, kind: 'FAILURE', failure: { state: 'ERROR', reason: 'PROVIDER_TIMEOUT', retryable: true } };
      return { ok: false, kind: 'FAILURE', failure: { state: 'ERROR', reason: 'PROVIDER_UNREACHABLE', retryable: true } };
    }
    if (response.status === 404) return { ok: false, kind: 'NOT_FOUND' };
    if (response.status === 401) return { ok: false, kind: 'FAILURE', failure: { state: 'REAUTH_REQUIRED', reason: 'TOKEN_REJECTED', retryable: false } };
    if (response.status === 429 || (response.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')))) {
      return { ok: false, kind: 'FAILURE', failure: { state: 'ERROR', reason: 'PROVIDER_RATE_LIMITED', retryable: true } };
    }
    if (response.status === 403) return { ok: false, kind: 'FAILURE', failure: { state: 'ERROR', reason: 'PROVIDER_FORBIDDEN', retryable: false } };
    if (response.status >= 500) return { ok: false, kind: 'FAILURE', failure: { state: 'ERROR', reason: 'PROVIDER_ERROR', retryable: true } };
    if (!response.ok) return { ok: false, kind: 'FAILURE', failure: { state: 'ERROR', reason: 'PROVIDER_ERROR', retryable: false } };
    return { ok: true, status: response.status, body: await response.json().catch(() => null) };
  }
}

function classifyOAuthError(error: unknown): Failure {
  if (!(error instanceof NagexError)) return { state: 'ERROR', reason: 'INTERNAL_ERROR', retryable: true };
  if (error.code === 'GITHUB_OAUTH_TIMEOUT') return { state: 'ERROR', reason: 'PROVIDER_TIMEOUT', retryable: true };
  if (error.code === 'GITHUB_OAUTH_NETWORK_ERROR') return { state: 'ERROR', reason: 'PROVIDER_UNREACHABLE', retryable: true };
  if (error.code === 'GITHUB_OAUTH_TOKEN_EXCHANGE_FAILED') {
    return error.category === 'PROVIDER' ? { state: 'ERROR', reason: 'PROVIDER_ERROR', retryable: true } : { state: 'NOT_CONNECTED', reason: 'NO_CONNECTION', retryable: false };
  }
  return { state: 'ERROR', reason: 'INTERNAL_ERROR', retryable: true };
}

function contentsPath(t: { owner: string; repo: string; path: string; ref: string | null }): string {
  const encodedPath = t.path ? t.path.split('/').map(encodeURIComponent).join('/') : '';
  const base = `/repos/${encodeURIComponent(t.owner)}/${encodeURIComponent(t.repo)}/contents${encodedPath ? `/${encodedPath}` : ''}`;
  return t.ref ? `${base}?ref=${encodeURIComponent(t.ref)}` : base;
}

function parseAccount(body: unknown): GitHubAccount | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  return typeof record.login === 'string' && typeof record.id === 'number' ? { login: record.login, id: record.id } : null;
}

function toRepository(value: unknown): GitHubRepository | null {
  if (!value || typeof value !== 'object') return null;
  const r = value as Record<string, unknown>;
  const owner = r.owner && typeof r.owner === 'object' ? (r.owner as Record<string, unknown>).login : undefined;
  if (typeof r.full_name !== 'string' || typeof r.name !== 'string' || typeof owner !== 'string') return null;
  return {
    fullName: r.full_name,
    name: r.name,
    owner,
    private: r.private === true,
    fork: r.fork === true,
    archived: r.archived === true,
    description: typeof r.description === 'string' ? r.description : null,
    defaultBranch: typeof r.default_branch === 'string' ? r.default_branch : 'main',
    language: typeof r.language === 'string' ? r.language : null,
    updatedAt: typeof r.updated_at === 'string' ? r.updated_at : null,
    htmlUrl: typeof r.html_url === 'string' ? r.html_url : `https://github.com/${r.full_name}`,
  };
}

function toEntry(value: unknown): GitHubDirectoryEntry | null {
  if (!value || typeof value !== 'object') return null;
  const e = value as Record<string, unknown>;
  if (typeof e.name !== 'string' || typeof e.path !== 'string') return null;
  const type = e.type === 'file' || e.type === 'dir' || e.type === 'symlink' || e.type === 'submodule' ? e.type : null;
  return type ? { name: e.name, path: e.path, type, size: typeof e.size === 'number' ? e.size : 0 } : null;
}
