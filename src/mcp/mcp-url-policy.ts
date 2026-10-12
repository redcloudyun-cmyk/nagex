// MCP server URL policy. A user-supplied MCP server URL makes the NAgex server issue outbound requests, so it is the SSRF
// boundary: https only, no credentials in the URL, no private / loopback / link-local / metadata / reserved address (checked
// on the literal host, on every resolved address, and again at connect time by the guarded lookup so DNS rebinding cannot
// swap in an internal address between the check and the connection), an optional operator allowlist, and no redirects.
import dns from 'node:dns';
import net from 'node:net';
import { NagexError } from '../common/errors.js';

export interface McpUrlPolicyOptions {
  // Operator escape hatch for development and tests only (NAGEX_MCP_ALLOW_PRIVATE_NETWORK=1): permits http and private addresses.
  allowPrivateNetwork?: boolean;
  // When non-empty, only these hosts (exact, or `*.example.com` for subdomains) may be registered.
  allowedHosts?: string[];
  // Injectable for tests; defaults to dns.lookup(all).
  resolve?: (hostname: string) => Promise<string[]>;
}

export function readMcpUrlPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): McpUrlPolicyOptions {
  return {
    allowPrivateNetwork: env.NAGEX_MCP_ALLOW_PRIVATE_NETWORK === '1',
    allowedHosts: (env.NAGEX_MCP_ALLOWED_HOSTS ?? '').split(',').map((host) => host.trim().toLowerCase()).filter(Boolean),
  };
}

const blocked = new net.BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8], ['2001:db8::', 32], ['100::', 64],
] as const) blocked.addSubnet(network, prefix, 'ipv6');

// True for any address a user-supplied URL must never reach.
export function isPrivateOrReservedAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return blocked.check(address, 'ipv4');
  if (family === 6) {
    const lower = address.toLowerCase();
    // IPv4-mapped / NAT64 forms carry an IPv4 address that must be judged on its own.
    const mapped = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPrivateOrReservedAddress(mapped[1]);
    const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
    if (mappedHex) {
      const high = parseInt(mappedHex[1], 16);
      const low = parseInt(mappedHex[2], 16);
      return isPrivateOrReservedAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
    return blocked.check(address, 'ipv6');
  }
  return true; // not an IP at all: refuse rather than guess
}

function reject(message: string, requestId: string, reason: string): NagexError {
  return new NagexError({ code: 'MCP_URL_REJECTED', category: 'VALIDATION', message, request_id: requestId, details: { reason } });
}

function hostAllowed(hostname: string, allowed: string[]): boolean {
  return allowed.some((entry) => (entry.startsWith('*.') ? hostname.endsWith(entry.slice(1)) && hostname.length > entry.length - 1 : hostname === entry));
}

async function defaultResolve(hostname: string): Promise<string[]> {
  const results = await dns.promises.lookup(hostname, { all: true });
  return results.map((entry) => entry.address);
}

// Validates a user-supplied MCP server URL. Returns the parsed URL only when it is safe to connect to.
export async function assertSafeMcpUrl(raw: unknown, requestId: string, options: McpUrlPolicyOptions = readMcpUrlPolicyFromEnv()): Promise<URL> {
  if (typeof raw !== 'string' || raw.trim().length === 0 || raw.length > 2048) throw reject('A valid MCP server URL is required.', requestId, 'INVALID');
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw reject('The MCP server URL is not valid.', requestId, 'INVALID'); }
  if (url.username || url.password) throw reject('Credentials must not be embedded in the URL.', requestId, 'CREDENTIALS_IN_URL');
  if (url.hash) throw reject('The MCP server URL must not contain a fragment.', requestId, 'FRAGMENT');
  const privateOk = options.allowPrivateNetwork === true;
  if (url.protocol !== 'https:' && !(privateOk && url.protocol === 'http:')) throw reject('The MCP server URL must use https.', requestId, 'INSECURE_SCHEME');

  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (options.allowedHosts && options.allowedHosts.length > 0 && !hostAllowed(hostname, options.allowedHosts)) {
    throw reject('This MCP server host is not allowed on this deployment.', requestId, 'HOST_NOT_ALLOWED');
  }
  if (!privateOk) {
    if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal') || hostname.endsWith('.lan')) {
      throw reject('Local network addresses are not allowed for MCP servers.', requestId, 'PRIVATE_ADDRESS');
    }
    const addresses = net.isIP(hostname) ? [hostname] : await (options.resolve ?? defaultResolve)(hostname).catch(() => []);
    if (addresses.length === 0) throw reject('The MCP server host could not be resolved.', requestId, 'UNRESOLVABLE');
    if (addresses.some(isPrivateOrReservedAddress)) throw reject('Local network addresses are not allowed for MCP servers.', requestId, 'PRIVATE_ADDRESS');
  }
  return url;
}

// dns.lookup replacement for the real transport: re-checks every address at connect time (DNS rebinding defence).
export function createGuardedLookup(options: McpUrlPolicyOptions = readMcpUrlPolicyFromEnv()): typeof dns.lookup {
  const guarded = ((hostname: string, lookupOptions: dns.LookupOptions | number | undefined, callback: (err: NodeJS.ErrnoException | null, address?: unknown, family?: number) => void) => {
    const opts = typeof lookupOptions === 'object' && lookupOptions ? lookupOptions : {};
    dns.lookup(hostname, { ...opts, all: true }, (error, addresses) => {
      if (error) return callback(error);
      const list = addresses as dns.LookupAddress[];
      if (!options.allowPrivateNetwork && list.some((entry) => isPrivateOrReservedAddress(entry.address))) {
        return callback(Object.assign(new Error('MCP_PRIVATE_ADDRESS'), { code: 'MCP_PRIVATE_ADDRESS' }));
      }
      if (opts.all) return callback(null, list);
      return callback(null, list[0].address, list[0].family);
    });
  }) as unknown as typeof dns.lookup;
  return guarded;
}
