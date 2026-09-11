import { URL } from 'node:url';
import { NagexError } from '../../common/errors.js';

const DISALLOWED_SCHEMES = new Set(['file:', 'javascript:', 'data:', 'ftp:', 'gopher:', 'vbscript:']);

const BLOCKED_HOSTNAMES = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]']);

// RFC1918 + Cloud Metadata Ranges (169.254.169.254)
const BLOCKED_IP_REGEXES = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
];

export interface UrlValidationOptions {
  allowLocalhostInTests?: boolean;
}

export function isUrlSafe(inputUrl: string, options: UrlValidationOptions = {}): { safe: boolean; reason?: string; url?: string } {
  if (!inputUrl || typeof inputUrl !== 'string') {
    return { safe: false, reason: 'URL must be a non-empty string.' };
  }

  const trimmed = inputUrl.trim();
  let parsed: URL;

  try {
    // Handle plain domains like 'example.com' or 'nvidia.com'
    const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed);
    const urlToParse = hasScheme ? trimmed : `https://${trimmed}`;
    parsed = new URL(urlToParse);
  } catch {
    return { safe: false, reason: `Invalid URL format: ${inputUrl}` };
  }

  const protocol = parsed.protocol.toLowerCase();
  if (DISALLOWED_SCHEMES.has(protocol) || (protocol !== 'http:' && protocol !== 'https:')) {
    return { safe: false, reason: `Unsafe scheme '${protocol}'. Only http: and https: are allowed.` };
  }

  const hostname = parsed.hostname.toLowerCase();

  // Allow localhost for deterministic local unit/integration tests when enabled
  const allowLocal = options.allowLocalhostInTests ?? (process.env.NODE_ENV === 'test' || process.env.NAGEX_ALLOW_LOCAL_TEST_URLS === '1');

  if (!allowLocal) {
    if (BLOCKED_HOSTNAMES.has(hostname)) {
      return { safe: false, reason: `Access to local host '${hostname}' is blocked by security policy.` };
    }
    for (const regex of BLOCKED_IP_REGEXES) {
      if (regex.test(hostname)) {
        return { safe: false, reason: `Access to private/metadata IP '${hostname}' is blocked by security policy.` };
      }
    }
  }

  return { safe: true, url: parsed.toString() };
}

export function assertUrlSafe(inputUrl: string, requestId: string, options: UrlValidationOptions = {}): string {
  const result = isUrlSafe(inputUrl, options);
  if (!result.safe || !result.url) {
    throw new NagexError({
      code: 'BROWSER_UNSAFE_URL',
      category: 'POLICY',
      message: result.reason || `URL '${inputUrl}' is blocked by security policy.`,
      request_id: requestId,
    });
  }
  return result.url;
}
