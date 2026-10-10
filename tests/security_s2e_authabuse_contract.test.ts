// Security Gate S2E — source contract that keeps the authentication-abuse / trusted client-IP boundary from regressing.
// Behavior is certified by security_s2e_auth_abuse; this only pins the structure it depends on.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (rel: string): string => fs.readFileSync(path.resolve(rel), 'utf8').replace(/\r\n/g, '\n');
const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []));
const srcFiles = walk('src');
const rel = (f: string) => path.relative(process.cwd(), f).replace(/\\/g, '/');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('S2E — authentication abuse / client-IP contract', () => {
  it('no client-supplied address header is read anywhere except by the resolver input in server_web', () => {
    const offenders: string[] = [];
    for (const f of srcFiles) {
      const code = stripComments(fs.readFileSync(f, 'utf8'));
      if (/x-forwarded-for|cf-connecting-ip|x-real-ip|true-client-ip|['"]forwarded['"]/i.test(code) && !['src/server_web.ts'].includes(rel(f))) offenders.push(rel(f));
    }
    assert.deepEqual(offenders, [], 'only server_web hands X-Forwarded-For (to the resolver); nothing else reads an address header');
    const server = stripComments(read('src/server_web.ts'));
    const uses = server.match(/x-forwarded-for/gi) ?? [];
    assert.ok(uses.length <= 2, 'server_web reads x-forwarded-for only to feed resolveClientIp and the misconfiguration hint');
    assert.equal(/cf-connecting-ip|x-real-ip/i.test(server), false);
  });

  it('the resolver baseline is the TCP peer, trusts a header only through a configured proxy, and is right-to-left', () => {
    const src = stripComments(read('src/http/client-ip.ts'));
    assert.match(src, /input\.trustedProxies\.size === 0 \|\| !input\.trustedProxies\.has\(peer\)\) return peer/);
    assert.match(src, /for \(let i = chain\.length - 1; i >= 0; i--\)/, 'walks from the right');
    assert.equal(/CF-?Connecting|cloudflare/i.test(src), false, 'no Cloudflare-specific trust or ranges in code');
    assert.equal(/\b(\d{1,3}\.){3}\d{1,3}\/\d+/.test(src), false, 'no hardcoded CIDR ranges');
  });

  it('only the HTTP layer registers an address; routes only read it; the registry is keyed by header object', () => {
    const attachers = srcFiles.filter((f) => /attachResolvedClientIp\(/.test(stripComments(fs.readFileSync(f, 'utf8'))) && rel(f) !== 'src/http/client-ip.ts').map(rel);
    assert.deepEqual(attachers, ['src/server_web.ts']);
    assert.match(read('src/http/client-ip.ts'), /new WeakMap<object, string>\(\)/);
    const identity = read('src/http/request-identity.ts');
    assert.match(identity, /carryResolvedClientIp\(headers, out\)/);
    for (const f of ['src/http/routes/auth.routes.ts', 'src/http/routes/account.routes.ts', 'src/http/routes/organization.routes.ts']) {
      const code = stripComments(read(f));
      assert.match(code, /const clientIp = clientIpOf\(headers\)/, f);
      assert.equal(/headers\[['"]x-forwarded-for['"]\]/i.test(code), false, f);
      assert.equal(/socket|remoteAddress/.test(code), false, f);
    }
  });

  it('the test-only peer seam is a programmatic option: never an env var or header, refused in production, absent from production entry points', () => {
    const server = stripComments(read('src/server_web.ts'));
    assert.match(server, /opts\?\.clientIp\?\.testPeerAddress && process\.env\.NODE_ENV === 'production'/);
    assert.equal(/process\.env\.[A-Z_]*TEST_?PEER/i.test(server), false);
    assert.equal(/headers\[['"]x-test-peer['"]\]/i.test(server), false, 'the header is read only by test code');
    assert.match(server, /export const server = createServerInstance\(\);/);
    const start = server.slice(server.indexOf('export async function startNagexServer'));
    assert.equal(/testPeerAddress|clientIp:/.test(start), false, 'the real start path never passes the seam');
    const tests = srcFiles.filter((f) => /testPeerAddress/.test(fs.readFileSync(f, 'utf8'))).map(rel);
    assert.deepEqual(tests, ['src/server_web.ts']);
  });

  it('legacy password-auth routes are disabled before any password hashing', () => {
    const auth = stripComments(read('src/http/routes/auth.routes.ts'));
    assert.match(auth, /EMAIL_PASSWORD_AUTH_DISABLED/);
    assert.match(auth, /PASSWORD_AUTH_DISABLED_RESPONSE/);
    for (const path of [
      '/api/v1/auth/signup',
      '/api/v1/auth/verify-email',
      '/api/v1/auth/resend-verification',
      '/api/v1/auth/login',
      '/api/v1/auth/forgot-password',
      '/api/v1/auth/reset-password',
    ]) {
      assert.match(auth, new RegExp(path.replace(/\//g, '\\/')));
    }
    assert.equal(/verifyPassword\(|hashPassword\(|guard\.check\(|throttleSubject\(/.test(auth), false, 'closed password routes have no brute-force/hash path');
    const account = stripComments(read('src/http/routes/account.routes.ts'));
    for (const route of ["pathname === '/api/v1/account/reactivate'", "pathname === '/api/v1/account/delete/cancel'"]) {
      const start = account.indexOf(route);
      const body = account.slice(start, account.indexOf('\n  }\n', start));
      assert.match(body, /throttleSubject\('credential'/, `${route} shares the credential budget`);
      assert.ok(body.indexOf('guard.check(') > 0 && body.indexOf('guard.check(') < body.indexOf('verifyPassword('), `${route}: check precedes hashing`);
      assert.equal(/ACCOUNT_NOT_DISABLED|NO_PENDING_DELETION/.test(body), false, `${route}: no distinct wrong-state answer`);
      assert.match(body, /identity\.accountState !== '(DISABLED|DELETION_PENDING)'\) \{\n\s+guard\.hit\(subject\)/, `${route}: wrong state is the same failed guess`);
    }
  });

  it('forgot-password and resend-verification are part of the disabled password policy', () => {
    const auth = stripComments(read('src/http/routes/auth.routes.ts'));
    assert.match(auth, /'\/api\/v1\/auth\/forgot-password'/);
    assert.match(auth, /'\/api\/v1\/auth\/resend-verification'/);
    assert.match(auth, /EMAIL_PASSWORD_AUTH_DISABLED/);
    assert.equal(/IdentityRateLimiter|rateLimiter\./.test(auth), false, 'the single-key limiter is gone');
    assert.equal(fs.existsSync('src/identity/identity.rate-limiter.ts'), false);
  });

  it('the guard has the three dimensions, a bounded store, progressive cooldowns and an in-code cap', () => {
    const g = stripComments(read('src/identity/auth-abuse-guard.ts'));
    for (const dim of ["'ip'", "'account'", "'pair'"]) assert.ok(g.includes(dim), dim);
    assert.match(g, /maxBucketsPerDimension/);
    assert.match(g, /makeRoom\(/);
    assert.match(g, /2 \*\* bucket\.level/);
    assert.match(g, /maxCooldownMs\)/);
    assert.equal(/lockout|permanent|blockedUntil\s*=\s*Infinity/i.test(g.replace(/never a lockout|no .*lockout|never permanent/gi, '')), false);
    // the account digest is bounded input
    assert.match(g, /slice\(0, MAX_ACCOUNT_INPUT\)/);
  });

  it('route-access no longer claims the account-recovery routes are unlimited', () => {
    assert.equal(/S0-04, later phase/.test(read('src/http/route-access.ts')), false);
  });
});
