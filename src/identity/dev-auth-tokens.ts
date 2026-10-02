// R24.6C1 — the ONE policy for exposing raw development authentication tokens.
//
// NAgex has no mail-delivery capability yet, so the email-verification,
// password-reset and email-change token lifecycles cannot reach a user
// through a real channel. Earlier builds therefore returned the raw one-time
// token in the HTTP response ("devVerificationToken" / "devResetToken") with
// no gating — which let ANY caller who knew an account's email take it over
// (forgot-password returned the raw reset credential to the requester).
//
// Now a raw token is returned ONLY when this explicit opt-in is set:
//
//     NAGEX_EXPOSE_DEV_AUTH_TOKENS=1
//
// - default / absent / empty / any other value (including "true", "yes",
//   "0") => OFF. Only the exact string "1" enables it.
// - NODE_ENV (or any other signal) never implies exposure.
// - It is read on every request (never cached) so a test can enable it for
//   itself and restore it; nothing in the application ever sets it.
//
// Every route that could expose a token goes through devAuthTokenFields();
// there is deliberately no route-specific gate.
export const DEV_AUTH_TOKEN_FLAG = 'NAGEX_EXPOSE_DEV_AUTH_TOKENS';

export function devAuthTokensExposed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[DEV_AUTH_TOKEN_FLAG] === '1';
}

export type DevAuthTokenField = 'devVerificationToken' | 'devResetToken';

// Spread into a response body: `{ message, ...devAuthTokenFields('devResetToken', rawToken) }`.
// Returns an empty object (no key at all — not null, not "") unless the opt-in is set.
export function devAuthTokenFields(field: DevAuthTokenField, rawToken: string, env: NodeJS.ProcessEnv = process.env): Partial<Record<DevAuthTokenField, string>> {
  return devAuthTokensExposed(env) ? { [field]: rawToken } : {};
}

// Truthful delivery state. No mail provider exists, so a verification/reset
// request is RECORDED but nothing is delivered to anyone. Clients must not
// present "email sent" on the strength of these responses.
export const AUTH_EMAIL_DELIVERY = { status: 'NOT_CONFIGURED' } as const;
