import { GitHubConnectionService } from './github-connection.js';
import { hasPendingGitHubOAuthState } from './oauth-state.store.js';
import { readGitHubOAuthConfig } from './oauth.client.js';
import { githubTokenStore } from './token.store.js';

// Stateless: identity is always passed per call from the verified session. The fetch is resolved at call time so the
// current global fetch is always used (tests replace it; nothing is captured at startup).
export const githubConnectionService = new GitHubConnectionService({
  tokenStore: githubTokenStore,
  getConfig: readGitHubOAuthConfig,
  fetchFn: (input, init) => globalThis.fetch(input, init),
  hasPendingAuthorization: hasPendingGitHubOAuthState,
});
