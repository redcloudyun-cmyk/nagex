// Security Gate S2E — the one place the auth routes share their abuse guard and their refusal shape.
import { AuthAbuseGuard, type ThrottleDecision, type ThrottleSubject } from '../identity/auth-abuse-guard.js';
import { clientIpBucket, clientIpOf } from './client-ip.js';
import type { ApiResult } from './http-types.js';

type HeaderBag = Record<string, string | string[] | undefined>;

// Process-local by design (single-node deployment); a distributed backend is a separate, later decision.
export const defaultAuthAbuseGuard = new AuthAbuseGuard();

export function throttleSubject(scope: ThrottleSubject['scope'], headers: HeaderBag | undefined, account?: unknown): ThrottleSubject {
  return { scope, ipBucket: clientIpBucket(clientIpOf(headers)), account };
}

// 429 for a request that proves nothing and is refused before any password hashing. Identical for an existing and a
// non-existing account (the account dimension is keyed on the submitted address, not on whether it exists).
export function throttledResponse(decision: ThrottleDecision, message: string): ApiResult {
  const retryAfterSeconds = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
  return {
    status: 429,
    headers: { 'Retry-After': String(retryAfterSeconds) },
    data: { error: { code: 'AUTH_RATE_LIMITED', message, retryAfterSeconds } },
  };
}
