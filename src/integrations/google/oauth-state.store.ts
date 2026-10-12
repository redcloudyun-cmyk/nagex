// One-time CSRF nonces for the Google OAuth start -> callback round trip, bound server-side to the authenticated
// tenant + user that started the flow. Shared by the OAuth routes (issue/consume) and the connection-status
// resolver (a pending nonce is what makes the honest state "CONNECTING" instead of "NOT_CONNECTED").
import crypto from 'node:crypto';

export interface PendingGoogleOAuthState {
  tenantId: string;
  principalId: string;
  createdAt: number;
}

export const GOOGLE_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const pendingGoogleOAuthStates = new Map<string, PendingGoogleOAuthState>();

function sweep(now: number): void {
  for (const [key, pending] of pendingGoogleOAuthStates.entries()) {
    if (now - pending.createdAt > GOOGLE_OAUTH_STATE_TTL_MS) pendingGoogleOAuthStates.delete(key);
  }
}

export function issueGoogleOAuthState(owner: { tenantId: string; principalId: string }, now: number = Date.now()): string {
  const state = crypto.randomUUID();
  sweep(now);
  pendingGoogleOAuthStates.set(state, { tenantId: owner.tenantId, principalId: owner.principalId, createdAt: now });
  return state;
}

export function consumeGoogleOAuthState(state: string | undefined, now: number = Date.now()): PendingGoogleOAuthState | null {
  if (!state) return null;
  const pending = pendingGoogleOAuthStates.get(state);
  pendingGoogleOAuthStates.delete(state);
  if (!pending) return null;
  if (now - pending.createdAt > GOOGLE_OAUTH_STATE_TTL_MS) return null;
  return pending;
}

// True only for the same tenant AND user that started a still-valid authorization. Never answers for anyone else.
export function hasPendingGoogleOAuthState(tenantId: string, principalId: string, now: number = Date.now()): boolean {
  sweep(now);
  for (const pending of pendingGoogleOAuthStates.values()) {
    if (pending.tenantId === tenantId && pending.principalId === principalId) return true;
  }
  return false;
}

export function clearGoogleOAuthStatesForTesting(): void {
  pendingGoogleOAuthStates.clear();
}
