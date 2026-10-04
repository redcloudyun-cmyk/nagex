// Security Gate S2E — the trusted client-IP boundary.
//
// THE RULE
//   The authoritative client address is the TCP peer of the connection. `X-Forwarded-For` is consulted ONLY when that
//   peer is an explicitly configured trusted proxy, and is then resolved RIGHT-TO-LEFT through trusted proxy hops: the
//   first address (from the right) that is not a trusted proxy is the client. The leftmost entry is never trusted by
//   position — it is whatever the original sender typed. `CF-Connecting-IP`, `X-Real-IP`, `Forwarded` and every other
//   client-supplied header are never read. A header that cannot be parsed, a chain that is implausibly long, or a
//   configuration that is empty/invalid all fall back to the TCP peer.
//
// WHY A REGISTRY
//   Routes receive a headers object, not the socket. The HTTP layer resolves the address once per request and records it
//   here, keyed by the request's header object (a WeakMap, like the S1 identity registry), so a route can only obtain an
//   address the server itself resolved. A header object that did not come from the HTTP layer has NO address: a route then
//   gets UNRESOLVED_CLIENT_IP and never falls back to reading X-Forwarded-For.
import net from 'node:net';

type HeaderBag = Record<string, string | string[] | undefined>;

// What a route sees when no server-resolved address exists (a direct call, never a network request).
export const UNRESOLVED_CLIENT_IP = 'unresolved';

const MAX_XFF_ENTRIES = 32;

export interface TrustedProxySet {
  readonly size: number;
  has(address: string): boolean;
}

export interface ParsedTrustedProxies extends TrustedProxySet {
  readonly invalidEntries: string[];
}

const EMPTY_PROXIES: ParsedTrustedProxies = { size: 0, has: () => false, invalidEntries: [] };
export { EMPTY_PROXIES as NO_TRUSTED_PROXIES };

// "a.b.c.d", "a.b.c.d/len", "x:y::z", "x:y::z/len" — comma separated. Anything that does not parse is dropped (and
// reported); nothing is ever guessed. An empty or fully invalid list trusts no proxy.
export function parseTrustedProxies(raw: string | undefined | null): ParsedTrustedProxies {
  if (!raw || !raw.trim()) return EMPTY_PROXIES;
  const list = new net.BlockList();
  let size = 0;
  const invalidEntries: string[] = [];
  for (const entryRaw of raw.split(',')) {
    const entry = entryRaw.trim();
    if (!entry) continue;
    const [addrPart, prefixPart, extra] = entry.split('/');
    const address = normalizeIp(addrPart);
    const family = address ? net.isIP(address) : 0;
    if (!address || extra !== undefined || !family) { invalidEntries.push(entry); continue; }
    const max = family === 4 ? 32 : 128;
    if (prefixPart === undefined) {
      list.addAddress(address, family === 4 ? 'ipv4' : 'ipv6');
      size++;
      continue;
    }
    const prefix = /^\d{1,3}$/.test(prefixPart) ? Number(prefixPart) : NaN;
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) { invalidEntries.push(entry); continue; }
    list.addSubnet(address, prefix, family === 4 ? 'ipv4' : 'ipv6');
    size++;
  }
  if (size === 0) return { ...EMPTY_PROXIES, invalidEntries };
  return {
    size,
    invalidEntries,
    has(address: string): boolean {
      const normalized = normalizeIp(address);
      if (!normalized) return false;
      const family = net.isIP(normalized);
      return family ? list.check(normalized, family === 4 ? 'ipv4' : 'ipv6') : false;
    },
  };
}

// Canonical textual form: IPv4-mapped IPv6 collapses to IPv4, an optional port / zone / brackets is removed, IPv6 is
// lower-cased. Returns null for anything that is not an IP address literal.
export function normalizeIp(input: string | undefined | null): string | null {
  if (typeof input !== 'string') return null;
  let value = input.trim();
  if (!value || value.length > 64) return null;
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(value);
  if (bracketed) value = bracketed[1];
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}$/.test(value)) value = value.slice(0, value.lastIndexOf(':'));
  const zone = value.indexOf('%');
  if (zone >= 0) value = value.slice(0, zone);
  const family = net.isIP(value);
  if (!family) return null;
  if (family === 6) {
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value);
    if (mapped && net.isIP(mapped[1]) === 4) return mapped[1];
    return value.toLowerCase();
  }
  return value;
}

function parseForwardedChain(headerValue: string | string[] | undefined): string[] | null {
  if (headerValue === undefined) return [];
  const joined = Array.isArray(headerValue) ? headerValue.join(',') : headerValue;
  if (typeof joined !== 'string' || !joined.trim()) return [];
  const parts = joined.split(',');
  if (parts.length > MAX_XFF_ENTRIES) return null;
  return parts.map((p) => p.trim());
}

export interface ResolveClientIpInput {
  peerAddress: string | undefined | null;
  forwardedFor: string | string[] | undefined;
  trustedProxies: TrustedProxySet;
}

// Pure and total: it never throws and never returns an address the server did not either observe on the socket or receive
// from a trusted proxy hop. Returns null only when there is no usable TCP peer at all.
export function resolveClientIp(input: ResolveClientIpInput): string | null {
  const peer = normalizeIp(input.peerAddress ?? undefined);
  if (!peer) return null;
  if (input.trustedProxies.size === 0 || !input.trustedProxies.has(peer)) return peer;

  const chain = parseForwardedChain(input.forwardedFor);
  if (chain === null) return peer;            // implausibly long chain: do not interpret it
  let candidate = peer;
  for (let i = chain.length - 1; i >= 0; i--) {
    // `candidate` is a trusted proxy here; the entry it reported is the next hop to the left.
    const hop = normalizeIp(chain[i]);
    if (!hop) return peer;                    // a trusted proxy forwarded something that is not an address: no guessing
    candidate = hop;
    if (!input.trustedProxies.has(hop)) return hop;
  }
  return candidate;                           // every hop was a trusted proxy: the original sender is the leftmost address
}

// ─── per-request registry ───────────────────────────────────────────────────
const RESOLVED_CLIENT_IP = new WeakMap<object, string>();

// HTTP layer only. Keyed by the request's header object; canonicalizeRequestHeaders carries it to the canonical copy.
export function attachResolvedClientIp(headers: HeaderBag, address: string): void {
  RESOLVED_CLIENT_IP.set(headers, address);
}

export function carryResolvedClientIp(from: HeaderBag, to: HeaderBag): void {
  const value = RESOLVED_CLIENT_IP.get(from);
  if (value !== undefined) RESOLVED_CLIENT_IP.set(to, value);
}

// The ONLY way a route obtains the caller's address. Never reads a request header.
export function clientIpOf(headers: HeaderBag | undefined): string {
  if (!headers || typeof headers !== 'object') return UNRESOLVED_CLIENT_IP;
  return RESOLVED_CLIENT_IP.get(headers) ?? UNRESOLVED_CLIENT_IP;
}

// A stable rate-limit bucket for an address: an IPv4 address is its own bucket; an IPv6 address is bucketed by its /64 (a
// single subscriber normally controls a whole /64, so per-address buckets would let one host rotate through 2^64 keys).
export function clientIpBucket(address: string): string {
  const normalized = normalizeIp(address);
  if (!normalized) return UNRESOLVED_CLIENT_IP;
  if (net.isIP(normalized) !== 6) return normalized;
  const groups = expandIpv6(normalized);
  return groups ? `${groups.slice(0, 4).join(':')}::/64` : normalized;
}

function expandIpv6(address: string): string[] | null {
  let value = address;
  const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value);
  if (v4) {
    const o = v4[1].split('.').map(Number);
    value = value.slice(0, value.length - v4[1].length) + `${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 0) return null;
  const all = halves.length === 1 ? head : [...head, ...Array(missing).fill('0'), ...tail];
  return all.map((g) => g.padStart(4, '0'));
}
