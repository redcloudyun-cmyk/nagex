// Security Gate S2E — authentication abuse and the trusted client-IP boundary.
//
// Before S2E the client address was the FIRST value of a client-supplied X-Forwarded-For, so every per-address limit could be
// escaped by rotating that header; the account-state password routes (reactivate, delete-cancel) had no limit at all and
// answered a correct password on a wrong-state account differently from a wrong password; and the synchronous scrypt hash ran
// for every attempt. These tests drive the real HTTP server and the real route/guard code, count every scrypt call, and prove:
// the TCP peer is the baseline and X-Forwarded-For counts only through an explicitly trusted proxy (right-to-left, never the
// leftmost entry); rotating the header, the peer, or the account cannot reset the three throttle dimensions; a throttled
// request performs ZERO password hashing; reactivate / delete-cancel share the guess budget and no longer reveal account
// state; throttling is progressive and never permanent; limiter memory is bounded; and audit/session addresses come from the
// trusted resolver. Peers are injected only through the programmatic test seam of createServerInstance.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';
import type http from 'node:http';
import { handleAsyncApiRequest, identityStore, identityTokenStore, identityAuditStore, sessionStore, withTestServer, createServerInstance } from '../src/server_web.js';
import { hashPassword } from '../src/identity/identity.crypto.js';
import { AuthAbuseGuard, DEFAULT_THROTTLE_POLICY, type ThrottlePolicy } from '../src/identity/auth-abuse-guard.js';
import { clientIpBucket, clientIpOf, normalizeIp, parseTrustedProxies, resolveClientIp, UNRESOLVED_CLIENT_IP } from '../src/http/client-ip.js';

const PW = 'S2e-Password-1!';
let counter = 0;
function makeAccount(label: string, state: 'ACTIVE' | 'DISABLED' | 'DELETION_PENDING' = 'ACTIVE') {
  const email = `s2e_${label}_${process.pid}_${++counter}@example.invalid`;
  const { identity } = identityStore.createAccount(email, hashPassword(PW));
  identityStore.transitionState(identity.userId, 'ACTIVE');
  if (state !== 'ACTIVE') identityStore.transitionState(identity.userId, state);
  return { email, userId: identity.userId };
}

// ── scrypt tripwire ──
const realScrypt = nodeCrypto.scryptSync;
let scryptCalls = 0;
beforeEach(() => { scryptCalls = 0; (nodeCrypto as any).scryptSync = (...a: unknown[]) => { scryptCalls++; return (realScrypt as any).apply(nodeCrypto, a); }; });
afterEach(() => { (nodeCrypto as any).scryptSync = realScrypt; });

// ── test server: the ONLY way a test supplies a peer is the programmatic seam, driven here by a header the TEST sets ──
const peerSeam = (req: http.IncomingMessage): string | undefined => (typeof req.headers['x-test-peer'] === 'string' ? (req.headers['x-test-peer'] as string) : undefined);
async function serve(run: (post: Post) => Promise<void>, opts: { trusted?: string; guard?: AuthAbuseGuard } = {}) {
  await withTestServer(async (origin) => {
    const post: Post = (p, body, headers = {}) => fetch(origin + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    await run(post);
  }, { authAbuseGuard: opts.guard ?? new AuthAbuseGuard(), clientIp: { trustedProxies: opts.trusted ?? '', testPeerAddress: peerSeam } });
}
type Post = (path: string, body: unknown, headers?: Record<string, string>) => Promise<Response>;
const LOGIN = '/api/v1/auth/login';
const REACTIVATE = '/api/v1/account/reactivate';
const CANCEL = '/api/v1/account/delete/cancel';
const codeOf = async (r: Response): Promise<string | undefined> => ((await r.json()) as any)?.error?.code;

describe('S2E — trusted client-IP resolver (pure)', () => {
  const trusted = parseTrustedProxies('10.0.0.0/8, 192.168.1.5, ::1, fd00::/8');

  it('with no trusted proxy the TCP peer is the client and X-Forwarded-For is never read', () => {
    const none = parseTrustedProxies(undefined);
    assert.equal(resolveClientIp({ peerAddress: '203.0.113.9', forwardedFor: '1.2.3.4', trustedProxies: none }), '203.0.113.9');
    assert.equal(resolveClientIp({ peerAddress: '127.0.0.1', forwardedFor: '1.2.3.4, 5.6.7.8', trustedProxies: none }), '127.0.0.1');
  });

  it('an untrusted peer cannot make its header authoritative, even if the header names a trusted proxy', () => {
    assert.equal(resolveClientIp({ peerAddress: '203.0.113.9', forwardedFor: '10.0.0.1, 198.51.100.1', trustedProxies: trusted }), '203.0.113.9');
  });

  it('resolves RIGHT-TO-LEFT through trusted hops and never trusts the leftmost entry', () => {
    // client typed 6.6.6.6; the edge proxy (trusted) appended the real sender 198.51.100.7; peer is the trusted proxy 10.0.0.2
    assert.equal(resolveClientIp({ peerAddress: '10.0.0.2', forwardedFor: '6.6.6.6, 198.51.100.7', trustedProxies: trusted }), '198.51.100.7');
    // two trusted hops in front of the real sender
    assert.equal(resolveClientIp({ peerAddress: '10.0.0.2', forwardedFor: '6.6.6.6, 198.51.100.7, 10.0.0.9', trustedProxies: trusted }), '198.51.100.7');
    // only an untrusted entry that is not the rightmost-after-proxy must be skipped: the FIRST untrusted from the right wins
    assert.equal(resolveClientIp({ peerAddress: '10.0.0.2', forwardedFor: '198.51.100.7, 203.0.113.50', trustedProxies: trusted }), '203.0.113.50');
  });

  it('every hop trusted -> the original (leftmost) sender; a trusted peer with no header -> the peer', () => {
    assert.equal(resolveClientIp({ peerAddress: '10.0.0.2', forwardedFor: '10.0.0.7, 10.0.0.8', trustedProxies: trusted }), '10.0.0.7');
    assert.equal(resolveClientIp({ peerAddress: '10.0.0.2', forwardedFor: undefined, trustedProxies: trusted }), '10.0.0.2');
  });

  it('a malformed entry, an implausibly long chain or a missing peer fall back safely (no guessing)', () => {
    assert.equal(resolveClientIp({ peerAddress: '10.0.0.2', forwardedFor: 'not-an-ip', trustedProxies: trusted }), '10.0.0.2');
    assert.equal(resolveClientIp({ peerAddress: '10.0.0.2', forwardedFor: Array(40).fill('198.51.100.1').join(','), trustedProxies: trusted }), '10.0.0.2');
    assert.equal(resolveClientIp({ peerAddress: undefined, forwardedFor: '1.2.3.4', trustedProxies: trusted }), null);
    // garbage typed by the original client, BEHIND a good appended entry, is never examined
    assert.equal(resolveClientIp({ peerAddress: '10.0.0.2', forwardedFor: 'garbage, 198.51.100.7', trustedProxies: trusted }), '198.51.100.7');
  });

  it('header arrays, ports, brackets and IPv4-mapped IPv6 normalize; IPv6 rate-limit buckets are /64', () => {
    assert.equal(resolveClientIp({ peerAddress: '::ffff:10.0.0.2', forwardedFor: ['6.6.6.6', '198.51.100.7:4433'], trustedProxies: trusted }), '198.51.100.7');
    assert.equal(normalizeIp('[2001:DB8::1]:443'), '2001:db8::1');
    assert.equal(normalizeIp('::ffff:1.2.3.4'), '1.2.3.4');
    assert.equal(normalizeIp('1.2.3.4 ; drop'), null);
    assert.equal(clientIpBucket('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), clientIpBucket('2001:db8:1:2::9'));
    assert.notEqual(clientIpBucket('2001:db8:1:2::9'), clientIpBucket('2001:db8:1:3::9'));
    assert.equal(clientIpBucket('198.51.100.7'), '198.51.100.7');
  });

  it('invalid or empty configuration trusts nothing', () => {
    const bad = parseTrustedProxies('nonsense, 10.0.0.0/99, 1.2.3.4/8/8');
    assert.equal(bad.size, 0);
    assert.equal(bad.invalidEntries.length, 3);
    assert.equal(resolveClientIp({ peerAddress: '10.0.0.2', forwardedFor: '198.51.100.7', trustedProxies: bad }), '10.0.0.2');
    assert.equal(parseTrustedProxies('').size, 0);
  });
});

describe('S2E — throttle guard (pure, fake clock)', () => {
  const policy: ThrottlePolicy = {
    ...DEFAULT_THROTTLE_POLICY,
    credential: { pair: { threshold: 3, windowMs: 600_000, baseCooldownMs: 10_000, maxCooldownMs: 60_000 } },
  };
  const subject = { scope: 'credential' as const, ipBucket: '198.51.100.1', account: 'victim@example.invalid' };

  it('arms a short cooldown at the threshold, escalates on each re-arm, caps it, and is never permanent', () => {
    const g = new AuthAbuseGuard(policy);
    let t = 1_000_000;
    for (let i = 0; i < 2; i++) { assert.equal(g.check(subject, t).allowed, true); g.hit(subject, t); }
    assert.equal(g.check(subject, t).allowed, true);
    g.hit(subject, t);                                            // 3rd failure -> cooldown level 0 (10 s)
    let d = g.check(subject, t + 1);
    assert.equal(d.allowed, false); assert.ok(d.retryAfterMs > 9_000 && d.retryAfterMs <= 10_000);
    t += 10_001; assert.equal(g.check(subject, t).allowed, true); // the cooldown ends by itself
    g.hit(subject, t);                                            // next failure re-arms: 20 s
    d = g.check(subject, t + 1); assert.ok(d.retryAfterMs > 19_000 && d.retryAfterMs <= 20_000);
    t += 20_001; g.hit(subject, t);                               // 40 s
    d = g.check(subject, t + 1); assert.ok(d.retryAfterMs > 39_000 && d.retryAfterMs <= 40_000);
    t += 40_001; g.hit(subject, t);                               // capped at 60 s
    d = g.check(subject, t + 1); assert.ok(d.retryAfterMs <= 60_000 && d.retryAfterMs > 59_000);
    t += 60_001; g.hit(subject, t);
    d = g.check(subject, t + 1); assert.ok(d.retryAfterMs <= 60_000, 'never exceeds the cap');
    t += 60_001 + 600_000;                                         // a quiet window clears the history entirely
    assert.equal(g.check(subject, t).allowed, true);
    g.hit(subject, t); g.hit(subject, t);
    assert.equal(g.check(subject, t).allowed, true, 'level reset: two failures are not enough again');
  });

  it('a request refused during a cooldown does not extend it (no free keep-throttled lever)', () => {
    const g = new AuthAbuseGuard(policy);
    const t = 5_000_000;
    for (let i = 0; i < 3; i++) g.hit(subject, t);
    const first = g.check(subject, t + 1).retryAfterMs;
    for (let i = 0; i < 50; i++) g.check(subject, t + 2 + i);
    assert.ok(g.check(subject, t + 100).retryAfterMs <= first);
  });

  it('a success clears the pair and account history but never the ip history', () => {
    const g = new AuthAbuseGuard(DEFAULT_THROTTLE_POLICY);
    const t = 9_000_000;
    for (let i = 0; i < 4; i++) g.hit(subject, t);
    g.clearAccount(subject);
    for (let i = 0; i < 4; i++) g.hit(subject, t);
    assert.equal(g.check(subject, t).allowed, true, 'pair history was cleared, 4 more failures stay below 5');
    for (let i = 0; i < 20; i++) g.hit({ ...subject, account: `other${i}@example.invalid` }, t);
    assert.equal(g.check({ ...subject, account: 'fresh@example.invalid' }, t).allowed, false, 'the ip dimension survived the success');
  });

  it('limiter memory is bounded however many distinct keys arrive', () => {
    const g = new AuthAbuseGuard(DEFAULT_THROTTLE_POLICY, 100, 16);
    for (let i = 0; i < 5000; i++) g.hit({ scope: 'credential', ipBucket: `203.0.${i % 250}.${(i >> 4) % 250}`, account: `rot${i}@example.invalid` }, 1_000_000 + i);
    for (const [name, size] of Object.entries(g.sizes())) assert.ok(size <= 100, `${name} holds ${size} buckets`);
  });
});

describe('S2E — login brute force through the real HTTP server', () => {
  it('forged X-Forwarded-For rotation does NOT escape the limiter (40 rotations -> throttled)', async () => {
    const victim = makeAccount('xff');
    await serve(async (post) => {
      const statuses: number[] = [];
      for (let i = 0; i < 40; i++) statuses.push((await post(LOGIN, { email: victim.email, password: `bad${i}` }, { 'x-test-peer': '198.51.100.10', 'x-forwarded-for': `192.0.2.${50 + i}`, 'cf-connecting-ip': `192.0.2.${100 + i}` })).status);
      assert.ok(statuses.includes(429), `statuses: ${statuses.join(',')}`);
      assert.ok(statuses.filter((s) => s === 401).length <= 10, 'only a handful of guesses are ever verified');
    });
  });

  it('the real TCP peer, not the header, is what the limiter sees when no seam is installed', async () => {
    const victim = makeAccount('realpeer');
    const instance = createServerInstance({ authAbuseGuard: new AuthAbuseGuard(), clientIp: { trustedProxies: '' } });
    await new Promise<void>((r) => instance.listen(0, '127.0.0.1', () => r()));
    const origin = `http://127.0.0.1:${(instance.address() as import('node:net').AddressInfo).port}`;
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 30; i++) statuses.push((await fetch(origin + LOGIN, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `192.0.2.${i + 1}`, 'x-test-peer': `203.0.113.${i + 1}` }, body: JSON.stringify({ email: victim.email, password: `bad${i}` }) })).status);
      assert.ok(statuses.includes(429), 'a production-shaped server ignores X-Forwarded-For and the test header');
    } finally { (instance as any).closeIdleConnections?.(); await new Promise<void>((r) => instance.close(() => r())); }
  });

  it('one account attacked from 40 different peers is blocked by the ACCOUNT dimension', async () => {
    const victim = makeAccount('rotip');
    await serve(async (post) => {
      const statuses: number[] = [];
      for (let i = 0; i < 40; i++) statuses.push((await post(LOGIN, { email: victim.email, password: `bad${i}` }, { 'x-test-peer': `198.51.100.${100 + i}` })).status);
      assert.ok(statuses.includes(429), `statuses: ${statuses.join(',')}`);
      assert.ok(statuses.filter((s) => s === 401).length <= 10, 'at most the account threshold of guesses reaches verification');
    });
  });

  it('one peer rotating through many accounts is blocked by the IP dimension', async () => {
    const accounts = Array.from({ length: 30 }, (_, i) => makeAccount(`ipdim${i}`));
    await serve(async (post) => {
      const statuses: number[] = [];
      for (const a of accounts) statuses.push((await post(LOGIN, { email: a.email, password: 'wrong' }, { 'x-test-peer': '198.51.100.20' })).status);
      assert.ok(statuses.includes(429), `statuses: ${statuses.join(',')}`);
      assert.ok(statuses.filter((s) => s === 401).length <= 20);
    });
  });

  it('forged X-Forwarded-For rotation across many accounts does NOT escape the PER-IP dimension', async () => {
    const accounts = Array.from({ length: 30 }, (_, i) => makeAccount(`xffip${i}`));
    await serve(async (post) => {
      const statuses: number[] = [];
      for (const [i, a] of accounts.entries()) statuses.push((await post(LOGIN, { email: a.email, password: 'wrong' }, { 'x-test-peer': '198.51.100.25', 'x-forwarded-for': `192.0.2.${i + 1}` })).status);
      assert.ok(statuses.includes(429), `statuses: ${statuses.join(',')}`);
      assert.ok(statuses.filter((s) => s === 401).length <= 20, 'the address bucket is the real peer, however the header rotates');
    });
  });

  it('a THROTTLED request performs zero password hashing (login, reactivate, delete-cancel)', async () => {
    const victim = makeAccount('zero');
    await serve(async (post) => {
      const h = { 'x-test-peer': '198.51.100.30' };
      for (let i = 0; i < 6; i++) await post(LOGIN, { email: victim.email, password: `bad${i}` }, h);
      assert.equal((await post(LOGIN, { email: victim.email, password: 'bad-more' }, h)).status, 429);
      scryptCalls = 0;
      for (let i = 0; i < 20; i++) {
        assert.equal((await post(LOGIN, { email: victim.email, password: `x${i}` }, h)).status, 429);
        assert.equal((await post(REACTIVATE, { email: victim.email, password: `x${i}` }, h)).status, 429, 'shared guess budget');
        assert.equal((await post(CANCEL, { email: victim.email, password: `x${i}` }, h)).status, 429, 'shared guess budget');
      }
      assert.equal(scryptCalls, 0);
      const res = await post(LOGIN, { email: victim.email, password: PW }, h);
      assert.equal(res.status, 429, 'even the CORRECT password is not hashed while throttled');
      assert.ok(Number(res.headers.get('retry-after')) >= 1);
      assert.equal(scryptCalls, 0);
    });
  });

  it('throttling is uniform for existing and non-existing accounts (no enumeration through the limiter)', async () => {
    const real = makeAccount('uniform');
    const ghost = `s2e_ghost_${process.pid}@example.invalid`;
    await serve(async (post) => {
      const run = async (email: string, peerBase: number) => { const s: number[] = []; for (let i = 0; i < 12; i++) s.push((await post(LOGIN, { email, password: 'nope' }, { 'x-test-peer': `198.51.100.${peerBase}` })).status); return s; };
      assert.deepEqual(await run(real.email, 41), await run(ghost, 42));
    });
  });

  it('an honest user is unaffected: correct login works, and a success clears the pair history', async () => {
    const user = makeAccount('honest');
    await serve(async (post) => {
      const h = { 'x-test-peer': '198.51.100.50' };
      for (let i = 0; i < 4; i++) assert.equal((await post(LOGIN, { email: user.email, password: 'typo' }, h)).status, 401);
      assert.equal((await post(LOGIN, { email: user.email, password: PW }, h)).status, 200);
      for (let i = 0; i < 4; i++) assert.equal((await post(LOGIN, { email: user.email, password: 'typo' }, h)).status, 401, 'history was cleared by the success');
    });
  });

  it('the throttle is progressive and recovers by itself (no permanent lockout, no victim hard lock)', async () => {
    const victim = makeAccount('recover');
    const guard = new AuthAbuseGuard({ ...DEFAULT_THROTTLE_POLICY, credential: { pair: { threshold: 2, windowMs: 60_000, baseCooldownMs: 300, maxCooldownMs: 600 } } });
    await serve(async (post) => {
      const h = { 'x-test-peer': '198.51.100.60' };
      await post(LOGIN, { email: victim.email, password: 'a' }, h); await post(LOGIN, { email: victim.email, password: 'b' }, h);
      assert.equal((await post(LOGIN, { email: victim.email, password: PW }, h)).status, 429);
      await new Promise((r) => setTimeout(r, 450));
      assert.equal((await post(LOGIN, { email: victim.email, password: PW }, h)).status, 200, 'the owner signs in once the short cooldown has passed');
    }, { guard });
  });
});

describe('S2E — reactivate and delete-cancel', () => {
  it('60 wrong guesses reach 429 (they were unlimited before S2E) and are verified at most a handful of times', async () => {
    const a = makeAccount('rc60', 'DISABLED');
    const b = makeAccount('dc60', 'DELETION_PENDING');
    await serve(async (post) => {
      for (const [path, acct] of [[REACTIVATE, a], [CANCEL, b]] as const) {
        const statuses: number[] = [];
        for (let i = 0; i < 60; i++) statuses.push((await post(path, { email: acct.email, password: `g${i}` }, { 'x-test-peer': '198.51.100.70' })).status);
        assert.ok(statuses.includes(429), `${path}: ${statuses.join(',')}`);
        assert.ok(statuses.filter((s) => s === 401).length <= 10);
      }
    });
  });

  it('they answer a wrong password and a CORRECT password on a wrong-state account identically (no state oracle)', async () => {
    const active = makeAccount('oracle_active', 'ACTIVE');
    await serve(async (post) => {
      for (const path of [REACTIVATE, CANCEL]) {
        const wrong = await post(path, { email: active.email, password: 'wrong' }, { 'x-test-peer': '198.51.100.80' });
        const correctWrongState = await post(path, { email: active.email, password: PW }, { 'x-test-peer': '198.51.100.81' });
        const unknown = await post(path, { email: `nobody_${process.pid}@example.invalid`, password: PW }, { 'x-test-peer': '198.51.100.82' });
        assert.equal(wrong.status, 401); assert.equal(correctWrongState.status, 401); assert.equal(unknown.status, 401);
        const bodies = await Promise.all([wrong, correctWrongState, unknown].map((r) => r.json()));
        assert.deepEqual(bodies[1], bodies[0]);
        assert.deepEqual(bodies[2], bodies[0]);
      }
      assert.equal(identityStore.getByEmail(active.email)!.accountState, 'ACTIVE', 'and nothing changed');
    });
  });

  it('a correct password on a wrong-state account still counts as a failed guess', async () => {
    const active = makeAccount('oracle_count', 'ACTIVE');
    await serve(async (post) => {
      const statuses: number[] = [];
      for (let i = 0; i < 12; i++) statuses.push((await post(REACTIVATE, { email: active.email, password: PW }, { 'x-test-peer': '198.51.100.85' })).status);
      assert.ok(statuses.includes(429), statuses.join(','));
    });
  });

  it('the legitimate flows still work (disabled -> reactivate, deletion pending -> cancel)', async () => {
    const d = makeAccount('legit_rc', 'DISABLED');
    const p = makeAccount('legit_dc', 'DELETION_PENDING');
    await serve(async (post) => {
      assert.equal((await post(REACTIVATE, { email: d.email, password: PW }, { 'x-test-peer': '198.51.100.90' })).status, 200);
      assert.equal(identityStore.getByEmail(d.email)!.accountState, 'ACTIVE');
      assert.equal((await post(CANCEL, { email: p.email, password: PW }, { 'x-test-peer': '198.51.100.91' })).status, 200);
      assert.equal(identityStore.getByEmail(p.email)!.accountState, 'ACTIVE');
    });
  });

  it('malformed bodies are refused before hashing', async () => {
    await serve(async (post) => {
      scryptCalls = 0;
      for (const body of [{}, { email: 5, password: 'x' }, { email: 'a@b.c', password: { $ne: 1 } }]) {
        assert.equal((await post(REACTIVATE, body, { 'x-test-peer': '198.51.100.95' })).status, 400);
        assert.equal((await post(CANCEL, body, { 'x-test-peer': '198.51.100.95' })).status, 400);
      }
      assert.equal(scryptCalls, 0);
    });
  });
});

describe('S2E — trusted proxy configuration through the real HTTP server', () => {
  it('behind a TRUSTED proxy the client is the first untrusted address from the right; rotating the typed header changes nothing', async () => {
    const victim = makeAccount('trusted');
    await serve(async (post) => {
      // the proxy (peer 10.255.0.1) appends the real sender 198.51.100.200; everything left of it is typed by the attacker
      const statuses: number[] = [];
      for (let i = 0; i < 30; i++) statuses.push((await post(LOGIN, { email: victim.email, password: `bad${i}` }, { 'x-test-peer': '10.255.0.1', 'x-forwarded-for': `6.6.${i}.1, 198.51.100.200` })).status);
      assert.ok(statuses.includes(429), statuses.join(','));
      // a different real sender behind the same proxy is a different client (the IP/pair dimensions are per sender, not per proxy)
      const other = makeAccount('trusted_other');
      assert.equal((await post(LOGIN, { email: other.email, password: PW }, { 'x-test-peer': '10.255.0.1', 'x-forwarded-for': '198.51.100.201' })).status, 200);
    }, { trusted: '10.255.0.0/24' });
  });

  it('audit and session addresses come from the trusted resolver, not from the header', async () => {
    const withProxy = makeAccount('audit_trusted');
    const noProxy = makeAccount('audit_untrusted');
    await serve(async (post) => {
      assert.equal((await post(LOGIN, { email: withProxy.email, password: PW }, { 'x-test-peer': '10.255.0.1', 'x-forwarded-for': '6.6.6.6, 198.51.100.77' })).status, 200);
    }, { trusted: '10.255.0.0/24' });
    await serve(async (post) => {
      assert.equal((await post(LOGIN, { email: noProxy.email, password: PW }, { 'x-test-peer': '198.51.100.78', 'x-forwarded-for': '6.6.6.6', 'cf-connecting-ip': '7.7.7.7' })).status, 200);
    });
    const ipOf = (userId: string) => identityAuditStore.listForUser(userId).filter((e) => e.eventType === 'login.succeeded').map((e) => e.ip);
    assert.deepEqual(ipOf(withProxy.userId), ['198.51.100.77']);
    assert.deepEqual(ipOf(noProxy.userId), ['198.51.100.78']);
    assert.deepEqual(sessionStore.listUserSessions(`ten_${withProxy.userId}`, withProxy.userId).map((s) => s.ipAddress), ['198.51.100.77']);
    assert.deepEqual(sessionStore.listUserSessions(`ten_${noProxy.userId}`, noProxy.userId).map((s) => s.ipAddress), ['198.51.100.78']);
  });

  it('CF-Connecting-IP is never an address source, even through a trusted proxy', async () => {
    const victim = makeAccount('cf');
    await serve(async (post) => {
      const statuses: number[] = [];
      for (let i = 0; i < 30; i++) statuses.push((await post(LOGIN, { email: victim.email, password: `bad${i}` }, { 'x-test-peer': '10.255.0.1', 'x-forwarded-for': '198.51.100.210', 'cf-connecting-ip': `7.7.7.${i + 1}` })).status);
      assert.ok(statuses.includes(429), statuses.join(','));
    }, { trusted: '10.255.0.0/24' });
  });
});

describe('S2E — signup, forgot-password and resend-verification use the same resolver and guard', () => {
  it('signup: header rotation does not escape the per-IP limit; a different real peer is unaffected', async () => {
    await serve(async (post) => {
      const body = (i: number) => ({ email: `s2e_su_${process.pid}_${i}_${Date.now()}@example.invalid`, password: PW, passwordConfirmation: PW, termsAccepted: true, privacyAccepted: true });
      const statuses: number[] = [];
      for (let i = 0; i < 10; i++) statuses.push((await post('/api/v1/auth/signup', body(i), { 'x-test-peer': '198.51.100.120', 'x-forwarded-for': `192.0.2.${i + 1}` })).status);
      assert.ok(statuses.includes(429), statuses.join(','));
      assert.equal(statuses.filter((s) => s === 201).length, 5);
      assert.equal((await post('/api/v1/auth/signup', body(99), { 'x-test-peer': '198.51.100.121' })).status, 201);
      scryptCalls = 0;
      assert.equal((await post('/api/v1/auth/signup', body(100), { 'x-test-peer': '198.51.100.120' })).status, 429);
      assert.equal(scryptCalls, 0, 'a throttled signup is refused before it hashes the password');
    });
  });

  it('forgot-password and resend-verification stay indistinguishable when throttled, and a throttled request issues no token', async () => {
    const active = makeAccount('forgot');
    const pendingEmail = `s2e_pending_${process.pid}_${++counter}@example.invalid`;
    identityStore.createAccount(pendingEmail, hashPassword(PW));              // stays PENDING_VERIFICATION
    const realCreate = identityTokenStore.createToken.bind(identityTokenStore);
    const issued: string[] = [];
    (identityTokenStore as any).createToken = (type: string, ...rest: unknown[]) => { issued.push(type); return (realCreate as any)(type, ...rest); };
    try {
      await serve(async (post) => {
        const h = { 'x-test-peer': '198.51.100.130' };
        const forgot: string[] = []; const resend: string[] = [];
        for (let i = 0; i < 8; i++) {
          const f = await post('/api/v1/auth/forgot-password', { email: active.email }, h);
          const r = await post('/api/v1/auth/resend-verification', { email: pendingEmail }, { 'x-test-peer': '198.51.100.131' });
          assert.equal(f.status, 200); assert.equal(r.status, 200);
          forgot.push(JSON.stringify(await f.json())); resend.push(JSON.stringify(await r.json()));
        }
        assert.equal(new Set(forgot).size, 1, 'same acknowledgement every time');
        assert.equal(new Set(resend).size, 1);
      });
    } finally { (identityTokenStore as any).createToken = realCreate; }
    assert.equal(issued.filter((t) => t === 'PASSWORD_RESET').length, 5, 'only the first 5 forgot requests per address+account issue a token');
    assert.equal(issued.filter((t) => t === 'EMAIL_VERIFY').length, 5, 'only the first 5 resend requests per address+account issue a token');
  });
});

describe('S2E — the test seam cannot exist in production and the default server ignores it', () => {
  it('createServerInstance refuses the test peer seam when NODE_ENV is production', () => {
    const before = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try { assert.throws(() => createServerInstance({ clientIp: { testPeerAddress: () => '1.2.3.4' } }), /test-only/); }
    finally { if (before === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = before; }
  });

  it('a normal server (no seam) is not influenced by an x-test-peer header', async () => {
    const victim = makeAccount('noseam');
    const instance = createServerInstance({ authAbuseGuard: new AuthAbuseGuard() });
    await new Promise<void>((r) => instance.listen(0, '127.0.0.1', () => r()));
    const origin = `http://127.0.0.1:${(instance.address() as import('node:net').AddressInfo).port}`;
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 20; i++) statuses.push((await fetch(origin + LOGIN, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-peer': `203.0.113.${i + 1}` }, body: JSON.stringify({ email: victim.email, password: `bad${i}` }) })).status);
      assert.ok(statuses.includes(429), 'the header changed nothing: every request came from the same real peer');
    } finally { (instance as any).closeIdleConnections?.(); await new Promise<void>((r) => instance.close(() => r())); }
  });

  it('a route called with a header object the HTTP layer never resolved has NO address (never reads X-Forwarded-For)', async () => {
    const user = makeAccount('direct');
    const guard = new AuthAbuseGuard();
    const headers = { 'x-forwarded-for': '198.51.100.222', 'content-type': 'application/json' };
    assert.equal(clientIpOf(headers), UNRESOLVED_CLIENT_IP);
    const res = await handleAsyncApiRequest('POST', LOGIN, { email: user.email, password: PW }, headers, undefined, {}, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { authAbuseGuard: guard });
    assert.equal(res.status, 200);
    assert.deepEqual(identityAuditStore.listForUser(user.userId).filter((e) => e.eventType === 'login.succeeded').map((e) => e.ip), [UNRESOLVED_CLIENT_IP]);
  });
});
