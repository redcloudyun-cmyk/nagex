import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const server = fs.readFileSync('apps/control-center/server.mjs', 'utf8');
const app = fs.readFileSync('apps/control-center/app.js', 'utf8');

test('public health is minimal and does not expose admin read model', () => {
  assert.ok(server.includes("url.pathname === '/admin/api/health'"));
  assert.ok(server.includes("status: 'ok'"));
  assert.ok(server.includes('publicHealthOnly: true'));
  assert.ok(server.includes('fullAdminReadModelPublic: false'));
  const healthBlock = server.slice(server.indexOf("url.pathname === '/admin/api/health'"), server.indexOf("url.pathname === '/admin/api/session'"));
  assert.equal(healthBlock.includes('adminReadModel'), false);
  assert.equal(healthBlock.includes('readModel.overview'), false);
});

test('all detailed admin APIs require authentication and RBAC', () => {
  assert.ok(server.includes('function requireAdmin'));
  assert.ok(server.includes("writeJson(res, 401, { error: 'ADMIN_AUTH_REQUIRED' })"));
  assert.ok(server.includes("writeJson(res, 403, { error: 'ADMIN_RBAC_DENIED'"));
  assert.ok(server.includes("url.pathname === '/admin/api/read-model'"));
  assert.ok(server.includes('permissionForPath'));
});

test('frontend locks anonymous dashboard instead of rendering operational data', () => {
  assert.ok(app.includes("fetch('/admin/api/read-model'"));
  assert.ok(app.includes('state.data = {'));
  assert.ok(app.includes('locked: true'));
  assert.ok(app.includes('Admin Access Required'));
  assert.ok(app.includes('Administrator authentication is required'));
});

test('admin session is isolated from user session and supports logout', () => {
  assert.ok(server.includes('__Host-nagex_admin_session'));
  assert.ok(server.includes('Path=/admin'));
  assert.ok(server.includes('HttpOnly'));
  assert.ok(server.includes('Secure'));
  assert.ok(server.includes('SameSite=Strict'));
  assert.equal(server.includes(`${'${adminSessionCookie}=active'}`), false);
  assert.ok(server.includes("url.pathname === '/admin/api/logout'"));
  assert.ok(server.includes('separateFromUserSession: true'));
  assert.ok(server.includes('idleTimeoutSeconds'));
  assert.ok(server.includes('absoluteLifetimeSeconds'));
  assert.ok(server.includes('expiresAt'));
});

test('Cloudflare Access headers are not trusted unless explicitly enabled and allowlisted', () => {
  assert.ok(server.includes('cf-access-jwt-assertion'));
  assert.ok(server.includes('verifyCloudflareAccessJwt'));
  assert.ok(server.includes('NAGEX_CONTROL_ADMIN_ALLOWLIST'));
  assert.equal(server.includes("NAGEX_TRUST_CLOUDFLARE_ACCESS_HEADERS === 'YES'"), false);
});

test('initial admin identity policy is exact email allowlist and default deny', () => {
  assert.ok(server.includes("initialSuperAdminEmail = 'redcloudyun@gmail.com'"));
  assert.ok(server.includes('redcloudyun@gmail.com'));
  assert.ok(server.includes("defaultAdminAccess: 'DENY'"));
  assert.ok(server.includes('exactEmailAllowlist: true'));
  assert.ok(server.includes('domainWildcardAllowed: false'));
  assert.ok(server.includes('localPasswordLogin: false'));
  assert.equal(server.includes('@gmail.com:*'), false);
  assert.equal(server.includes("endsWith('@gmail.com')"), false);
  assert.equal(server.includes('cfEmail.endsWith'), false);
});

test('critical admin actions require step-up reason and before/after audit state', () => {
  assert.ok(server.includes("url.pathname === '/admin/api/actions/critical'"));
  assert.ok(server.includes('CRITICAL_ADMIN_STEP_UP_REQUIRED'));
  assert.ok(server.includes('beforeState'));
  assert.ok(server.includes('afterState'));
  assert.ok(server.includes('auditRef'));
  assert.ok(server.includes('stepUpConfirmed: true'));
});

test('Cloudflare Access JWT bridge validates issuer audience expiry and signature', () => {
  assert.ok(server.includes('CF_ACCESS_TEAM_DOMAIN'));
  assert.ok(server.includes('CF_ACCESS_AUDIENCE'));
  assert.ok(server.includes("claims.iss !== `https://${cfAccessTeamDomain}`"));
  assert.ok(server.includes('audiences.includes(cfAccessAudience)'));
  assert.ok(server.includes('claims.exp <= now'));
  assert.ok(server.includes("crypto.createVerify('RSA-SHA256')"));
  assert.ok(server.includes('/cdn-cgi/access/certs'));
});

test('Access identity maps only verified normalized email to admin session', () => {
  assert.ok(server.includes('trim().toLowerCase()'));
  assert.ok(server.includes('authorizedAdmins.get(verified.email)'));
  assert.ok(server.includes('NOT_ALLOWLISTED'));
  assert.ok(server.includes('CLOUDFLARE_ACCESS_GOOGLE'));
  assert.ok(server.includes('createAdminSession(actor)'));
  assert.ok(server.includes('admin_login_success'));
  assert.ok(server.includes("url.pathname === '/admin/api/auth/access/bootstrap'"));
  assert.ok(server.includes("req.method !== 'POST'"));
});

test('admin session cookie is signed, isolated and not a user session', () => {
  assert.ok(server.includes('crypto.createHmac'));
  assert.ok(server.includes('verifySessionCookie'));
  assert.ok(server.includes('Path=/admin'));
  assert.ok(server.includes('HttpOnly; Secure; SameSite=Strict'));
  assert.equal(server.includes('Domain=.agex.site'), false);
});

test('frontend bootstraps from real session endpoint and disables role simulation authority', () => {
  assert.ok(app.includes("fetch('/admin/api/session'"));
  assert.ok(app.includes("fetch('/admin/api/auth/access/bootstrap'"));
  assert.ok(app.includes('health.cfAccessJwtPresent'));
  assert.ok(app.includes('session.admin.role'));
  assert.ok(app.includes('role-select').valueOf());
  assert.ok(app.includes('disabled = true'));
});

test('audit records admin auth events without logging token contents', () => {
  assert.ok(server.includes('auditAdmin'));
  assert.ok(server.includes('admin_session_created'));
  assert.ok(server.includes('admin_login_failure'));
  assert.ok(server.includes('admin_logout'));
  assert.equal(server.includes('console.log(jwt'), false);
  assert.equal(server.includes('Cf-Access-Jwt-Assertion'), false);
});
