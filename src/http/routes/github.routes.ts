// GitHub built-in connection: OAuth start/callback/status/disconnect and read-only repository access.
//
// IDENTITY BOUNDARY (same rule as the Google routes): the owner (tenant + user) comes ONLY from the server-side session via
// resolveAuthenticatedIdentity. The query string, body and X-Principal-Id / X-NAgex-Tenant headers never decide whose
// token is read, written or revoked. The OAuth callback is correlated by the server-held one-time `state` nonce bound to the
// session identity at /start AND must arrive in that same session.
//
// Read-only by design: there is no route that writes to GitHub. Repository content is returned as untrusted data.
import crypto from 'node:crypto';
import type { AuditLogger } from '../../governance/audit.logger.js';
import type { IdentityStore } from '../../identity/identity.store.js';
import type { SessionStore } from '../../sessions/session.store.js';
import { NagexError } from '../../common/errors.js';
import { buildGitHubAuthorizeUrl, readGitHubOAuthConfig } from '../../integrations/github/oauth.client.js';
import { consumeGitHubOAuthState, issueGitHubOAuthState } from '../../integrations/github/oauth-state.store.js';
import type { GitHubConnectionService, GitHubConnectionStatus } from '../../integrations/github/github-connection.js';
import { resolveAuthenticatedIdentity } from '../request-identity.js';
import type { ApiResult, AsyncRouteRegistrar, SyncRouteRegistrar } from '../http-types.js';

export interface GitHubRouteDeps {
  sessionStore: SessionStore;
  identityStore: IdentityStore;
  auditLogger?: AuditLogger;
  githubConnection?: GitHubConnectionService;
}

const UNAUTHORIZED: ApiResult = { status: 401, data: { error: { code: 'UNAUTHORIZED', message: 'Sign in to manage your GitHub connection.' } } };
const NOT_CONFIGURED: ApiResult = { status: 503, data: { error: { code: 'GITHUB_OAUTH_NOT_CONFIGURED', message: 'GitHub is not available on this server.' } } };

function header(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

// A provider failure is reported as one, with the status a client can act on; every other state is a normal answer.
function statusFor(connection: GitHubConnectionStatus): number {
  if (connection.state !== 'ERROR') return 200;
  return connection.reason === 'PROVIDER_TIMEOUT' ? 504 : 502;
}

export const handleGitHubOAuthStartRoutes: SyncRouteRegistrar<Pick<GitHubRouteDeps, 'sessionStore' | 'identityStore'>> = (method, pathname, _body, headers, _query, deps): ApiResult | undefined => {
  if (pathname === '/api/v1/oauth/github/start' && method === 'GET') {
    const owner = resolveAuthenticatedIdentity(headers, deps);
    if (!owner) return { status: 302, data: null, redirectTo: '/?oauth=github&status=signin_required' };
    const config = readGitHubOAuthConfig();
    if (!config) return NOT_CONFIGURED;
    return { status: 302, data: null, redirectTo: buildGitHubAuthorizeUrl(config, issueGitHubOAuthState(owner)) };
  }
  if (pathname === '/api/v1/oauth/github/start-url' && method === 'GET') {
    const owner = resolveAuthenticatedIdentity(headers, deps);
    if (!owner) return UNAUTHORIZED;
    const config = readGitHubOAuthConfig();
    if (!config) return NOT_CONFIGURED;
    return { status: 200, data: { authorizeUrl: buildGitHubAuthorizeUrl(config, issueGitHubOAuthState(owner)) } };
  }
  return undefined;
};

export const handleGitHubRoutes: AsyncRouteRegistrar<GitHubRouteDeps> = async (method, pathname, _body, headers, query, deps): Promise<ApiResult | undefined> => {
  if (!pathname.startsWith('/api/v1/oauth/github/') && !pathname.startsWith('/api/v1/connections/github')) return undefined;
  const { githubConnection, auditLogger } = deps;
  const requestId = header(headers, 'x-request-id') || `req_gh_${crypto.randomUUID()}`;

  if (pathname === '/api/v1/oauth/github/callback' && method === 'GET') {
    const pending = consumeGitHubOAuthState(query.state);
    const fail = (): ApiResult => ({ status: 302, data: null, redirectTo: '/?oauth=github&status=error' });
    if (query.error || !pending || !query.code || !githubConnection) return fail();
    // The callback must arrive in the SAME authenticated session that started the flow.
    const caller = resolveAuthenticatedIdentity(headers, deps);
    if (!caller || caller.principalId !== pending.principalId || caller.tenantId !== pending.tenantId) return fail();
    const connection = await githubConnection.completeAuthorization({ tenantId: pending.tenantId, principalId: pending.principalId, requestId }, query.code);
    if (connection.state !== 'CONNECTED') return fail();
    auditLogger?.logEvent({ actor: { type: 'user', id: pending.principalId }, tenant_id: pending.tenantId, action: 'oauth:github_connected', resource: { type: 'OAuthConnection', id: 'github' }, result: 'SUCCESS', request_id: requestId });
    return { status: 302, data: null, redirectTo: '/?oauth=github&status=connected' };
  }

  const owner = resolveAuthenticatedIdentity(headers, deps);
  if (!owner) return UNAUTHORIZED;
  if (!githubConnection) return { status: 503, data: { error: { code: 'GITHUB_CONNECTION_NOT_CONFIGURED', message: 'GitHub is not available.' } } };
  const identity = { tenantId: owner.tenantId, principalId: owner.principalId, requestId };

  if ((pathname === '/api/v1/oauth/github/status' || pathname === '/api/v1/connections/github') && method === 'GET') {
    const connection = await githubConnection.getStatus(identity, { verify: query.verify === '1' || query.verify === 'true' });
    return { status: statusFor(connection), data: { connection } };
  }

  if ((pathname === '/api/v1/oauth/github/disconnect' || pathname === '/api/v1/connections/github/disconnect') && method === 'POST') {
    const connection = await githubConnection.disconnect(identity);
    auditLogger?.logEvent({ actor: { type: 'user', id: owner.principalId }, tenant_id: owner.tenantId, action: 'oauth:github_disconnected', resource: { type: 'OAuthConnection', id: 'github' }, result: 'SUCCESS', request_id: requestId });
    return { status: 200, data: { connection } };
  }

  if (method === 'GET' && (pathname === '/api/v1/connections/github/repos' || pathname === '/api/v1/connections/github/contents')) {
    try {
      if (pathname.endsWith('/repos')) {
        const result = await githubConnection.listRepositories(identity, { query: query.q, perPage: Number(query.perPage) || undefined, page: Number(query.page) || undefined });
        return readResponse(result.connection, result.outcome, result.outcome === 'OK' ? result.data : undefined);
      }
      // contents: a directory listing, or a single file when `file=1`
      const target = { owner: query.owner, repo: query.repo, path: query.path, ref: query.ref };
      const result = query.file === '1' ? await githubConnection.readFile(identity, target) : await githubConnection.listDirectory(identity, target);
      return readResponse(result.connection, result.outcome, result.outcome === 'OK' ? result.data : undefined);
    } catch (error) {
      if (error instanceof NagexError && error.category === 'VALIDATION') return { status: 400, data: { error: { code: error.code, message: error.message } } };
      throw error;
    }
  }

  return undefined;
};

function readResponse(connection: GitHubConnectionStatus, outcome: string, data: unknown): ApiResult {
  if (outcome === 'OK') return { status: 200, data: { connection, ...(data as object) } };
  if (outcome === 'NOT_FOUND') return { status: 404, data: { connection, error: { code: 'GITHUB_NOT_FOUND', message: 'That repository or path was not found, or you do not have access to it.' } } };
  if (outcome === 'TOO_LARGE') return { status: 413, data: { connection, error: { code: 'GITHUB_FILE_TOO_LARGE', message: 'That file is too large to read here.' } } };
  if (outcome === 'BINARY') return { status: 415, data: { connection, error: { code: 'GITHUB_FILE_BINARY', message: 'That file is not text.' } } };
  // The connection is not usable: say which state it is in rather than faking an empty answer.
  const status = connection.state === 'ERROR' ? statusFor(connection) : connection.state === 'UNAVAILABLE' ? 503 : 409;
  return { status, data: { connection, error: { code: `GITHUB_${connection.state}`, message: connection.message } } };
}
