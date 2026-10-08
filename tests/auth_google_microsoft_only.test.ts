import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleAuthRoutes } from '../src/http/routes/auth.routes.js';
import { handleAccountRoutes } from '../src/http/routes/account.routes.js';
import { hashPassword } from '../src/identity/identity.crypto.js';
import { IdentityStore } from '../src/identity/identity.store.js';
import { IdentityTokenStore } from '../src/identity/identity.tokens.js';
import { IdentityAuditStore } from '../src/identity/identity.audit.js';
import { SessionStore } from '../src/sessions/session.store.js';

function stores() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-auth-gm-only-'));
  return {
    identityStore: new IdentityStore({ dir: path.join(root, 'identity') }),
    identityTokenStore: new IdentityTokenStore({ dir: path.join(root, 'tokens') }),
    identityAuditStore: new IdentityAuditStore({ dir: path.join(root, 'audit') }),
    sessionStore: new SessionStore({ dir: path.join(root, 'sessions') }),
  };
}

test('end-user email password auth routes are unavailable', async () => {
  const deps = stores();
  for (const pathname of [
    '/api/v1/auth/signup',
    '/api/v1/auth/verify-email',
    '/api/v1/auth/resend-verification',
    '/api/v1/auth/login',
    '/api/v1/auth/forgot-password',
    '/api/v1/auth/reset-password',
  ]) {
    const result = await handleAuthRoutes('POST', pathname, {}, {}, {}, deps);
    assert.equal(result?.status, 410, pathname);
    assert.equal((result?.data as any).error.code, 'EMAIL_PASSWORD_AUTH_DISABLED', pathname);
  }
});

test('password credential mutation is unavailable but session inspection still works', async () => {
  const deps = stores();
  const { identity } = deps.identityStore.createAccount('oauth-user@example.test', hashPassword('LegacyOnly123!'));
  deps.identityStore.transitionState(identity.userId, 'ACTIVE');
  const session = deps.sessionStore.createAuthSession(`ten_${identity.userId}`, identity.userId, 'MAIN');
  const headers = { cookie: `nagex_session=${session.sessionId}` };

  const sessionResult = await handleAuthRoutes('GET', '/api/v1/auth/session', null, headers, {}, deps);
  assert.equal(sessionResult?.status, 200);
  assert.equal((sessionResult?.data as any).authenticated, true);

  const passwordResult = await handleAccountRoutes('POST', '/api/v1/account/password', {
    currentPassword: 'LegacyOnly123!',
    newPassword: 'NewPassword123!',
    newPasswordConfirmation: 'NewPassword123!',
  }, headers, {}, deps);
  assert.equal(passwordResult?.status, 410);
  assert.equal((passwordResult?.data as any).error.code, 'EMAIL_PASSWORD_AUTH_DISABLED');
});
