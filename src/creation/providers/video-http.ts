import http from 'node:http';
import https from 'node:https';
import { validateOutboundUrl, validateRedirectDestination, createPinnedLookup, type OutboundDnsResolver } from '../../security/outbound-url-policy.js';
import { VideoProviderError } from './video-provider-error.js';

// HTTP helpers shared by the video provider adapters.
//
//   requestJson  - a call to the provider's own API. The base URL is operator configuration (like every other provider adapter), so it is not
//                  run through the outbound-URL policy; the credential only ever travels in the request headers the caller passes.
//   fetchMedia   - a download from a URL the PROVIDER returned. That is untrusted input: https only, no private / loopback / link-local
//                  destination, DNS pinned against rebinding, at most three redirects each re-validated, the credential header dropped when the
//                  host changes, a hard size cap and a hard timeout.

export interface JsonResponse {
  status: number;
  json: any;
  text: string;
}

export async function requestJson(
  url: string,
  options: { method: 'GET' | 'POST'; headers?: Record<string, string>; body?: unknown; timeoutMs: number },
): Promise<JsonResponse> {
  const target = new URL(url);
  const client = target.protocol === 'http:' ? http : https;
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise<JsonResponse>((resolve, reject) => {
    const req = client.request(
      {
        hostname: target.hostname,
        port: target.port || (target.protocol === 'http:' ? 80 : 443),
        path: `${target.pathname}${target.search}`,
        method: options.method,
        headers: {
          Accept: 'application/json',
          ...(payload !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...(options.headers || {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          // an API answer is small; anything huge is not an API answer
          if (size > 2_000_000) {
            req.destroy();
            reject(new VideoProviderError('MALFORMED_RESPONSE', 'The provider answered with an unexpectedly large body.', { httpStatus: res.statusCode }));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: any = null;
          try { json = text ? JSON.parse(text) : null; } catch { /* not JSON; callers look at status and text */ }
          resolve({ status: res.statusCode ?? 0, json, text });
        });
        res.on('error', (err) => reject(new VideoProviderError('NETWORK_ERROR', `Could not read the provider's answer: ${err.message}`, { retryable: true })));
      },
    );
    req.on('error', (err) => reject(new VideoProviderError('NETWORK_ERROR', `Could not reach the provider: ${err.message}`, { retryable: true })));
    req.setTimeout(options.timeoutMs, () => {
      req.destroy();
      reject(new VideoProviderError('TIMEOUT', `The provider did not answer within ${Math.round(options.timeoutMs / 1000)} seconds.`, { retryable: true }));
    });
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

export interface FetchMediaOptions {
  /** sent to the first host only; dropped when a redirect changes the host */
  headers?: Record<string, string>;
  maxBytes: number;
  timeoutMs: number;
  allowLocalTestDestinations?: boolean;
  resolver?: OutboundDnsResolver;
}

export interface FetchedMedia {
  bytes: Buffer;
  contentType: string;
}

export async function fetchMedia(url: string, options: FetchMediaOptions): Promise<FetchedMedia> {
  const allowLocal = Boolean(options.allowLocalTestDestinations);
  let current = url;
  let sendHeaders: Record<string, string> | undefined = options.headers;
  const deadline = Date.now() + options.timeoutMs;

  for (let hop = 0; hop <= 3; hop += 1) {
    let validation;
    try {
      validation = hop === 0
        ? await validateOutboundUrl(current, { resolver: options.resolver, allowLocalTestDestinations: allowLocal })
        : await validateRedirectDestination(current, new URL(url), { resolver: options.resolver, allowLocalTestDestinations: allowLocal });
    } catch (error: any) {
      throw new VideoProviderError('MEDIA_DOWNLOAD_FAILED', `The video address was refused: ${error?.code || error?.message || 'blocked destination'}.`);
    }
    if (validation.parsedUrl.protocol !== 'https:' && !allowLocal) {
      throw new VideoProviderError('MEDIA_DOWNLOAD_FAILED', 'The video address is not https, so it was not downloaded.');
    }
    const result = await fetchOnce(validation, sendHeaders, options, Math.max(1000, deadline - Date.now()), allowLocal);
    if ('location' in result) {
      const next = new URL(result.location, validation.parsedUrl);
      if (next.host !== validation.parsedUrl.host) sendHeaders = undefined;
      current = next.toString();
      continue;
    }
    return result;
  }
  throw new VideoProviderError('MEDIA_DOWNLOAD_FAILED', 'The video address redirected too many times.');
}

type OnceResult = FetchedMedia | { location: string };

function fetchOnce(
  validation: Awaited<ReturnType<typeof validateOutboundUrl>>,
  headers: Record<string, string> | undefined,
  options: FetchMediaOptions,
  timeoutMs: number,
  allowLocal: boolean,
): Promise<OnceResult> {
  const target = validation.parsedUrl;
  const client = target.protocol === 'http:' ? http : https;
  return new Promise<OnceResult>((resolve, reject) => {
    const req = client.request(
      {
        hostname: target.hostname,
        port: target.port || (target.protocol === 'http:' ? 80 : 443),
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        headers: { Accept: 'video/*,application/octet-stream;q=0.8', ...(headers || {}) },
        lookup: createPinnedLookup(validation, options.resolver, allowLocal) as any,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          resolve({ location: String(res.headers.location) });
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          reject(new VideoProviderError('MEDIA_DOWNLOAD_FAILED', `The video could not be downloaded (HTTP ${status}).`, { httpStatus: status, retryable: status >= 500 }));
          return;
        }
        const declared = Number(res.headers['content-length']);
        if (Number.isFinite(declared) && declared > options.maxBytes) {
          res.resume();
          reject(new VideoProviderError('MEDIA_INVALID', `The video is larger than the ${Math.round(options.maxBytes / 1_000_000)} MB limit.`));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > options.maxBytes) {
            req.destroy();
            reject(new VideoProviderError('MEDIA_INVALID', `The video is larger than the ${Math.round(options.maxBytes / 1_000_000)} MB limit.`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const bytes = Buffer.concat(chunks);
          if (Number.isFinite(declared) && declared !== bytes.length) {
            reject(new VideoProviderError('MEDIA_INVALID', 'The download ended early (size does not match what the provider declared).', { retryable: true }));
            return;
          }
          resolve({ bytes, contentType: String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase() });
        });
        res.on('error', (err) => reject(new VideoProviderError('MEDIA_DOWNLOAD_FAILED', `The video download was interrupted: ${err.message}`, { retryable: true })));
      },
    );
    req.on('error', (err) => reject(new VideoProviderError('MEDIA_DOWNLOAD_FAILED', `The video could not be downloaded: ${err.message}`, { retryable: true })));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new VideoProviderError('TIMEOUT', 'The video download timed out.', { retryable: true }));
    });
    req.end();
  });
}

/** PUT bytes to a presigned URL the provider handed out. Untrusted destination: same policy as a download; no NAgex or provider credential is ever sent. */
export async function putBytes(
  url: string,
  bytes: Buffer,
  headers: Record<string, string>,
  options: { timeoutMs: number; allowLocalTestDestinations?: boolean; resolver?: OutboundDnsResolver },
): Promise<void> {
  const allowLocal = Boolean(options.allowLocalTestDestinations);
  let validation;
  try {
    validation = await validateOutboundUrl(url, { resolver: options.resolver, allowLocalTestDestinations: allowLocal });
  } catch (error: any) {
    throw new VideoProviderError('MEDIA_DOWNLOAD_FAILED', `The upload address was refused: ${error?.code || error?.message || 'blocked destination'}.`);
  }
  if (validation.parsedUrl.protocol !== 'https:' && !allowLocal) {
    throw new VideoProviderError('MEDIA_DOWNLOAD_FAILED', 'The upload address is not https, so nothing was uploaded.');
  }
  const target = validation.parsedUrl;
  const client = target.protocol === 'http:' ? http : https;
  await new Promise<void>((resolve, reject) => {
    const req = client.request(
      {
        hostname: target.hostname,
        port: target.port || (target.protocol === 'http:' ? 80 : 443),
        path: `${target.pathname}${target.search}`,
        method: 'PUT',
        headers: { ...headers, 'Content-Length': bytes.length },
        lookup: createPinnedLookup(validation, options.resolver, allowLocal) as any,
      },
      (res) => {
        res.resume();
        res.on('end', () => {
          if ((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300) resolve();
          else reject(new VideoProviderError('PROVIDER_REJECTED_REQUEST', `The image upload was refused (HTTP ${res.statusCode}).`, { httpStatus: res.statusCode }));
        });
      },
    );
    req.on('error', (err) => reject(new VideoProviderError('NETWORK_ERROR', `The image upload failed: ${err.message}`, { retryable: true })));
    req.setTimeout(options.timeoutMs, () => {
      req.destroy();
      reject(new VideoProviderError('TIMEOUT', 'The image upload timed out.', { retryable: true }));
    });
    req.write(bytes);
    req.end();
  });
}
