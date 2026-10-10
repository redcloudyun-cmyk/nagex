import { LinkCaptureService } from '../../capture/link-capture.service.js';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';
import { clientIpOf } from '../client-ip.js';

export interface CaptureRouteDeps {
  linkCaptureService: LinkCaptureService;
}

const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 10;
const MAX_CONCURRENT_PER_IP = 2;
const buckets = new Map<string, { windowStart: number; count: number; active: number }>();

function reserveLinkCaptureSlot(ip: string, now: number): ApiResult | (() => void) {
  const existing = buckets.get(ip);
  const bucket = !existing || now - existing.windowStart > WINDOW_MS
    ? { windowStart: now, count: 0, active: 0 }
    : existing;
  buckets.set(ip, bucket);
  if (bucket.count >= MAX_REQUESTS_PER_WINDOW) {
    return { status: 429, data: { error: 'RATE_LIMITED', message: 'Too many link capture requests.' } };
  }
  if (bucket.active >= MAX_CONCURRENT_PER_IP) {
    return { status: 429, data: { error: 'CONCURRENCY_LIMITED', message: 'Too many concurrent link capture requests.' } };
  }
  bucket.count += 1;
  bucket.active += 1;
  return () => {
    bucket.active = Math.max(0, bucket.active - 1);
  };
}

export const handleCaptureRoutes: AsyncRouteRegistrar<CaptureRouteDeps> = async (
  method,
  pathname,
  body,
  headers,
  _query,
  deps
): Promise<ApiResult | undefined> => {
  const { linkCaptureService } = deps;

  if (pathname === '/api/v1/capture/link' && method === 'POST') {
    const rawUrl = typeof body?.url === 'string' ? body.url.trim() : '';
    if (!rawUrl) {
      return {
        status: 400,
        data: { error: 'INVALID_URL', message: 'URL is required.' },
      };
    }

    const reservation = reserveLinkCaptureSlot(clientIpOf(headers), Date.now());
    if (typeof reservation !== 'function') return reservation;
    try {
      const result = await linkCaptureService.captureLink(rawUrl);
      if (result.status === 'UNAVAILABLE') {
        return {
          status: 422,
          data: {
            status: 'UNAVAILABLE',
            error: result.error || 'Failed to capture page content.',
          },
        };
      }

      return {
        status: 200,
        data: result,
      };
    } finally {
      reservation();
    }
  }

  return undefined;
};
