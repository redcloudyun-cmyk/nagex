// Security Gate S2B — proof that a signed-in NAgex principal controls an external channel identity.
//
// A Telegram / Slack user id supplied by a client proves nothing: anyone can type any id. Ownership is proven by the
// channel itself. The signed-in principal asks the server for a one-time challenge; the person then sends that
// challenge to the NAgex bot FROM the channel account they are linking; the (S2A-authenticated) webhook derives the
// sender identity from the platform's own data and only then is the identity bound to the principal that issued the
// challenge. The browser never names the external identity, the principal or the tenant of a link.
//
// A challenge is: server-generated (crypto RNG), short-lived, single-use, and bound to the issuing principal, its
// tenant, the integration it was issued for and one operation (linking). It is stored only as a SHA-256 digest.
// Storage is PROCESS-LOCAL and in memory: a challenge does not survive a restart and is not shared between server
// processes (a user simply asks for a new one). consume() is synchronous, so a single process can never let two
// concurrent webhook requests both consume the same challenge.
import crypto from 'node:crypto';

export type ChannelIntegration = 'telegram' | 'slack';
export type ChannelLinkOperation = 'LINK_CHANNEL_IDENTITY';

export const CHANNEL_LINK_TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 5000;
// Crockford base32 without the characters people misread (no I, L, O, U): 12 symbols = 60 bits of entropy.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TOKEN_SHAPE = /^[0-9A-Za-z]{4}-[0-9A-Za-z]{4}-[0-9A-Za-z]{4}$/;

export type ChallengeRejection = 'UNKNOWN' | 'EXPIRED' | 'CONSUMED' | 'WRONG_INTEGRATION';

export type ConsumeResult =
  | { ok: true; principalId: string; tenantId: string; operation: ChannelLinkOperation }
  | { ok: false; reason: ChallengeRejection };

interface ChallengeRecord {
  integration: ChannelIntegration;
  principalId: string;
  tenantId: string;
  operation: ChannelLinkOperation;
  expiresAt: number;
  consumed: boolean;
}

export interface ChannelLinkChallengeStoreOptions {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

export function normalizeChallengeToken(raw: string): string | null {
  const trimmed = raw.trim();
  if (!TOKEN_SHAPE.test(trimmed)) return null;
  // map the characters people confuse onto the alphabet, then validate
  const normalized = trimmed.toUpperCase().replace(/-/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return [...normalized].every((c) => ALPHABET.includes(c)) ? normalized : null;
}

const digest = (normalized: string): string => crypto.createHash('sha256').update('nagex-channel-link-v1:').update(normalized).digest('hex');

export class ChannelLinkChallengeStore {
  private readonly records = new Map<string, ChallengeRecord>();
  // principal+integration → digest of its currently outstanding challenge (a new request replaces the old one)
  private readonly outstanding = new Map<string, string>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: ChannelLinkChallengeStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? CHANNEL_LINK_TTL_MS;
    this.maxEntries = options.maxEntries ?? MAX_ENTRIES;
    this.now = options.now ?? Date.now;
  }

  // The plaintext token is returned ONCE, to the authenticated caller who asked for it, and is never stored or logged.
  public issue(integration: ChannelIntegration, principalId: string, tenantId: string): { token: string; expiresAt: string; ttlSeconds: number } {
    this.sweep();
    const ownerKey = `${integration}\u0000${tenantId}\u0000${principalId}`;
    const previous = this.outstanding.get(ownerKey);
    if (previous) this.records.delete(previous);

    const bytes = crypto.randomBytes(12);
    const symbols = [...bytes].map((b) => ALPHABET[b % 32]);   // 32 divides 256 → no modulo bias
    const normalized = symbols.join('');
    const key = digest(normalized);
    const expiresAt = this.now() + this.ttlMs;
    while (this.records.size >= this.maxEntries) {
      const oldest = this.records.keys().next().value;
      if (oldest === undefined) break;
      this.records.delete(oldest);
    }
    this.records.set(key, { integration, principalId, tenantId, operation: 'LINK_CHANNEL_IDENTITY', expiresAt, consumed: false });
    this.outstanding.set(ownerKey, key);
    return { token: `${normalized.slice(0, 4)}-${normalized.slice(4, 8)}-${normalized.slice(8, 12)}`, expiresAt: new Date(expiresAt).toISOString(), ttlSeconds: Math.floor(this.ttlMs / 1000) };
  }

  // Validates AND consumes in one synchronous step (no await between check and mark), so one challenge can be
  // spent at most once even when two webhook requests arrive together. A challenge presented for the wrong integration
  // is refused without being spent (its holder presented it to the wrong bot).
  public consume(integration: ChannelIntegration, rawToken: string): ConsumeResult {
    const normalized = normalizeChallengeToken(rawToken);
    if (!normalized) return { ok: false, reason: 'UNKNOWN' };
    const key = digest(normalized);
    const record = this.records.get(key);
    if (!record) return { ok: false, reason: 'UNKNOWN' };
    if (record.integration !== integration) return { ok: false, reason: 'WRONG_INTEGRATION' };
    if (record.consumed) return { ok: false, reason: 'CONSUMED' };
    if (record.expiresAt <= this.now()) {
      this.records.delete(key);
      return { ok: false, reason: 'EXPIRED' };
    }
    record.consumed = true;
    return { ok: true, principalId: record.principalId, tenantId: record.tenantId, operation: record.operation };
  }

  public size(): number {
    return this.records.size;
  }

  private sweep(): void {
    const t = this.now();
    for (const [key, record] of this.records) {
      if (record.expiresAt <= t) this.records.delete(key);
    }
    for (const [ownerKey, key] of this.outstanding) {
      if (!this.records.has(key)) this.outstanding.delete(ownerKey);
    }
  }
}

// ── the channel-side command ──
// Telegram: "/start ABCD-EFGH-JKMN" (the deep-link form t.me/<bot>?start=<code>) or "/link ABCD-EFGH-JKMN"
// Slack:    "link ABCD-EFGH-JKMN" sent to the bot in a direct message
// The strict hyphenated shape keeps ordinary chat such as "link calendar" from being treated as a link attempt.
const TELEGRAM_COMMAND = /^\/(?:start|link)(?:@[A-Za-z0-9_]+)?\s+([0-9A-Za-z]{4}-[0-9A-Za-z]{4}-[0-9A-Za-z]{4})(?:\s+([\s\S]*))?$/;
const SLACK_COMMAND = /^link\s+([0-9A-Za-z]{4}-[0-9A-Za-z]{4}-[0-9A-Za-z]{4})(?:\s+([\s\S]*))?$/i;

// `trailing` is anything after the code. A well-formed command carries none; a message that has a code in command position
// but extra text is still a link ATTEMPT (so the code is never stored as chat) and is refused as malformed.
export function parseChannelLinkCommand(integration: ChannelIntegration, text: string): { code: string; trailing: string } | null {
  const m = (integration === 'telegram' ? TELEGRAM_COMMAND : SLACK_COMMAND).exec(text.trim());
  return m ? { code: m[1], trailing: (m[2] ?? '').trim() } : null;
}
