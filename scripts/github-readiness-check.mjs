#!/usr/bin/env node
// GitHub connection readiness / read-only certification. Prints PASS / FAIL / SKIP per check and NEVER prints a secret, a
// token or file contents (only counts and names). Run from the repository root after `npm run build`.
//
//   Configuration only (safe anywhere):   node scripts/github-readiness-check.mjs
//   Real-account read-only certification: GITHUB_CERT_TOKEN=<a token of the test account> \
//                                         [GITHUB_CERT_REPO=owner/repo GITHUB_CERT_PATH=README.md] \
//                                         node scripts/github-readiness-check.mjs
//
// GITHUB_CERT_TOKEN is only used for GET requests to api.github.com, only for this process. It is the test account's token (for
// example a fine-grained read-only personal access token); the OAuth round trip itself is certified by connecting in the UI.
import { readGitHubOAuthConfig } from '../dist/src/integrations/github/oauth.client.js';
import { GitHubConnectionService } from '../dist/src/integrations/github/github-connection.js';
import { InMemoryGitHubTokenStore } from '../dist/src/integrations/github/token.store.js';

const results = [];
const record = (status, name, detail = '') => { results.push({ status, name }); console.log(`${status.padEnd(4)} ${name}${detail ? ' - ' + detail : ''}`); };

const config = readGitHubOAuthConfig();
record(config ? 'PASS' : 'FAIL', 'GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET / GITHUB_REDIRECT_URI are all set', config ? '' : 'GitHub will show as UNAVAILABLE and offer no Connect button');
if (config) {
  let redirectOk = false;
  try { const url = new URL(config.redirectUri); redirectOk = url.protocol === 'https:' && url.pathname === '/api/v1/oauth/github/callback'; } catch { /* invalid */ }
  record(redirectOk ? 'PASS' : 'FAIL', 'GITHUB_REDIRECT_URI is https and ends with /api/v1/oauth/github/callback', redirectOk ? new URL(config.redirectUri).origin : 'it must equal the callback URL registered on the GitHub OAuth App');
  record(config.scopes.includes('read:user') ? 'PASS' : 'FAIL', 'scopes include read:user', config.scopes.join(' '));
  record(config.scopes.includes('repo') ? 'PASS' : 'SKIP', 'scopes include repo (private repositories)', config.scopes.includes('repo') ? '' : 'only public repositories will be reachable');
  record(config.scopes.some((s) => /^(write:|admin:|delete_repo|workflow)/.test(s)) ? 'FAIL' : 'PASS', 'no write/admin scope is requested (NAgex GitHub access is read-only)');
}
record(process.env.NAGEX_TOKEN_ENCRYPTION_KEY ? 'PASS' : 'FAIL', 'NAGEX_TOKEN_ENCRYPTION_KEY is set (connections survive a restart)', process.env.NAGEX_TOKEN_ENCRYPTION_KEY ? '' : 'without it tokens live in memory only');

const token = process.env.GITHUB_CERT_TOKEN?.trim();
if (!token) {
  record('SKIP', 'real-account read-only certification', 'set GITHUB_CERT_TOKEN to run it');
} else {
  // Drive the production GitHubConnectionService with a real token for a throwaway identity.
  const tokenStore = new InMemoryGitHubTokenStore();
  const certConfig = config ?? { clientId: 'cert', clientSecret: 'cert', redirectUri: 'https://cert.invalid/cb', scopes: ['read:user', 'repo'] };
  const service = new GitHubConnectionService({ tokenStore, getConfig: () => certConfig, fetchFn: (input, init) => fetch(input, init), hasPendingAuthorization: () => false });
  const identity = { tenantId: 'cert_tenant', principalId: 'cert_user', requestId: 'cert_request' };
  tokenStore.saveForPrincipal(identity.tenantId, identity.principalId, { accessToken: token, refreshToken: null, expiresAt: null, scope: 'read:user,repo', tokenType: 'bearer' }, null);

  const status = await service.getStatus(identity, { verify: true });
  record(status.state === 'CONNECTED' ? 'PASS' : 'FAIL', 'authorized GET /user succeeds and the connection is CONNECTED', `state=${status.state}${status.reason ? ' reason=' + status.reason : ''}${status.account ? ' account=@' + status.account.login : ''}`);
  if (status.state === 'CONNECTED') {
    const repos = await service.listRepositories(identity, { perPage: 5 });
    record(repos.outcome === 'OK' ? 'PASS' : 'FAIL', 'repository listing (read-only)', repos.outcome === 'OK' ? `${repos.data.repositories.length} repositories returned (${repos.data.repositories.filter((r) => r.private).length} private)` : repos.outcome);
    const target = process.env.GITHUB_CERT_REPO?.split('/');
    if (target?.length === 2) {
      const dir = await service.listDirectory(identity, { owner: target[0], repo: target[1] });
      record(dir.outcome === 'OK' ? 'PASS' : 'FAIL', `directory listing of ${process.env.GITHUB_CERT_REPO}`, dir.outcome === 'OK' ? `${dir.data.entries.length} entries` : dir.outcome);
      if (process.env.GITHUB_CERT_PATH) {
        const file = await service.readFile(identity, { owner: target[0], repo: target[1], path: process.env.GITHUB_CERT_PATH });
        record(file.outcome === 'OK' ? 'PASS' : 'FAIL', `file read ${process.env.GITHUB_CERT_PATH}`, file.outcome === 'OK' ? `${file.data.size} bytes, untrusted=${file.data.untrusted}, truncated=${file.data.truncated}` : file.outcome);
      }
    } else {
      record('SKIP', 'directory / file read', 'set GITHUB_CERT_REPO=owner/repo (and GITHUB_CERT_PATH) to run it');
    }
    const other = await service.listRepositories({ ...identity, principalId: 'someone_else' }, { perPage: 1 });
    record(other.outcome === 'NOT_AVAILABLE' && other.connection.state === 'NOT_CONNECTED' ? 'PASS' : 'FAIL', 'another user in the same process cannot use this token (identity isolation)');
  }
}

const failed = results.filter((r) => r.status === 'FAIL').length;
console.log(`\n${results.filter((r) => r.status === 'PASS').length} passed, ${failed} failed, ${results.filter((r) => r.status === 'SKIP').length} skipped`);
process.exit(failed > 0 ? 1 : 0);
