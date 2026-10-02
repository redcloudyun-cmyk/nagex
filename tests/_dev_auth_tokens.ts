// R24.6C1 — test-side opt-in for the raw development auth tokens.
//
// The application NEVER exposes devVerificationToken / devResetToken unless
// NAGEX_EXPOSE_DEV_AUTH_TOKENS=1 (see src/identity/dev-auth-tokens.ts). A test
// file that legitimately needs a raw token to drive signup -> verify or
// forgot -> reset calls this ONCE at module load: it enables the flag for
// that file's process only and restores the previous value when the file's
// tests finish. It is never set globally (not in _setup.ts), so every other
// test — and the application itself — runs with exposure OFF.
import { after } from 'node:test';
import { DEV_AUTH_TOKEN_FLAG } from '../src/identity/dev-auth-tokens.js';

export function enableDevAuthTokensForFile(): void {
  const previous = process.env[DEV_AUTH_TOKEN_FLAG];
  process.env[DEV_AUTH_TOKEN_FLAG] = '1';
  after(() => {
    if (previous === undefined) delete process.env[DEV_AUTH_TOKEN_FLAG];
    else process.env[DEV_AUTH_TOKEN_FLAG] = previous;
  });
}
