// Security Gate S2E - current authentication-abuse and trusted client-IP boundary.
//
// Current auth policy disables local email/password auth entirely. These tests
// therefore certify two things:
// 1. the trusted client-IP resolver and generic AuthAbuseGuard still behave as
//    the abuse-control primitive for credential-sensitive routes; and
// 2. every legacy password route is closed with 410 before any password hashing,
//    account mutation, token issuance, or password brute-force surface exists.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';
import type http from 'node:http';
import { createServerInstance, handleAsyncApiRequest, identityTokenStore, withTestServer } from '../src/server_web.js';
import { AuthAbuseGuard, DEFAULT_THROTTLE_POLICY, type ThrottlePolicy } from '../src/identity/auth-abuse-guard.js';
import { clientIpBucket, clientIpOf, normalizeIp, parseTrustedProxies, resolveClientIp, UNRESOLVED_CLIENT_IP } from '../src/http/client-ip.js';

const PASSWORD_ENDPOINTS = [
  '/api/v1/auth/signup',
  '/api/v1/auth/verify-email',
  '/api/v1/auth/resend-verification',
  '/api/v1/auth/login',
  '/api/v1/auth/forgot-password',
  '/api/v1/auth/reset-password',
] as const;

const realScrypt = nodeCrypto.scryptSync;
let scryptCalls = 0;
beforeEach(() => {
  scryptCalls = 0;
  (nodeCrypto as any).scryptSync = (...a: unknown[]) => {
    scryptCalls += 1;
    return (realScrypt as any).apply(nodeCrypto, a);
  };
});
afterEach(() => {
  (nodeCrypto as any).scryptSync = realScrypt;
});

const peerSeam = (req: http.IncomingMessage): string | undefined => (typeof req.headers['x-test-peer'] === 'string' ? (req.headers['x-test-peer'] as string) : undefined);
async function serve(run: (post: Post) => Promise<void>, opts: { trusted?: string; guard?: AuthAbuseGuard } = {}) {
  await withTestServer(async (origin) => {
    const post: Post = (p, body, headers = {}) => fetch(origin + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    await run(post);
  }, { authAbuseGuard: opts.guard ?? new AuthAbuseGuard(), clientIp: { trustedProxies: opts.trusted ?? '', testPeerAddress: peerSeam } });
}
type Post = (path: string, body: unknown, headers?: Record<string, string>) => Promise<Response>;

describe('S2E - trusted client-IP resolver (pure)', () => {
  const trusted = parseTrustedProxies('10.0.0.0/8, 192.168.1.5, ::1, fd00::/8');

  it('with no trusted proxy the TCP peer is the client and X-Forwarded-For is never read', () => {
    const none = parseTrustedProxies(undefined);
    assert.equal(resolveClientIp({ peerAddress: '203.0.113.9', forwardedFor: '1.2.3.4', trustedProxies: none }), '203.0.113.9');
    assert.equal(resolveClientIp({ peerAddress: '127.0.0.1', forwardedFor: '1.2.3.4, 5.6.7.8', trustedProxies: none }), '127.0.0.1');
  });

  it('an untrusted peer cannot make its header authoritative, even if the header names a trusted proxy', () => {
    assert.equal(resolveClientIp({ peerAddress: '203.0.113.9', forwardedFor: '10.0.0.1, 198.51.100.1', trustedProxies: trusted }), '203.0.113.9');
  });

  it('resolves right-to-left through trusted hops and never trusts the leftmost entry', () => {
    assert.equal(resolveClientIp({ peerAddress: '10.0.0.2', forwardedFor: '6.6.6.6, 198.51.100.7', trustedProxies: trusted }), '198.51.100.7');
    assert.equal(resolveClientIp({ peerAddress: '10.0.0.2', forwardedFor: '6.6.6.6, 198.51.100.7, 10.0.0.9', trustedProxies: trusted }), '198.51.100.7');
    assert.equal(resolveClientIp({ peerAddress: '10.0.0.2', forwardedFor: '198.51.100.7, 203.0.113.50', trustedProxies: trusted }), '203.0.113.50');
  });

  it('malformed entries, long chains and missing peers fail closed', () => {
    assert.equal(resolveClientIp({ peerAddress: '10.0.0.2', forwardedFor: 'not-an-ip', trustedProxies: trusted }), '10.0.0.2');
    assert.equal(resolveClientIp({ peerAddress: '10.0.0.2', forwardedFor: Array(40).fill('198.51.100.1').join(','), trustedProxies: trusted }), '10.0.0.2');
    assert.equal(resolveClientIp({ peerAddress: undefined, forwardedFor: '1.2.3.4', trustedProxies: trusted }), null);
  });

  it('header arrays, ports, brackets and IPv4-mapped IPv6 normalize; IPv6 buckets are /64', () => {
    assert.equal(resolveClientIp({ peerAddress: '::ffff:10.0.0.2', forwardedFor: ['6.6.6.6', '198.51.100.7:4433'], trustedProxies: trusted }), '198.51.100.7');
    assert.equal(normalizeIp('[2001:DB8::1]:443'), '2001:db8::1');
    assert.equal(normalizeIp('::ffff:1.2.3.4'), '1.2.3.4');
    assert.equal(normalizeIp('1.2.3.4 ; drop'), null);
    assert.equal(clientIpBucket('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), clientIpBucket('2001:db8:1:2::9'));
    assert.notEqual(clientIpBucket('2001:db8:1:2::9'), clientIpBucket('2001:db8:1:3::9'));
  });
});

describe('S2E - throttle guard primitive (pure)', () => {
  const policy: ThrottlePolicy = {
    ...DEFAULT_THROTTLE_POLICY,
    credential: { pair: { threshold: 3, windowMs: 600_000, baseCooldownMs: 10_000, maxCooldownMs: 60_000 } },
  };
  const subject = { scope: 'credential' as const, ipBucket: '198.51.100.1', account: 'victim@example.invalid' };

  it('arms, escalates, caps and recovers without permanent lockout', () => {
    const g = new AuthAbuseGuard(policy);
    let t = 1_000_000;
    for (let i = 0; i < 3; i += 1) g.hit(subject, t);
    assert.equal(g.check(subject, t + 1).allowed, false);
    t += 10_001;
    assert.equal(g.check(subject, t).allowed, true);
    g.hit(subject, t);
    assert.ok((g.check(subject, t + 1).retryAfterMs ?? 0) > 19_000);
    t += 60_001 + 600_000;
    assert.equal(g.check(subject, t).allowed, true);
  });

  it('a success clears pair/account history but not the IP dimension', () => {
    const g = new AuthAbuseGuard(DEFAULT_THROTTLE_POLICY);
    const t = 9_000_000;
    for (let i = 0; i < 4; i += 1) g.hit(subject, t);
    g.clearAccount(subject);
    for (let i = 0; i < 4; i += 1) g.hit(subject, t);
    assert.equal(g.check(subject, t).allowed, true);
    for (let i = 0; i < 20; i += 1) g.hit({ ...subject, account: `other${i}@example.invalid` }, t);
    assert.equal(g.check({ ...subject, account: 'fresh@example.invalid' }, t).allowed, false);
  });

  it('limiter memory is bounded however many distinct keys arrive', () => {
    const g = new AuthAbuseGuard(DEFAULT_THROTTLE_POLICY, 100, 16);
    for (let i = 0; i < 5000; i += 1) g.hit({ scope: 'credential', ipBucket: `203.0.${i % 250}.${(i >> 4) % 250}`, account: `rot${i}@example.invalid` }, 1_000_000 + i);
    for (const [name, size] of Object.entries(g.sizes())) assert.ok(size <= 100, `${name} holds ${size} buckets`);
  });
});

describe('S2E - current password-auth policy', () => {
  it('all legacy email/password endpoints return 410 and never hash a password', async () => {
    for (const path of PASSWORD_ENDPOINTS) {
      const res = await handleAsyncApiRequest('POST', path, { email: 'user@example.invalid', password: 'Wrong-1!' }, {});
      assert.equal(res.status, 410, path);
      assert.match(JSON.stringify(res.data), /EMAIL_PASSWORD_AUTH_DISABLED/);
    }
    assert.equal(scryptCalls, 0);
  });

  it('disabled password endpoints do not issue recovery or verification tokens', async () => {
    const realCreate = identityTokenStore.createToken.bind(identityTokenStore);
    const issued: string[] = [];
    (identityTokenStore as any).createToken = (type: string, ...rest: unknown[]) => {
      issued.push(type);
      return (realCreate as any)(type, ...rest);
    };
    try {
      for (const path of ['/api/v1/auth/forgot-password', '/api/v1/auth/resend-verification'] as const) {
        const res = await handleAsyncApiRequest('POST', path, { email: 'user@example.invalid' }, {});
        assert.equal(res.status, 410);
      }
    } finally {
      (identityTokenStore as any).createToken = realCreate;
    }
    assert.deepEqual(issued, []);
  });

  it('HTTP requests still resolve client address safely before returning the closed policy response', async () => {
    await serve(async (post) => {
      for (const path of PASSWORD_ENDPOINTS) {
        const res = await post(path, { email: 'user@example.invalid', password: 'Wrong-1!' }, { 'x-test-peer': '10.255.0.1', 'x-forwarded-for': '6.6.6.6, 198.51.100.77' });
        assert.equal(res.status, 410, path);
      }
    }, { trusted: '10.255.0.0/24' });
  });
});

describe('S2E - the test seam cannot exist in production and default routes ignore address headers', () => {
  it('createServerInstance refuses the test peer seam when NODE_ENV is production', () => {
    const before = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      assert.throws(() => createServerInstance({ clientIp: { testPeerAddress: () => '1.2.3.4' } }), /test-only/);
    } finally {
      if (before === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = before;
    }
  });

  it('a route called with a header object the HTTP layer never resolved has no address', async () => {
    const headers = { 'x-forwarded-for': '198.51.100.222', 'content-type': 'application/json' };
    assert.equal(clientIpOf(headers), UNRESOLVED_CLIENT_IP);
    const res = await handleAsyncApiRequest('POST', '/api/v1/auth/login', { email: 'user@example.invalid', password: 'Wrong-1!' }, headers);
    assert.equal(res.status, 410);
    assert.equal(clientIpOf(headers), UNRESOLVED_CLIENT_IP);
  });
});
