import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import { isIPv4, isIPv6 } from 'node:net';

export interface LinkCaptureSource {
  url: string;
  finalUrl: string;
  title: string;
  description?: string;
  siteName?: string;
  author?: string;
  publishedAt?: string;
  retrievedAt: string;
  contentType: string;
  contentLength?: number;
}

export interface LinkCapturePreview {
  summary: string;
  excerpt: string;
  headings: string[];
}

export interface LinkCaptureResult {
  status: 'READY' | 'UNAVAILABLE';
  error?: string;
  source?: LinkCaptureSource;
  preview?: LinkCapturePreview;
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
  return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
}

export function isPrivateIPv4(ip: string): boolean {
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip)) return false;
  const longIp = ipToLong(ip);
  return PRIVATE_IPV4_RANGES.some((range) => longIp >= range.start && longIp <= range.end);
}

export function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === '::1' || normalized === '::') return true;
  if (normalized.startsWith('fe80:') || normalized.startsWith('fc00:') || normalized.startsWith('fd00:')) return true;
  if (normalized.startsWith('::ffff:')) {
    const ipv4Part = normalized.replace('::ffff:', '');
    if (isPrivateIPv4(ipv4Part)) return true;
  }
  return false;
}

export type CustomDnsResolver = (hostname: string) => Promise<{ address: string; family: number }[]>;

export async function validateUrlForSsrf(
  urlStr: string,
  customResolver?: CustomDnsResolver,
  allowTestFixture?: boolean
): Promise<{ valid: boolean; reason?: string; parsedUrl?: URL; resolvedIp?: string; resolvedFamily?: 4 | 6 }> {
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { valid: false, reason: `Unsupported protocol: ${parsed.protocol}` };
    }

    const hostname = parsed.hostname.toLowerCase();
    if (!allowTestFixture) {
      if (
        hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        hostname === '::1' ||
        hostname === '0.0.0.0' ||
        hostname.endsWith('.local') ||
        hostname.endsWith('.internal')
      ) {
        return { valid: false, reason: 'Access to localhost / local domains is blocked.' };
      }

      if (isPrivateIPv4(hostname) || isPrivateIPv6(hostname)) {
        return { valid: false, reason: 'Access to private network IP addresses is blocked.' };
      }
    }

    let resolvedIp = hostname;
    let resolvedFamily: 4 | 6 = 4;

    if (!isIPv4(hostname) && !isIPv6(hostname)) {
      try {
        const lookupFn = customResolver || (async (h) => dns.lookup(h, { all: true }));
        const ips = await lookupFn(hostname);
        for (const entry of ips) {
          if (!allowTestFixture && (isPrivateIPv4(entry.address) || isPrivateIPv6(entry.address))) {
            return { valid: false, reason: `Resolved IP ${entry.address} is in private network range.` };
          }
        }
        if (ips.length > 0) {
          resolvedIp = ips[0].address;
          resolvedFamily = ips[0].family === 6 ? 6 : 4;
        }
      } catch {
        return { valid: false, reason: 'DNS resolution failed.' };
      }
    } else {
      resolvedFamily = isPrivateIPv6(hostname) || hostname.includes(':') ? 6 : 4;
    }

    return { valid: true, parsedUrl: parsed, resolvedIp, resolvedFamily };
  } catch {
    return { valid: false, reason: 'Invalid URL format.' };
  }
}

export class LinkCaptureService {
  private readonly timeoutMs: number = 5000;
  private readonly maxResponseSizeBytes: number = 1024 * 1024; // 1MB
  private readonly maxRedirects: number = 3;
  private readonly customResolver?: CustomDnsResolver;
  private readonly allowTestFixture?: boolean;

  constructor(options?: { customResolver?: CustomDnsResolver; allowTestFixture?: boolean }) {
    this.customResolver = options?.customResolver;
    this.allowTestFixture = options?.allowTestFixture;
  }

  public async captureLink(rawUrl: string): Promise<LinkCaptureResult> {
    const validation = await validateUrlForSsrf(rawUrl, this.customResolver, this.allowTestFixture);
    if (!validation.valid || !validation.parsedUrl || !validation.resolvedIp) {
      return {
        status: 'UNAVAILABLE',
        error: validation.reason || 'Invalid URL or private network destination.',
      };
    }

    try {
      const fetched = await this.fetchWithRedirectValidation(validation.parsedUrl, validation.resolvedIp, validation.resolvedFamily || 4, 0);
      if (!fetched.success || !fetched.body) {
        return {
          status: 'UNAVAILABLE',
          error: fetched.error || 'Failed to fetch target URL.',
        };
      }

      const contentType = fetched.contentType || 'text/html';
      const retrievedAt = new Date().toISOString();
      const bodyText = fetched.body;

      if (contentType.includes('application/json')) {
        return this.parseJsonContent(rawUrl, fetched.finalUrl, bodyText, retrievedAt);
      }

      if (contentType.includes('text/plain')) {
        return this.parseTextContent(rawUrl, fetched.finalUrl, bodyText, contentType, retrievedAt);
      }

      return this.parseHtmlContent(rawUrl, fetched.finalUrl, bodyText, contentType, retrievedAt);
    } catch (err) {
      return {
        status: 'UNAVAILABLE',
        error: err instanceof Error ? err.message : 'Fetch operation failed.',
      };
    }
  }

  private async fetchWithRedirectValidation(
    targetUrl: URL,
    resolvedIp: string,
    resolvedFamily: 4 | 6,
    redirectCount: number
  ): Promise<{ success: boolean; body?: string; finalUrl: string; contentType?: string; error?: string }> {
    if (redirectCount > this.maxRedirects) {
      return { success: false, finalUrl: targetUrl.href, error: 'Too many redirects.' };
    }

    return new Promise((resolve) => {
      const client = targetUrl.protocol === 'https:' ? https : http;
      const req = client.request(
        targetUrl,
        {
          method: 'GET',
          headers: {
            'User-Agent': 'NAgex-LinkCapture/1.0',
            Accept: 'text/html,text/plain,application/json;q=0.9',
            Host: targetUrl.host,
          },
          timeout: this.timeoutMs,
          // DNS_REBINDING_BYPASS=0: Direct socket connection to the exact IP address validated
          lookup: (hostname: string, options: any, callback?: any) => {
            const cb = typeof options === 'function' ? options : callback;
            if (typeof cb !== 'function') return;

            const handleResult = (ip: string, fam: 4 | 6) => {
              if ((!this.allowTestFixture || ip !== resolvedIp) && (isPrivateIPv4(ip) || isPrivateIPv6(ip))) {
                cb(new Error(`DNS Rebinding detected: Host ${hostname} resolved to private IP ${ip}`));
                return;
              }
              if (options && typeof options === 'object' && options.all) {
                cb(null, [{ address: ip, family: fam }]);
              } else {
                cb(null, ip, fam);
              }
            };

            if (this.customResolver) {
              this.customResolver(hostname).then((ips) => {
                if (ips.length > 0) {
                  handleResult(ips[0].address, ips[0].family === 6 ? 6 : 4);
                } else {
                  handleResult(resolvedIp, resolvedFamily);
                }
              }).catch(() => {
                handleResult(resolvedIp, resolvedFamily);
              });
            } else {
              handleResult(resolvedIp, resolvedFamily);
            }
          },
        },
        (res) => {
          const statusCode = res.statusCode || 500;

          // Handle Redirects with fresh DNS resolve + SSRF re-validation on target IP
          if ([301, 302, 303, 307, 308].includes(statusCode) && res.headers.location) {
            req.destroy();
            try {
              const redirectUrl = new URL(res.headers.location, targetUrl);
              validateUrlForSsrf(redirectUrl.href, this.customResolver, false).then((redirVal) => {
                if (!redirVal.valid || !redirVal.parsedUrl || !redirVal.resolvedIp) {
                  resolve({ success: false, finalUrl: redirectUrl.href, error: redirVal.reason || 'Redirect destination blocked.' });
                  return;
                }
                resolve(this.fetchWithRedirectValidation(redirVal.parsedUrl, redirVal.resolvedIp, redirVal.resolvedFamily || 4, redirectCount + 1));
              }).catch(() => {
                resolve({ success: false, finalUrl: redirectUrl.href, error: 'Redirect SSRF validation failed.' });
              });
              return;
            } catch {
              resolve({ success: false, finalUrl: targetUrl.href, error: 'Invalid redirect location.' });
              return;
            }
          }

          if (statusCode < 200 || statusCode >= 300) {
            req.destroy();
            resolve({ success: false, finalUrl: targetUrl.href, error: `HTTP ${statusCode}` });
            return;
          }

          const rawContentType = (res.headers['content-type'] as string) || 'text/html';
          if (!rawContentType.includes('text/html') && !rawContentType.includes('text/plain') && !rawContentType.includes('application/json')) {
            req.destroy();
            resolve({ success: false, finalUrl: targetUrl.href, error: `Unsupported content type: ${rawContentType}` });
            return;
          }

          let data = '';
          let dataLen = 0;

          res.on('data', (chunk: Buffer) => {
            dataLen += chunk.length;
            if (dataLen > this.maxResponseSizeBytes) {
              req.destroy();
              resolve({ success: false, finalUrl: targetUrl.href, error: 'Response exceeded maximum allowed size.' });
              return;
            }
            data += chunk.toString('utf-8');
          });

          res.on('end', () => {
            resolve({
              success: true,
              body: data,
              finalUrl: targetUrl.href,
              contentType: rawContentType,
            });
          });

          res.on('error', (err) => {
            resolve({ success: false, finalUrl: targetUrl.href, error: err.message });
          });
        }
      );

      req.on('timeout', () => {
        req.destroy();
        resolve({ success: false, finalUrl: targetUrl.href, error: 'Request timed out.' });
      });

      req.on('error', (err) => {
        resolve({ success: false, finalUrl: targetUrl.href, error: err.message });
      });

      req.end();
    });
  }

  private parseHtmlContent(url: string, finalUrl: string, html: string, contentType: string, retrievedAt: string): LinkCaptureResult {
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const ogTitleMatch = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
    const title = (ogTitleMatch ? ogTitleMatch[1] : titleMatch ? titleMatch[1] : new URL(finalUrl).hostname).trim();

    const descMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
    const ogDescMatch = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i);
    const description = (ogDescMatch ? ogDescMatch[1] : descMatch ? descMatch[1] : undefined)?.trim();

    const siteMatch = html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i);
    const siteName = (siteMatch ? siteMatch[1] : new URL(finalUrl).hostname).trim();

    const authorMatch = html.match(/<meta[^>]+name=["']author["'][^>]+content=["']([^"']+)["']/i);
    const author = authorMatch ? authorMatch[1].trim() : undefined;

    const dateMatch = html.match(/<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i);
    const publishedAt = dateMatch ? dateMatch[1].trim() : undefined;

    let clean = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
      .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
      .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ');

    const headings: string[] = [];
    const hRegex = /<h[1-3][^>]*>([^<]+)<\/h[1-3]>/gi;
    let hMatch: RegExpExecArray | null;
    while ((hMatch = hRegex.exec(clean)) !== null && headings.length < 5) {
      const text = hMatch[1].trim();
      if (text) headings.push(text);
    }

    const plainText = clean
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const excerpt = plainText.length > 300 ? plainText.slice(0, 300) + '...' : plainText;
    const summary = description || excerpt;

    return {
      status: 'READY',
      source: {
        url,
        finalUrl,
        title,
        description,
        siteName,
        author,
        publishedAt,
        retrievedAt,
        contentType,
        contentLength: html.length,
      },
      preview: {
        summary,
        excerpt,
        headings,
      },
    };
  }

  private parseTextContent(url: string, finalUrl: string, text: string, contentType: string, retrievedAt: string): LinkCaptureResult {
    const title = new URL(finalUrl).hostname;
    const excerpt = text.length > 300 ? text.slice(0, 300) + '...' : text;

    return {
      status: 'READY',
      source: {
        url,
        finalUrl,
        title,
        siteName: new URL(finalUrl).hostname,
        retrievedAt,
        contentType,
        contentLength: text.length,
      },
      preview: {
        summary: excerpt,
        excerpt,
        headings: [],
      },
    };
  }

  private parseJsonContent(url: string, finalUrl: string, jsonStr: string, retrievedAt: string): LinkCaptureResult {
    let title = new URL(finalUrl).hostname;
    let excerpt = jsonStr.slice(0, 300);

    try {
      const parsed = JSON.parse(jsonStr);
      if (parsed.title && typeof parsed.title === 'string') title = parsed.title;
      if (parsed.name && typeof parsed.name === 'string') title = parsed.name;
    } catch {
      // Ignore JSON parse error fallback
    }

    return {
      status: 'READY',
      source: {
        url,
        finalUrl,
        title,
        siteName: new URL(finalUrl).hostname,
        retrievedAt,
        contentType: 'application/json',
        contentLength: jsonStr.length,
      },
      preview: {
        summary: excerpt,
        excerpt,
        headings: [],
      },
    };
  }
}
