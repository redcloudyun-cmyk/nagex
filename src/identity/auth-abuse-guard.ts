// Security Gate S2E — authentication abuse throttling (replaces the single-key IdentityRateLimiter).
//
// WHAT IT PROTECTS
//   Unauthenticated routes that verify a password (login, reactivate, delete-cancel) or create/probe accounts (signup,
//   forgot-password, resend-verification). The password hash is synchronous scrypt, so an unthrottled caller is both a
//   password-guessing oracle and a way to stall the single event-loop thread.
//
// MODEL — progressive throttling, never a lockout
//   Each protected scope has up to three DIMENSIONS, each a bucket of recent hits:
//     ip       broad abuse from one address across many accounts            (key: IP bucket)
//     account  guessing one account's password from rotating addresses      (key: digest of the normalized email)
//     pair     focused brute force of one account from one address          (key: IP bucket + account digest)
//   A bucket that reaches its threshold within the window starts a COOLDOWN (429 + Retry-After). Every further hit after a
//   cooldown re-arms it with a longer one (base × 2^level, capped). Cooldowns are short and never permanent: after the
//   cap is reached the caller simply waits at most that long, and a quiet window clears the history entirely. A request
//   that arrives during a cooldown is refused BEFORE any password hashing and does not extend the cooldown (otherwise a
//   caller could keep a victim throttled for free).
//
//   The password-guess scope is SHARED by login, reactivate and delete-cancel: they all test the same secret, so three
//   separate budgets would triple an attacker's guesses.
//
// MEMORY
//   Every bucket map is bounded. Expired buckets are dropped opportunistically; at the cap the oldest bucket is evicted. A
//   key is a short digest or a normalized address, never an attacker-sized string.
import crypto from 'node:crypto';

export type ThrottleDimension = 'ip' | 'account' | 'pair';

export interface DimensionPolicy {
  threshold: number;       // hits within windowMs that arm a cooldown
  windowMs: number;
  baseCooldownMs: number;  // first cooldown; doubles for every further hit after a cooldown
  maxCooldownMs: number;
}

export interface ScopePolicy {
  ip?: DimensionPolicy;
  account?: DimensionPolicy;
  pair?: DimensionPolicy;
}

export type ThrottleScope = 'credential' | 'signup' | 'forgot' | 'resend';

export type ThrottlePolicy = Record<ThrottleScope, ScopePolicy>;

const MIN = 60 * 1000;

// Defaults. Chosen so an honest user (typos, a shared office NAT, a forgotten password) is never throttled in practice,
// while an attacker is held to a handful of guesses per minute per account regardless of how many addresses they own.
export const DEFAULT_THROTTLE_POLICY: ThrottlePolicy = {
  credential: {
    pair: { threshold: 5, windowMs: 15 * MIN, baseCooldownMs: 30 * 1000, maxCooldownMs: 15 * MIN },
    account: { threshold: 10, windowMs: 15 * MIN, baseCooldownMs: 15 * 1000, maxCooldownMs: 5 * MIN },
    ip: { threshold: 20, windowMs: 15 * MIN, baseCooldownMs: 30 * 1000, maxCooldownMs: 15 * MIN },
  },
  signup: {
    ip: { threshold: 5, windowMs: 15 * MIN, baseCooldownMs: 60 * 1000, maxCooldownMs: 15 * MIN },
  },
  forgot: {
    pair: { threshold: 5, windowMs: 15 * MIN, baseCooldownMs: 60 * 1000, maxCooldownMs: 15 * MIN },
    account: { threshold: 10, windowMs: 15 * MIN, baseCooldownMs: 30 * 1000, maxCooldownMs: 5 * MIN },
    ip: { threshold: 20, windowMs: 15 * MIN, baseCooldownMs: 60 * 1000, maxCooldownMs: 15 * MIN },
  },
  resend: {
    pair: { threshold: 5, windowMs: 15 * MIN, baseCooldownMs: 60 * 1000, maxCooldownMs: 15 * MIN },
    account: { threshold: 10, windowMs: 15 * MIN, baseCooldownMs: 30 * 1000, maxCooldownMs: 5 * MIN },
    ip: { threshold: 20, windowMs: 15 * MIN, baseCooldownMs: 60 * 1000, maxCooldownMs: 15 * MIN },
  },
};

interface Bucket {
  hits: number[];          // the most recent `threshold` hit times inside the window
  level: number;           // how many cooldowns this bucket has armed since it last went quiet
  blockedUntil: number;
}

export interface ThrottleDecision {
  allowed: boolean;
  retryAfterMs: number;
}

export interface ThrottleSubject {
  scope: ThrottleScope;
  ipBucket: string;
  /** Raw account identifier (email). Normalized and digested here; omitted when the request has none. */
  account?: unknown;
}

const MAX_ACCOUNT_INPUT = 320;

export class AuthAbuseGuard {
  private readonly buckets = new Map<string, Map<string, Bucket>>();
  private operations = 0;

  constructor(
    private readonly policy: ThrottlePolicy = DEFAULT_THROTTLE_POLICY,
    private readonly maxBucketsPerDimension = 20_000,
    private readonly sweepEvery = 256
  ) {}

  /** Refuses (and does nothing else) while any applicable dimension is cooling down. Call BEFORE any password hashing. */
  public check(subject: ThrottleSubject, nowMs = Date.now()): ThrottleDecision {
    let retryAfterMs = 0;
    for (const ref of this.refs(subject)) {
      const bucket = this.map(ref.name).get(ref.key);
      if (bucket && bucket.blockedUntil > nowMs) retryAfterMs = Math.max(retryAfterMs, bucket.blockedUntil - nowMs);
    }
    return { allowed: retryAfterMs === 0, retryAfterMs };
  }

  /** Counts one hit (a failed password check, or an attempt) on every applicable dimension. */
  public hit(subject: ThrottleSubject, nowMs = Date.now()): void {
    this.maybeSweep(nowMs);
    for (const ref of this.refs(subject)) {
      const map = this.map(ref.name);
      const policy = ref.policy;
      let bucket = map.get(ref.key);
      if (bucket) {
        bucket.hits = bucket.hits.filter((t) => nowMs - t < policy.windowMs);
        if (bucket.hits.length === 0) bucket = undefined;
      }
      if (!bucket) {
        if (map.size >= this.maxBucketsPerDimension) this.makeRoom(map, nowMs);
        bucket = { hits: [], level: 0, blockedUntil: 0 };
        map.set(ref.key, bucket);
      }
      bucket.hits.push(nowMs);
      if (bucket.hits.length > policy.threshold) bucket.hits.splice(0, bucket.hits.length - policy.threshold);
      if (bucket.hits.length >= policy.threshold && bucket.blockedUntil <= nowMs) {
        bucket.blockedUntil = nowMs + Math.min(policy.baseCooldownMs * 2 ** bucket.level, policy.maxCooldownMs);
        bucket.level = Math.min(bucket.level + 1, 30);
      }
    }
  }

  /** The account proved itself: its pair and account history are cleared. The ip dimension is never cleared by a success. */
  public clearAccount(subject: ThrottleSubject): void {
    for (const ref of this.refs(subject)) {
      if (ref.dimension !== 'ip') this.map(ref.name).delete(ref.key);
    }
  }

  /** Test/diagnostic: number of live buckets per dimension map. */
  public sizes(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [name, map] of this.buckets) out[name] = map.size;
    return out;
  }

  private refs(subject: ThrottleSubject): Array<{ name: string; dimension: ThrottleDimension; key: string; policy: DimensionPolicy }> {
    const scopePolicy = this.policy[subject.scope];
    const accountDigest = accountDigestOf(subject.account);
    const out: Array<{ name: string; dimension: ThrottleDimension; key: string; policy: DimensionPolicy }> = [];
    // `credential` is one shared password-guess budget; every other scope has its own.
    const name = (d: ThrottleDimension) => `${subject.scope}.${d}`;
    if (scopePolicy.ip) out.push({ name: name('ip'), dimension: 'ip', key: subject.ipBucket, policy: scopePolicy.ip });
    if (accountDigest) {
      if (scopePolicy.account) out.push({ name: name('account'), dimension: 'account', key: accountDigest, policy: scopePolicy.account });
      if (scopePolicy.pair) out.push({ name: name('pair'), dimension: 'pair', key: `${subject.ipBucket}|${accountDigest}`, policy: scopePolicy.pair });
    }
    return out;
  }

  private map(name: string): Map<string, Bucket> {
    let m = this.buckets.get(name);
    if (!m) { m = new Map(); this.buckets.set(name, m); }
    return m;
  }

  private maybeSweep(nowMs: number): void {
    if (++this.operations % this.sweepEvery !== 0) return;
    for (const [name, map] of this.buckets) {
      const [scope, dim] = name.split('.') as [ThrottleScope, ThrottleDimension];
      const policy = this.policy[scope][dim];
      if (!policy) continue;
      for (const [key, bucket] of map) {
        if (bucket.blockedUntil <= nowMs && bucket.hits.every((t) => nowMs - t >= policy.windowMs)) map.delete(key);
      }
    }
  }

  private makeRoom(map: Map<string, Bucket>, nowMs: number): void {
    for (const [key, bucket] of map) {
      if (bucket.blockedUntil <= nowMs && bucket.hits.length > 0 && nowMs - bucket.hits[bucket.hits.length - 1] >= 60 * 1000) map.delete(key);
      if (map.size < this.maxBucketsPerDimension) return;
    }
    // Still full of recent buckets: evict the oldest insertion so memory stays bounded.
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }
}

export function accountDigestOf(account: unknown): string | null {
  if (typeof account !== 'string') return null;
  const normalized = account.trim().toLowerCase().slice(0, MAX_ACCOUNT_INPUT);
  if (!normalized) return null;
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 32);
}
