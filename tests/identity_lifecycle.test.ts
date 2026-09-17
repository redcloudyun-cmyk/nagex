import { test } from 'node:test';
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

function createTestApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-identity-test-'));
  const identityStore = new IdentityStore({ dir: path.join(tmpDir, 'identity') });
  const identityTokenStore = new IdentityTokenStore({ dir: path.join(tmpDir, 'tokens') });
  const identityAuditStore = new IdentityAuditStore({ dir: path.join(tmpDir, 'audit') });
  const sessionStore = new SessionStore({ dir: path.join(tmpDir, 'sessions') });
  return {
    identityStore,
    identityTokenStore,
    identityAuditStore,
    sessionStore,
  };
}

test('R13-IDENTITY-001: Account Creation (Signup) & Validation', async () => {
  const deps = createTestApp();

  // Valid signup
  const res = await handleAuthRoutes('POST', '/api/v1/auth/signup', {
    email: 'user1@example.com',
    password: 'password123',
    passwordConfirmation: 'password123',
    termsAccepted: true,
    privacyAccepted: true,
  }, {}, {}, deps);

  assert.equal(res?.status, 201);
  const data = res?.data as any;
  assert.equal(data.status, 'PENDING_VERIFICATION');
  assert.ok(data.user.userId.startsWith('usr_'));
  assert.equal(data.user.email, 'user1@example.com');
  assert.ok(data.devVerificationToken);

  // Duplicate signup rejection
  const dupRes = await handleAuthRoutes('POST', '/api/v1/auth/signup', {
    email: 'USER1@example.com', // test case-insensitivity / normalization
    password: 'password123',
    passwordConfirmation: 'password123',
    termsAccepted: true,
    privacyAccepted: true,
  }, {}, {}, deps);

  assert.equal(dupRes?.status, 409);
  assert.equal((dupRes?.data as any).error.code, 'AUTH_EMAIL_ALREADY_EXISTS');

  // Mismatched passwords
  const mismatchRes = await handleAuthRoutes('POST', '/api/v1/auth/signup', {
    email: 'user2@example.com',
    password: 'password123',
    passwordConfirmation: 'different123',
    termsAccepted: true,
    privacyAccepted: true,
  }, {}, {}, deps);

  assert.equal(mismatchRes?.status, 400);
  assert.equal((mismatchRes?.data as any).error.code, 'PASSWORD_MISMATCH');
});

test('R13-IDENTITY-002: Email Verification & Token Lifecycle', async () => {
  const deps = createTestApp();

  // Signup
  const signupRes = await handleAuthRoutes('POST', '/api/v1/auth/signup', {
    email: 'verify@example.com',
    password: 'password123',
    passwordConfirmation: 'password123',
    termsAccepted: true,
    privacyAccepted: true,
  }, {}, {}, deps);

  const token = (signupRes?.data as any).devVerificationToken;
  assert.ok(token);

  // Verify email
  const verifyRes = await handleAuthRoutes('POST', '/api/v1/auth/verify-email', { token }, {}, {}, deps);
  assert.equal(verifyRes?.status, 200);
  assert.equal((verifyRes?.data as any).status, 'ACTIVE');

  // Verification token replay prevention (one-time use)
  const replayRes = await handleAuthRoutes('POST', '/api/v1/auth/verify-email', { token }, {}, {}, deps);
  assert.equal(replayRes?.status, 400);
  assert.equal((replayRes?.data as any).error.code, 'INVALID_VERIFICATION_TOKEN');
});

test('R13-IDENTITY-003: Login, State Machine, and Uniform Error Messages', async () => {
  const deps = createTestApp();

  // Signup & verify
  const signupRes = await handleAuthRoutes('POST', '/api/v1/auth/signup', {
    email: 'login@example.com',
    password: 'Password123!',
    passwordConfirmation: 'Password123!',
    termsAccepted: true,
    privacyAccepted: true,
  }, {}, {}, deps);
  const userId = (signupRes?.data as any).user.userId;
  const token = (signupRes?.data as any).devVerificationToken;

  // Login before verification -> 403 UNVERIFIED
  const unverifiedLogin = await handleAuthRoutes('POST', '/api/v1/auth/login', {
    email: 'login@example.com',
    password: 'Password123!',
  }, {}, {}, deps);
  assert.equal(unverifiedLogin?.status, 403);
  assert.equal((unverifiedLogin?.data as any).error.code, 'AUTH_UNVERIFIED_EMAIL');

  // Verify
  await handleAuthRoutes('POST', '/api/v1/auth/verify-email', { token }, {}, {}, deps);

  // Wrong password -> 401 with uniform generic message (no hint whether email exists)
  const wrongPassword = await handleAuthRoutes('POST', '/api/v1/auth/login', {
    email: 'login@example.com',
    password: 'WrongPassword!',
  }, {}, {}, deps);
  assert.equal(wrongPassword?.status, 401);
  assert.equal((wrongPassword?.data as any).error.message, 'Invalid email or password.');

  // Non-existent email -> 401 with identical generic message
  const nonExistent = await handleAuthRoutes('POST', '/api/v1/auth/login', {
    email: 'nonexistent@example.com',
    password: 'Password123!',
  }, {}, {}, deps);
  assert.equal(nonExistent?.status, 401);
  assert.equal((nonExistent?.data as any).error.message, 'Invalid email or password.');

  // Valid login -> 200 with session cookie
  const validLogin = await handleAuthRoutes('POST', '/api/v1/auth/login', {
    email: 'login@example.com',
    password: 'Password123!',
  }, {}, {}, deps);
  assert.equal(validLogin?.status, 200);
  assert.ok(validLogin?.headers?.['Set-Cookie']);
  const sessionCookie = validLogin?.headers?.['Set-Cookie'];
  assert.ok(sessionCookie?.includes('nagex_session='));

  // Test disabled state
  deps.identityStore.transitionState(userId, 'DISABLED');
  const disabledLogin = await handleAuthRoutes('POST', '/api/v1/auth/login', {
    email: 'login@example.com',
    password: 'Password123!',
  }, {}, {}, deps);
  assert.equal(disabledLogin?.status, 403);
  assert.equal((disabledLogin?.data as any).error.code, 'AUTH_ACCOUNT_DISABLED');
});

test('R13-IDENTITY-004: Session Management, Logout, Logout-All, and Revoke', async () => {
  const deps = createTestApp();

  // Create active user
  const { identity } = deps.identityStore.createAccount('session@example.com', hashPassword('password123'));
  deps.identityStore.transitionState(identity.userId, 'ACTIVE');

  // Create session 1 and session 2
  const tenantId = `ten_${identity.userId}`;
  const sess1 = deps.sessionStore.createAuthSession(tenantId, identity.userId, 'MAIN', { userAgent: 'Browser1' });
  const sess2 = deps.sessionStore.createAuthSession(tenantId, identity.userId, 'MAIN', { userAgent: 'Browser2' });

  // Get active sessions
  const listRes = await handleAccountRoutes('GET', '/api/v1/account/sessions', null, {
    cookie: `nagex_session=${sess1.sessionId}`,
  }, {}, deps);
  assert.equal(listRes?.status, 200);
  assert.equal((listRes?.data as any).sessions.length, 2);

  // Revoke session 2 from session 1
  const revokeRes = await handleAccountRoutes('DELETE', `/api/v1/account/sessions/${sess2.sessionId}`, null, {
    cookie: `nagex_session=${sess1.sessionId}`,
  }, {}, deps);
  assert.equal(revokeRes?.status, 200);

  // Verify session 2 is gone
  const listRes2 = await handleAccountRoutes('GET', '/api/v1/account/sessions', null, {
    cookie: `nagex_session=${sess1.sessionId}`,
  }, {}, deps);
  assert.equal((listRes2?.data as any).sessions.length, 1);

  // Logout session 1
  const logoutRes = await handleAuthRoutes('POST', '/api/v1/auth/logout', null, {
    cookie: `nagex_session=${sess1.sessionId}`,
  }, {}, deps);
  assert.equal(logoutRes?.status, 200);

  // Protected request after logout returns 401
  const afterLogout = await handleAccountRoutes('GET', '/api/v1/account', null, {
    cookie: `nagex_session=${sess1.sessionId}`,
  }, {}, deps);
  assert.equal(afterLogout?.status, 401);
});

test('R13-IDENTITY-005: IDOR Defense — Foreign Session Revocation Rejection (403)', async () => {
  const deps = createTestApp();

  // User A
  const { identity: userA } = deps.identityStore.createAccount('usera@example.com', hashPassword('password123'));
  deps.identityStore.transitionState(userA.userId, 'ACTIVE');
  const sessA = deps.sessionStore.createAuthSession(`ten_${userA.userId}`, userA.userId, 'MAIN');

  // User B
  const { identity: userB } = deps.identityStore.createAccount('userb@example.com', hashPassword('password123'));
  deps.identityStore.transitionState(userB.userId, 'ACTIVE');
  const sessB = deps.sessionStore.createAuthSession(`ten_${userB.userId}`, userB.userId, 'MAIN');

  // User A attempts to delete User B's session -> 403 Forbidden
  const idorRes = await handleAccountRoutes('DELETE', `/api/v1/account/sessions/${sessB.sessionId}`, null, {
    cookie: `nagex_session=${sessA.sessionId}`,
  }, {}, deps);

  assert.equal(idorRes?.status, 403);
  assert.equal((idorRes?.data as any).error.code, 'FORBIDDEN');

  // Verify User B's session was NOT revoked
  const checkB = deps.sessionStore.getSession(sessB.sessionId);
  assert.ok(checkB);
});

test('R13-IDENTITY-006: Password Change, Password Recovery & Session Invalidation', async () => {
  const deps = createTestApp();

  const { identity } = deps.identityStore.createAccount('pw@example.com', hashPassword('OldPassword123!'));
  deps.identityStore.transitionState(identity.userId, 'ACTIVE');
  const sess1 = deps.sessionStore.createAuthSession(`ten_${identity.userId}`, identity.userId, 'MAIN');
  const sess2 = deps.sessionStore.createAuthSession(`ten_${identity.userId}`, identity.userId, 'MAIN');

  // Change password
  const changeRes = await handleAccountRoutes('POST', '/api/v1/account/password', {
    currentPassword: 'OldPassword123!',
    newPassword: 'NewPassword123!',
    newPasswordConfirmation: 'NewPassword123!',
  }, { cookie: `nagex_session=${sess1.sessionId}` }, {}, deps);

  assert.equal(changeRes?.status, 200);

  // Sess1 remains active, sess2 was revoked
  assert.ok(deps.sessionStore.getSession(sess1.sessionId));
  assert.equal(deps.sessionStore.getSession(sess2.sessionId), null);

  // Forgot password
  const forgotRes = await handleAuthRoutes('POST', '/api/v1/auth/forgot-password', { email: 'pw@example.com' }, {}, {}, deps);
  assert.equal(forgotRes?.status, 200);
  const resetToken = (forgotRes?.data as any).devResetToken;
  assert.ok(resetToken);

  // Reset password
  const resetRes = await handleAuthRoutes('POST', '/api/v1/auth/reset-password', {
    token: resetToken,
    newPassword: 'ResetPassword123!',
    newPasswordConfirmation: 'ResetPassword123!',
  }, {}, {}, deps);
  assert.equal(resetRes?.status, 200);

  // All previous sessions (including sess1) are now revoked
  assert.equal(deps.sessionStore.getSession(sess1.sessionId), null);

  // Login with new password
  const loginRes = await handleAuthRoutes('POST', '/api/v1/auth/login', {
    email: 'pw@example.com',
    password: 'ResetPassword123!',
  }, {}, {}, deps);
  assert.equal(loginRes?.status, 200);
});

test('R13-IDENTITY-007: Profile Update and Email Change Flow', async () => {
  const deps = createTestApp();

  const { identity } = deps.identityStore.createAccount('profile@example.com', hashPassword('password123'));
  deps.identityStore.transitionState(identity.userId, 'ACTIVE');
  const sess = deps.sessionStore.createAuthSession(`ten_${identity.userId}`, identity.userId, 'MAIN');

  // Update profile
  const profileRes = await handleAccountRoutes('PATCH', '/api/v1/account/profile', {
    displayName: 'Alex Smith',
    locale: 'KR',
    timezone: 'Asia/Seoul',
  }, { cookie: `nagex_session=${sess.sessionId}` }, {}, deps);
  assert.equal(profileRes?.status, 200);
  assert.equal((profileRes?.data as any).profile.displayName, 'Alex Smith');
  assert.equal((profileRes?.data as any).profile.locale, 'KR');

  // Request email change
  const emailReqRes = await handleAccountRoutes('POST', '/api/v1/account/email/change-request', {
    currentPassword: 'password123',
    newEmail: 'newemail@example.com',
  }, { cookie: `nagex_session=${sess.sessionId}` }, {}, deps);

  assert.equal(emailReqRes?.status, 200);
  const changeToken = (emailReqRes?.data as any).devVerificationToken;
  assert.ok(changeToken);

  // Confirm email change
  const confirmRes = await handleAccountRoutes('POST', '/api/v1/account/email/confirm', {
    token: changeToken,
  }, {}, {}, deps);

  assert.equal(confirmRes?.status, 200);
  assert.equal((confirmRes?.data as any).user.email, 'newemail@example.com');
});

test('R13-IDENTITY-008: Account Disable, Deletion, and Grace Period Cancellation', async () => {
  const deps = createTestApp();

  const { identity } = deps.identityStore.createAccount('lifecycle@example.com', hashPassword('password123'));
  deps.identityStore.transitionState(identity.userId, 'ACTIVE');
  const sess = deps.sessionStore.createAuthSession(`ten_${identity.userId}`, identity.userId, 'MAIN');

  // Request deletion
  const deleteReq = await handleAccountRoutes('POST', '/api/v1/account/delete', {
    password: 'password123',
  }, { cookie: `nagex_session=${sess.sessionId}` }, {}, deps);

  assert.equal(deleteReq?.status, 200);
  assert.equal((deleteReq?.data as any).accountState, 'DELETION_PENDING');
  assert.ok((deleteReq?.data as any).scheduledPurgeAt);

  // Sessions revoked
  assert.equal(deps.sessionStore.getSession(sess.sessionId), null);

  // Cancel deletion
  const cancelRes = await handleAccountRoutes('POST', '/api/v1/account/delete/cancel', {
    email: 'lifecycle@example.com',
    password: 'password123',
  }, {}, {}, deps);

  assert.equal(cancelRes?.status, 200);
  assert.equal((cancelRes?.data as any).accountState, 'ACTIVE');

  // Account is ACTIVE again
  const activeIdentity = deps.identityStore.getByUserId(identity.userId);
  assert.equal(activeIdentity?.accountState, 'ACTIVE');
});

test('R13-IDENTITY-009: Audit Event Trail Verification', async () => {
  const deps = createTestApp();

  const { identity } = deps.identityStore.createAccount('audit@example.com', hashPassword('password123'));
  deps.identityAuditStore.recordEvent(identity.userId, 'account.created', 'SUCCESS');
  deps.identityAuditStore.recordEvent(identity.userId, 'password.changed', 'SUCCESS');

  const events = deps.identityAuditStore.listForUser(identity.userId);
  assert.ok(events.some((e: any) => e.eventType === 'account.created'));
  assert.ok(events.some((e: any) => e.eventType === 'password.changed'));
});
