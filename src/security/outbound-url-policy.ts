import dns from 'node:dns/promises';
import { isIPv4, isIPv6 } from 'node:net';
import { URL } from 'node:url';

export type OutboundDnsResolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

export interface OutboundUrlValidation {
  normalizedUrl: string;
  parsedUrl: URL;
  hostname: string;
  resolvedPublicIp: string;
  addressFamily: 4 | 6;
}

// Why a destination was refused. The messages are the ones callers and tests have always seen; the code is the stable, machine-readable class.
export type OutboundPolicyCode =
  | 'OUTBOUND_UNSUPPORTED_PROTOCOL'
  | 'OUTBOUND_EMBEDDED_CREDENTIALS'
  | 'OUTBOUND_LOCAL_HOSTNAME'
  | 'OUTBOUND_PRIVATE_IPV4'
  | 'OUTBOUND_PRIVATE_IPV6'
  | 'OUTBOUND_RESOLVED_PRIVATE'
  | 'OUTBOUND_NO_ADDRESSES'
  | 'OUTBOUND_DNS_REBINDING';

export class OutboundPolicyError extends Error {
  public readonly code: OutboundPolicyCode;
  constructor(code: OutboundPolicyCode, message: string) {
    super(message);
    this.name = 'OutboundPolicyError';
    this.code = code;
  }
}

function ipToLong(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + Number.parseInt(octet, 10), 0) >>> 0;
}

// Everything a user-supplied URL must never reach over IPv4: private, loopback, link-local, "this network", shared (carrier-grade NAT, which also hosts some cloud metadata endpoints),
// IETF protocol assignments, benchmarking, multicast and the reserved/broadcast block.
const BLOCKED_IPV4_RANGES = [
  ['0.0.0.0', '0.255.255.255'], ['10.0.0.0', '10.255.255.255'], ['100.64.0.0', '100.127.255.255'], ['127.0.0.0', '127.255.255.255'], ['169.254.0.0', '169.254.255.255'],
  ['172.16.0.0', '172.31.255.255'], ['192.0.0.0', '192.0.0.255'], ['192.168.0.0', '192.168.255.255'], ['198.18.0.0', '198.19.255.255'], ['224.0.0.0', '255.255.255.255'],
].map(([start, end]) => ({ start: ipToLong(start), end: ipToLong(end) }));

export function isPrivateIPv4(ip: string): boolean {
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip)) return false;
  const parts = ip.split('.').map((p) => Number.parseInt(p, 10));
  if (parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false;
  const longIp = ipToLong(ip);
  return BLOCKED_IPV4_RANGES.some((range) => longIp >= range.start && longIp <= range.end);
}

// ---- IPv6 -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// WHATWG `URL.hostname` keeps the brackets of an IPv6 literal ("[::1]") and rewrites "::ffff:127.0.0.1" to "[::ffff:7f00:1]". node:net `isIPv6` accepts neither bracketed text nor a zone
// the way a URL spells them, so a literal used to fall through to a DNS lookup of the bracketed string: Windows resolved it (and the lookup result was screened), Linux answered ENOTFOUND (so
// it was refused only by accident). A literal address must be judged as an address - before, and never instead of, any DNS lookup.

// Strips one pair of brackets and a zone id ("fe80::1%eth0"); the zone only says which interface and never changes which address is meant.
function bareIPv6(text: string): string {
  let t = text.trim().toLowerCase();
  if (t.startsWith('[') && t.endsWith(']')) t = t.slice(1, -1);
  const zone = t.indexOf('%');
  if (zone >= 0) t = t.slice(0, zone);
  return t;
}

// The 16 bytes of an IPv6 address in any textual form (compressed, full, with an embedded dotted IPv4 tail, upper case, brackets), or null if it is not an IPv6 address.
export function parseIPv6(text: string): Uint8Array | null {
  const t = bareIPv6(text);
  if (!isIPv6(t)) return null;
  const halves = t.split('::');
  if (halves.length > 2) return null;
  const groupsOf = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    const pieces = part.split(':');
    for (let i = 0; i < pieces.length; i += 1) {
      const piece = pieces[i];
      if (piece.includes('.')) {
        if (i !== pieces.length - 1 || !isIPv4(piece)) return null;
        const o = piece.split('.').map((x) => Number.parseInt(x, 10));
        out.push((o[0] << 8) | o[1], (o[2] << 8) | o[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(piece)) return null;
        out.push(Number.parseInt(piece, 16));
      }
    }
    return out;
  };
  const head = groupsOf(halves[0]);
  const tail = halves.length === 2 ? groupsOf(halves[1]) : [];
  if (!head || !tail) return null;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;
  const groups = halves.length === 1 ? head : [...head, ...new Array(missing).fill(0), ...tail];
  const bytes = new Uint8Array(16);
  groups.forEach((g, i) => { bytes[2 * i] = g >> 8; bytes[2 * i + 1] = g & 255; });
  return bytes;
}

const dotted = (b: Uint8Array, at: number): string => `${b[at]}.${b[at + 1]}.${b[at + 2]}.${b[at + 3]}`;
const zeros = (b: Uint8Array, from: number, to: number): boolean => { for (let i = from; i < to; i += 1) if (b[i] !== 0) return false; return true; };

// Why an IPv6 address is not a public destination, or null when it is global unicast outside every special-purpose range. Deny by default: only 2000::/3 can pass.
export function classifyIPv6(address: string): string | null {
  const b = parseIPv6(address);
  if (!b) return 'not a valid IPv6 address';
  if (zeros(b, 0, 16)) return 'unspecified address';
  if (zeros(b, 0, 15) && b[15] === 1) return 'loopback';
  // IPv4-mapped (::ffff:a.b.c.d): judged by the embedded IPv4 address, in whatever form it was written
  if (zeros(b, 0, 10) && b[10] === 0xff && b[11] === 0xff) return isPrivateIPv4(dotted(b, 12)) ? `IPv4-mapped ${dotted(b, 12)}` : null;
  // deprecated IPv4-compatible (::a.b.c.d) - no legitimate use
  if (zeros(b, 0, 12)) return 'IPv4-compatible address';
  // NAT64 well-known prefix 64:ff9b::/96 carries an IPv4 address; the local-use NAT64 prefix 64:ff9b:1::/48 is never public
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
    if (zeros(b, 4, 12)) return isPrivateIPv4(dotted(b, 12)) ? `NAT64 ${dotted(b, 12)}` : null;
    if (b[4] === 0x00 && b[5] === 0x01) return 'local-use NAT64';
  }
  const first = (b[0] << 8) | b[1];
  const second = (b[2] << 8) | b[3];
  if ((first & 0xe000) !== 0x2000) return 'not global unicast (outside 2000::/3)'; // also covers ULA fc00::/7, link-local fe80::/10, site-local fec0::/10, multicast ff00::/8
  if (first === 0x2002) return isPrivateIPv4(dotted(b, 2)) ? `6to4 ${dotted(b, 2)}` : null;                       // 2002::/16 embeds an IPv4 address
  if (first === 0x2001 && second === 0x0000) return 'Teredo';                                                       // 2001::/32
  if (first === 0x2001 && second === 0x0db8) return 'documentation range';                                          // 2001:db8::/32
  if (first === 0x2001 && second === 0x0002 && b[4] === 0 && b[5] === 0) return 'benchmarking range';              // 2001:2::/48
  if (first === 0x2001 && (second & 0xfff0) === 0x0010) return 'ORCHID';                                           // 2001:10::/28
  if (first === 0x2001 && (second & 0xfff0) === 0x0020) return 'ORCHIDv2';                                          // 2001:20::/28
  return null;
}

// True for an IPv6 address a user-supplied URL must never reach (any textual form). Text that is not an IPv6 address at all (a host NAME, for instance - some callers pass any hostname)
// is not this function's business and returns false; a literal that IS an IPv6 address is classified deny-by-default (see classifyIPv6).
export function isPrivateIPv6(ip: string): boolean {
  if (parseIPv6(ip) === null) return false;
  return classifyIPv6(ip) !== null;
}

function isBlockedHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '0.0.0.0' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.lan') ||
    hostname.endsWith('.localhost')
  );
}

function parseOutboundUrl(inputUrl: string): URL {
  const trimmed = inputUrl.trim();
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed);
  return new URL(hasScheme ? trimmed : `https://${trimmed}`);
}

// The host of a parsed URL as a bare, lower-case, dot-free name or address (no brackets around an IPv6 literal, no trailing dot on a name).
function bareHostname(parsed: URL): string {
  const raw = parsed.hostname.toLowerCase();
  if (raw.startsWith('[') && raw.endsWith(']')) return raw.slice(1, -1);
  return raw.endsWith('.') ? raw.slice(0, -1) : raw;
}

function rejectUnsafeParsedUrl(parsed: URL, allowLocalTestDestinations: boolean): void {
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new OutboundPolicyError('OUTBOUND_UNSUPPORTED_PROTOCOL', `Unsupported protocol: ${parsed.protocol}`);
  if (parsed.username || parsed.password) throw new OutboundPolicyError('OUTBOUND_EMBEDDED_CREDENTIALS', 'URL with embedded credentials is blocked.');
  const hostname = bareHostname(parsed);
  if (allowLocalTestDestinations) return;
  if (isBlockedHostname(hostname)) throw new OutboundPolicyError('OUTBOUND_LOCAL_HOSTNAME', 'Access to localhost / local domains is blocked.');
  if (isIPv4(hostname) && isPrivateIPv4(hostname)) throw new OutboundPolicyError('OUTBOUND_PRIVATE_IPV4', 'Access to private network IPv4 addresses is blocked.');
  if (isIPv6(hostname) && isPrivateIPv6(hostname)) throw new OutboundPolicyError('OUTBOUND_PRIVATE_IPV6', 'Access to private network IPv6 addresses is blocked.');
}

export async function resolveAndValidateDestination(
  parsedUrl: URL,
  resolver?: OutboundDnsResolver,
  allowLocalTestDestinations = false,
): Promise<OutboundUrlValidation> {
  rejectUnsafeParsedUrl(parsedUrl, allowLocalTestDestinations);
  const hostname = bareHostname(parsedUrl);
  let resolvedPublicIp = hostname;
  let addressFamily: 4 | 6 = isIPv6(hostname) ? 6 : 4;

  // a literal address has already been judged above; only a NAME is resolved (and every address it resolves to is judged again)
  if (!isIPv4(hostname) && !isIPv6(hostname)) {
    const lookup = resolver ?? ((h: string) => dns.lookup(h, { all: true }));
    const resolved = await lookup(hostname);
    if (resolved.length === 0) throw new OutboundPolicyError('OUTBOUND_NO_ADDRESSES', 'DNS resolution returned no addresses.');
    for (const entry of resolved) {
      const fam = entry.family === 6 ? 6 : 4;
      if (!allowLocalTestDestinations && ((fam === 4 && isPrivateIPv4(entry.address)) || (fam === 6 && isPrivateIPv6(entry.address)))) {
        throw new OutboundPolicyError('OUTBOUND_RESOLVED_PRIVATE', `Resolved IP ${entry.address} is not a public destination.`);
      }
    }
    resolvedPublicIp = resolved[0].address;
    addressFamily = resolved[0].family === 6 ? 6 : 4;
  }

  return { normalizedUrl: parsedUrl.toString(), parsedUrl, hostname, resolvedPublicIp, addressFamily };
}

export async function validateOutboundUrl(
  inputUrl: string,
  options: { resolver?: OutboundDnsResolver; allowLocalTestDestinations?: boolean } = {},
): Promise<OutboundUrlValidation> {
  const parsedUrl = parseOutboundUrl(inputUrl);
  return resolveAndValidateDestination(parsedUrl, options.resolver, Boolean(options.allowLocalTestDestinations));
}

export async function validateRedirectDestination(
  location: string,
  baseUrl: URL,
  options: { resolver?: OutboundDnsResolver; allowLocalTestDestinations?: boolean } = {},
): Promise<OutboundUrlValidation> {
  return resolveAndValidateDestination(new URL(location, baseUrl), options.resolver, Boolean(options.allowLocalTestDestinations));
}

export function createPinnedLookup(validation: OutboundUrlValidation, resolver?: OutboundDnsResolver, allowLocalTestDestinations = false) {
  return (hostname: string, options: unknown, callback?: unknown): void => {
    const cb = typeof options === 'function' ? options : callback;
    if (typeof cb !== 'function') return;
    const opts = typeof options === 'object' && options !== null ? options as { all?: boolean } : {};
    const finish = (address: string, family: 4 | 6) => {
      if (!allowLocalTestDestinations && ((family === 4 && isPrivateIPv4(address)) || (family === 6 && isPrivateIPv6(address)))) {
        (cb as (err: Error) => void)(new OutboundPolicyError('OUTBOUND_DNS_REBINDING', `DNS rebinding blocked for ${hostname}: ${address}`));
        return;
      }
      if (address !== validation.resolvedPublicIp) {
        (cb as (err: Error) => void)(new OutboundPolicyError('OUTBOUND_DNS_REBINDING', `DNS rebinding blocked for ${hostname}: destination changed`));
        return;
      }
      if (opts.all) (cb as (err: null, addrs: Array<{ address: string; family: number }>) => void)(null, [{ address, family }]);
      else (cb as (err: null, address: string, family: number) => void)(null, address, family);
    };
    if (resolver) {
      resolver(validation.hostname).then((entries) => {
        const first = entries[0];
        finish(first?.address ?? validation.resolvedPublicIp, first?.family === 6 ? 6 : 4);
      }).catch(() => finish(validation.resolvedPublicIp, validation.addressFamily));
    } else {
      finish(validation.resolvedPublicIp, validation.addressFamily);
    }
  };
}
