// Retrieves the readable text of a public web page for a research run - and only what the site and NAgex's own outbound policy permit.
//   - every request (and every redirect hop) goes through the SSRF policy: private / local / metadata destinations are refused and the socket is pinned to the address that was validated;
//   - robots.txt is read first and obeyed (RFC 9309): disallowed paths are not fetched; a robots.txt that cannot be read (5xx, 401/403, timeout) is treated as "do not fetch", a missing one (404) as "allowed";
//   - requests to one host are spaced (and a Crawl-delay / Retry-After is honoured); a rate-limited host is not retried;
//   - only text/html, XHTML and plain text are read, within a byte and time budget; PDFs and binaries are reported as unsupported, never guessed at;
//   - the User-Agent says who is asking. No cookies, no credentials, no JavaScript execution.
// The outcome states exactly what happened. A failure is a failure with a reason, never an empty success.
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import { createPinnedLookup, validateOutboundUrl, validateRedirectDestination, type OutboundDnsResolver, type OutboundUrlValidation } from '../security/outbound-url-policy.js';
import { extractReadablePage } from './html-text.js';
import { ALLOW_ALL, DISALLOW_ALL, parseRobots, type RobotsRules } from './robots.js';

export const RESEARCH_USER_AGENT = 'NAgex-Research/1.0 (read-only personal research assistant)';

export interface FetchedSourceContent {
  url: string;
  finalUrl: string;
  httpStatus: number;
  contentType: string;
  title: string;
  text: string;
  textTruncated: boolean;
  publishedAt?: string;
  modifiedAt?: string;
  retrievedAt: string;
  bytes: number;
  /** sha256 of the extracted text - proves later which text a claim was checked against */
  contentHash: string;
  robots: 'ALLOWED' | 'NO_ROBOTS_FILE';
}

export type SourceFetchFailureCode =
  | 'POLICY_BLOCKED'
  | 'ROBOTS_DISALLOWED'
  | 'ROBOTS_UNREADABLE'
  | 'HTTP_ERROR'
  | 'RATE_LIMITED'
  | 'UNSUPPORTED_CONTENT'
  | 'TOO_LARGE'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'TOO_MANY_REDIRECTS';

export type SourceFetchOutcome =
  | { ok: true; source: FetchedSourceContent }
  | { ok: false; code: SourceFetchFailureCode; message: string; httpStatus?: number };

export interface SourceFetcherOptions {
  userAgent?: string;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  maxTextChars?: number;
  /** minimum gap between two requests to the same host */
  perHostIntervalMs?: number;
  robotsTtlMs?: number;
  /** the longest a single request may be made to wait for the per-host spacing before it is given up as rate limited */
  maxThrottleWaitMs?: number;
  resolver?: OutboundDnsResolver;
  /** tests only: lets the fetcher reach 127.0.0.1 fixtures. Never set from configuration. */
  allowLocalTestDestinations?: boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

type RawResponse =
  | { kind: 'response'; status: number; headers: IncomingHttpHeaders; body: Buffer }
  | { kind: 'error'; code: 'TIMEOUT' | 'TOO_LARGE' | 'NETWORK_ERROR'; message: string };

interface RobotsEntry { rules: RobotsRules; state: 'FOUND' | 'NO_FILE' | 'UNREADABLE'; expiresAt: number }

const READABLE_TYPES = ['text/html', 'application/xhtml+xml', 'text/plain'];

export class SourceFetcher {
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly maxRedirects: number;
  private readonly maxTextChars: number;
  private readonly perHostIntervalMs: number;
  private readonly robotsTtlMs: number;
  private readonly maxThrottleWaitMs: number;
  private readonly resolver?: OutboundDnsResolver;
  private readonly allowLocal: boolean;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly robotsCache = new Map<string, RobotsEntry>();
  private readonly robotsInFlight = new Map<string, Promise<RobotsEntry>>();
  private readonly nextSlotAt = new Map<string, number>();
  private readonly blockedUntil = new Map<string, number>();

  constructor(options: SourceFetcherOptions = {}) {
    this.userAgent = options.userAgent ?? RESEARCH_USER_AGENT;
    this.timeoutMs = options.timeoutMs ?? 8000;
    this.maxBytes = options.maxBytes ?? 1_500_000;
    this.maxRedirects = options.maxRedirects ?? 3;
    this.maxTextChars = options.maxTextChars ?? 24_000;
    this.perHostIntervalMs = options.perHostIntervalMs ?? 1000;
    this.robotsTtlMs = options.robotsTtlMs ?? 60 * 60 * 1000;
    this.maxThrottleWaitMs = options.maxThrottleWaitMs ?? 15_000;
    this.resolver = options.resolver;
    this.allowLocal = Boolean(options.allowLocalTestDestinations);
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  public async fetch(rawUrl: string): Promise<SourceFetchOutcome> {
    let current = rawUrl;
    let previous: URL | null = null;
    let robotsState: 'ALLOWED' | 'NO_ROBOTS_FILE' = 'ALLOWED';
    for (let hop = 0; hop <= this.maxRedirects; hop++) {
      let validation: OutboundUrlValidation;
      try {
        const options = { resolver: this.resolver, allowLocalTestDestinations: this.allowLocal };
        validation = previous ? await validateRedirectDestination(current, previous, options) : await validateOutboundUrl(current, options);
      } catch (error) {
        return { ok: false, code: 'POLICY_BLOCKED', message: error instanceof Error ? error.message : 'The address is not allowed.' };
      }
      const target = validation.parsedUrl;
      const origin = target.origin;

      const blockedUntil = this.blockedUntil.get(origin) ?? 0;
      if (blockedUntil > this.now()) return { ok: false, code: 'RATE_LIMITED', message: 'The site asked for a pause; it was not contacted again.' };

      const robots = await this.robotsFor(validation);
      if (robots.state === 'UNREADABLE') return { ok: false, code: 'ROBOTS_UNREADABLE', message: 'robots.txt could not be read, so the page was not fetched.' };
      if (!robots.rules.allows(`${target.pathname}${target.search}`)) return { ok: false, code: 'ROBOTS_DISALLOWED', message: 'robots.txt does not allow this page to be fetched.' };
      robotsState = robots.state === 'NO_FILE' ? 'NO_ROBOTS_FILE' : 'ALLOWED';

      const waited = await this.throttle(origin, Math.max(this.perHostIntervalMs, (robots.rules.crawlDelaySeconds ?? 0) * 1000));
      if (!waited) return { ok: false, code: 'RATE_LIMITED', message: 'Too many requests to this site in this run; this page was skipped.' };

      const response = await this.httpGet(validation, 'text/html,application/xhtml+xml,text/plain;q=0.8', this.maxBytes, true);
      if (response.kind === 'error') return { ok: false, code: response.code, message: response.message };

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.location;
        if (!location) return { ok: false, code: 'HTTP_ERROR', message: 'Redirect without a location.', httpStatus: response.status };
        previous = target;
        current = Array.isArray(location) ? location[0] : location;
        continue;
      }
      if (response.status === 429 || response.status === 503) {
        const retryAfter = Number.parseInt(String(response.headers['retry-after'] ?? ''), 10);
        const pauseMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 600) * 1000 : 60_000;
        this.blockedUntil.set(origin, this.now() + pauseMs);
        return { ok: false, code: 'RATE_LIMITED', message: `The site is rate limiting requests (HTTP ${response.status}).`, httpStatus: response.status };
      }
      if (response.status < 200 || response.status >= 300) return { ok: false, code: 'HTTP_ERROR', message: `The site answered HTTP ${response.status}.`, httpStatus: response.status };

      const contentType = String(response.headers['content-type'] ?? '').toLowerCase();
      const baseType = contentType.split(';')[0].trim();
      if (!READABLE_TYPES.includes(baseType)) return { ok: false, code: 'UNSUPPORTED_CONTENT', message: `Content type ${baseType || 'unknown'} is not readable text.`, httpStatus: response.status };

      const decoded = this.decode(response.body, contentType);
      const retrievedAt = new Date(this.now()).toISOString();
      const finalUrl = target.toString();
      let title: string;
      let text: string;
      let textTruncated = false;
      let publishedAt: string | undefined;
      let modifiedAt: string | undefined;
      if (baseType === 'text/plain') {
        const trimmed = decoded.replace(/\r\n?/g, '\n').trim();
        textTruncated = trimmed.length > this.maxTextChars;
        text = textTruncated ? trimmed.slice(0, this.maxTextChars) : trimmed;
        title = `${target.hostname}${target.pathname}`;
      } else {
        const page = extractReadablePage(decoded, this.maxTextChars);
        title = page.title || target.hostname;
        text = page.text;
        textTruncated = page.textTruncated;
        publishedAt = page.publishedAt;
        modifiedAt = page.modifiedAt;
      }
      if (text.trim().length < 80) return { ok: false, code: 'UNSUPPORTED_CONTENT', message: 'The page has no readable text (it may need JavaScript or a login).', httpStatus: response.status };
      return {
        ok: true,
        source: {
          url: rawUrl,
          finalUrl,
          httpStatus: response.status,
          contentType: baseType,
          title,
          text,
          textTruncated,
          publishedAt,
          modifiedAt,
          retrievedAt,
          bytes: response.body.length,
          contentHash: crypto.createHash('sha256').update(text).digest('hex'),
          robots: robotsState,
        },
      };
    }
    return { ok: false, code: 'TOO_MANY_REDIRECTS', message: 'The page redirected too many times.' };
  }

  // ---- robots.txt --------------------------------------------------------------------------------------------------------------------------------------

  private robotsFor(validation: OutboundUrlValidation): Promise<RobotsEntry> {
    const origin = validation.parsedUrl.origin;
    const cached = this.robotsCache.get(origin);
    if (cached && cached.expiresAt > this.now()) return Promise.resolve(cached);
    const running = this.robotsInFlight.get(origin);
    if (running) return running;
    const started = this.loadRobots(validation).then((entry) => { this.robotsCache.set(origin, entry); return entry; }).finally(() => { this.robotsInFlight.delete(origin); });
    this.robotsInFlight.set(origin, started);
    return started;
  }

  private async loadRobots(pageValidation: OutboundUrlValidation): Promise<RobotsEntry> {
    const expiresAt = this.now() + this.robotsTtlMs;
    const unreadable: RobotsEntry = { rules: DISALLOW_ALL, state: 'UNREADABLE', expiresAt: this.now() + Math.min(this.robotsTtlMs, 5 * 60 * 1000) };
    try {
      const robotsUrl = new URL('/robots.txt', pageValidation.parsedUrl);
      // the page's address has just been validated and robots.txt is on the same origin, so the same pinned address is used
      const validation: OutboundUrlValidation = { ...pageValidation, parsedUrl: robotsUrl, normalizedUrl: robotsUrl.toString() };
      await this.throttle(robotsUrl.origin, this.perHostIntervalMs);
      const response = await this.httpGet(validation, 'text/plain,*/*;q=0.1', 512 * 1024, false);
      if (response.kind === 'error') return unreadable;
      if (response.status >= 200 && response.status < 300) {
        return { rules: parseRobots(response.body.toString('utf8'), this.userAgent), state: 'FOUND', expiresAt };
      }
      if (response.status === 404 || response.status === 410) return { rules: ALLOW_ALL, state: 'NO_FILE', expiresAt };
      // 401 / 403 / 5xx / redirects to somewhere else: the site's wishes are unknown - ask nothing of it
      return unreadable;
    } catch {
      return unreadable;
    }
  }

  // ---- spacing -----------------------------------------------------------------------------------------------------------------------------------------

  /** Reserves the next slot for the host and waits for it. false when the wait would exceed the budget. */
  private async throttle(origin: string, intervalMs: number): Promise<boolean> {
    const now = this.now();
    const start = Math.max(now, this.nextSlotAt.get(origin) ?? 0);
    if (start - now > this.maxThrottleWaitMs) return false;
    this.nextSlotAt.set(origin, start + intervalMs);
    if (start > now) await this.sleep(start - now);
    return true;
  }

  // ---- transport ---------------------------------------------------------------------------------------------------------------------------------------

  private decode(body: Buffer, contentType: string): string {
    let label = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType)?.[1];
    if (!label) label = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(body.subarray(0, 4096).toString('latin1'))?.[1];
    try {
      return new TextDecoder(label || 'utf-8').decode(body);
    } catch {
      return body.toString('utf8');
    }
  }

  private httpGet(validation: OutboundUrlValidation, accept: string, maxBytes: number, stopAtRedirect: boolean): Promise<RawResponse> {
    const target = validation.parsedUrl;
    const client = target.protocol === 'https:' ? https : http;
    return new Promise((resolve) => {
      let settled = false;
      const done = (value: RawResponse) => { if (!settled) { settled = true; resolve(value); } };
      const req = client.request(
        target,
        {
          method: 'GET',
          headers: { 'User-Agent': this.userAgent, Accept: accept, 'Accept-Encoding': 'identity', 'Accept-Language': 'ko,en;q=0.8' },
          timeout: this.timeoutMs,
          lookup: createPinnedLookup(validation, this.resolver, this.allowLocal),
        },
        (res) => {
          const status = res.statusCode || 0;
          if (stopAtRedirect && [301, 302, 303, 307, 308].includes(status)) {
            res.resume();
            done({ kind: 'response', status, headers: res.headers, body: Buffer.alloc(0) });
            return;
          }
          const declared = Number.parseInt(String(res.headers['content-length'] ?? ''), 10);
          if (Number.isFinite(declared) && declared > maxBytes) {
            req.destroy();
            done({ kind: 'error', code: 'TOO_LARGE', message: 'The page is larger than the size NAgex reads.' });
            return;
          }
          const chunks: Buffer[] = [];
          let total = 0;
          res.on('data', (chunk: Buffer) => {
            total += chunk.length;
            if (total > maxBytes) {
              req.destroy();
              done({ kind: 'error', code: 'TOO_LARGE', message: 'The page is larger than the size NAgex reads.' });
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => done({ kind: 'response', status, headers: res.headers, body: Buffer.concat(chunks) }));
          res.on('error', (error) => done({ kind: 'error', code: 'NETWORK_ERROR', message: error.message }));
        },
      );
      req.on('timeout', () => { req.destroy(); done({ kind: 'error', code: 'TIMEOUT', message: 'The site did not answer in time.' }); });
      req.on('error', (error) => done({ kind: 'error', code: 'NETWORK_ERROR', message: error.message }));
      req.end();
    });
  }
}
