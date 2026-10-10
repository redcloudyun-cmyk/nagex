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

const PRIVATE_IPV4_RANGES = [
  { start: ipToLong('10.0.0.0'), end: ipToLong('10.255.255.255') },
  { start: ipToLong('172.16.0.0'), end: ipToLong('172.31.255.255') },
  { start: ipToLong('192.168.0.0'), end: ipToLong('192.168.255.255') },
  { start: ipToLong('127.0.0.0'), end: ipToLong('127.255.255.255') },
  { start: ipToLong('169.254.0.0'), end: ipToLong('169.254.255.255') },
  { start: ipToLong('0.0.0.0'), end: ipToLong('0.255.255.255') },
];

function ipToLong(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + Number.parseInt(octet, 10), 0) >>> 0;
}

export function isPrivateIPv4(ip: string): boolean {
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip)) return false;
  const parts = ip.split('.').map((p) => Number.parseInt(p, 10));
  if (parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false;
  const longIp = ipToLong(ip);
  return PRIVATE_IPV4_RANGES.some((range) => longIp >= range.start && longIp <= range.end);
}

export function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === '::1' || normalized === '::') return true;
  if (normalized.startsWith('fe80:') || normalized.startsWith('fc00:') || normalized.startsWith('fd')) return true;
  if (normalized.startsWith('::ffff:')) return isPrivateIPv4(normalized.replace('::ffff:', ''));
  return false;
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

function rejectUnsafeParsedUrl(parsed: URL, allowLocalTestDestinations: boolean): void {
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(`Unsupported protocol: ${parsed.protocol}`);
  if (parsed.username || parsed.password) throw new Error('URL with embedded credentials is blocked.');
  const hostname = parsed.hostname.toLowerCase();
  if (allowLocalTestDestinations) return;
  if (isBlockedHostname(hostname)) throw new Error('Access to localhost / local domains is blocked.');
  if (isIPv4(hostname) && isPrivateIPv4(hostname)) throw new Error('Access to private network IPv4 addresses is blocked.');
  if (isIPv6(hostname) && isPrivateIPv6(hostname)) throw new Error('Access to private network IPv6 addresses is blocked.');
}

export async function resolveAndValidateDestination(
  parsedUrl: URL,
  resolver?: OutboundDnsResolver,
  allowLocalTestDestinations = false,
): Promise<OutboundUrlValidation> {
  rejectUnsafeParsedUrl(parsedUrl, allowLocalTestDestinations);
  const hostname = parsedUrl.hostname.toLowerCase();
  let resolvedPublicIp = hostname;
  let addressFamily: 4 | 6 = isIPv6(hostname) ? 6 : 4;

  if (!isIPv4(hostname) && !isIPv6(hostname)) {
    const lookup = resolver ?? ((h: string) => dns.lookup(h, { all: true }));
    const resolved = await lookup(hostname);
    if (resolved.length === 0) throw new Error('DNS resolution returned no addresses.');
    for (const entry of resolved) {
      const fam = entry.family === 6 ? 6 : 4;
      if (!allowLocalTestDestinations && ((fam === 4 && isPrivateIPv4(entry.address)) || (fam === 6 && isPrivateIPv6(entry.address)))) {
        throw new Error(`Resolved IP ${entry.address} is not a public destination.`);
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
        (cb as (err: Error) => void)(new Error(`DNS rebinding blocked for ${hostname}: ${address}`));
        return;
      }
      if (address !== validation.resolvedPublicIp) {
        (cb as (err: Error) => void)(new Error(`DNS rebinding blocked for ${hostname}: destination changed`));
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
