// One-time CSRF nonces for the GitHub OAuth start -> callback round trip, bound server-side to the authenticated tenant + user
// that started the flow. A pending nonce is what makes the honest connection state "CONNECTING" instead of "NOT_CONNECTED".
import crypto from 'node:crypto';

export interface PendingGitHubOAuthState {
  tenantId: string;
  principalId: string;
  createdAt: number;
}

export const GITHUB_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const pending = new Map<string, PendingGitHubOAuthState>();

function sweep(now: number): void {
  for (const [key, entry] of pending.entries()) {
    if (now - entry.createdAt > GITHUB_OAUTH_STATE_TTL_MS) pending.delete(key);
  }
}

export function issueGitHubOAuthState(owner: { tenantId: string; principalId: string }, now: number = Date.now()): string {
  const state = crypto.randomUUID();
  sweep(now);
  pending.set(state, { tenantId: owner.tenantId, principalId: owner.principalId, createdAt: now });
  return state;
}

export function consumeGitHubOAuthState(state: string | undefined, now: number = Date.now()): PendingGitHubOAuthState | null {
  if (!state) return null;
  const entry = pending.get(state);
  pending.delete(state);
  if (!entry || now - entry.createdAt > GITHUB_OAUTH_STATE_TTL_MS) return null;
  return entry;
}

// True only for the same tenant AND user that started a still-valid authorization.
export function hasPendingGitHubOAuthState(tenantId: string, principalId: string, now: number = Date.now()): boolean {
  sweep(now);
  for (const entry of pending.values()) {
    if (entry.tenantId === tenantId && entry.principalId === principalId) return true;
  }
  return false;
}

export function clearGitHubOAuthStatesForTesting(): void {
  pending.clear();
}
