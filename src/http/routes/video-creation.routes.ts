import { NagexError } from '../../common/errors.js';
import type { VideoJobService } from '../../creation/video-job.service.js';
import { VIDEO_ID_PATTERN } from '../../creation/video.store.js';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';
import { tryGetCallerIdentity } from '../request-identity.js';

// Video creation (Higgsfield / Veo behind the VideoProviderPort).
//
//   POST /api/v1/creations/videos               prepare: price + an approval request. NOTHING is sent to any provider.
//   GET  /api/v1/creations/videos               the caller's videos
//   GET  /api/v1/creations/videos/capability    whether any video service is set up (what Main uses to decide whether to offer video)
//   GET  /api/v1/creations/videos/:id           status, brought up to date from the provider if due
//   POST /api/v1/creations/videos/:id/approve   the person's approval of exactly what was shown; the only way a paid job starts
//   POST /api/v1/creations/videos/:id/decline   no; nothing is sent
//   POST /api/v1/creations/videos/:id/cancel    only while still queued at a provider that supports it
//   GET  /api/v1/creations/videos/:id/media     the stored MP4 (owner only; Range supported so it can be played and seeked; ?download=1 to save)
//
// Every route is owner-scoped: another person's id and an unknown id are the same 404.

export interface VideoCreationRouteDeps {
  videoJobService?: VideoJobService;
}

function getHeaderValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

const STATUS_BY_CODE: Record<string, number> = {
  INVALID_PROMPT: 400,
  PROMPT_TOO_LONG: 400,
  UNSUPPORTED_ASPECT_RATIO: 400,
  IMAGE_TO_VIDEO_UNSUPPORTED: 400,
  TEXT_TO_VIDEO_UNSUPPORTED: 400,
  VIDEO_NOT_FOUND: 404,
  IMAGE_NOT_FOUND: 404,
  APPROVAL_NOT_FOUND: 404,
  VIDEO_NOT_AWAITING_APPROVAL: 409,
  CANCEL_UNSUPPORTED: 409,
  CANCEL_NOT_POSSIBLE: 409,
  APPROVAL_EXPIRED: 410,
  APPROVAL_LOST: 410,
  APPROVAL_ALREADY_CONSUMED: 409,
  APPROVAL_PAYLOAD_MISMATCH: 409,
  COST_LIMIT_EXCEEDED: 422,
  COST_UNKNOWN: 422,
  NO_CREATION_PROVIDER_AVAILABLE: 503,
  PROVIDER_NOT_FOUND: 400,
  PROVIDER_UNCONFIGURED: 503,
  PROVIDER_QUOTA_EXCEEDED: 503,
  PROVIDER_BILLING_REQUIRED: 503,
  PROVIDER_INSUFFICIENT_CREDITS: 503,
  PROVIDER_AUTH_FAILED: 503,
  PROVIDER_MODEL_NOT_FOUND: 503,
  PROVIDER_UNAVAILABLE_ERROR: 503,
};

function failure(error: unknown, requestId: string): ApiResult {
  if (error instanceof NagexError) {
    const status = STATUS_BY_CODE[error.code] ?? (error.category === 'VALIDATION' ? 400 : error.category === 'NOT_FOUND' ? 404 : error.category === 'CONFLICT' ? 409 : error.category === 'PROVIDER' ? 502 : 500);
    return { status, data: { error: error.code, message: error.message, request_id: requestId } };
  }
  throw error;
}

/** A single "bytes=a-b" range, or null when absent / unsatisfiable. Only the first range of a multi-range request is honoured. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'UNSATISFIABLE' | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)(?:,.*)?$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;
  let start: number;
  let end: number;
  if (rawStart === '') {
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return 'UNSATISFIABLE';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= size || start > end) return 'UNSATISFIABLE';
  return { start, end };
}

export const handleVideoCreationRoutes: AsyncRouteRegistrar<VideoCreationRouteDeps> = async (
  method,
  pathname,
  body,
  headers,
  query,
  deps
): Promise<ApiResult | undefined> => {
  if (pathname !== '/api/v1/creations/videos' && !pathname.startsWith('/api/v1/creations/videos/')) return undefined;
  const caller = tryGetCallerIdentity(headers);
  if (!caller) return undefined; // route-access.ts has already answered 401 for anonymous callers
  const { tenantId, principalId } = caller;
  const requestId = getHeaderValue(headers, 'x-request-id') || `req_vid_${Date.now()}`;
  const service = deps.videoJobService;
  if (!service) {
    return { status: 503, data: { error: 'VIDEO_UNAVAILABLE', message: 'Video creation is not available on this server.', request_id: requestId } };
  }

  try {
    if (pathname === '/api/v1/creations/videos' && method === 'POST') {
      const result = await service.prepare({
        tenantId,
        ownerId: principalId,
        requestId,
        prompt: typeof body?.prompt === 'string' ? body.prompt : '',
        durationSeconds: typeof body?.durationSeconds === 'number' ? body.durationSeconds : undefined,
        aspectRatio: typeof body?.aspectRatio === 'string' ? body.aspectRatio : undefined,
        sourceImageId: typeof body?.sourceImageId === 'string' && body.sourceImageId ? body.sourceImageId : undefined,
      });
      return { status: result.deduplicated ? 200 : 201, data: { video: service.toView(result.job), deduplicated: result.deduplicated } };
    }

    if (pathname === '/api/v1/creations/videos' && method === 'GET') {
      return { status: 200, data: { videos: service.list(tenantId, principalId).map((job) => service.toView(job)) } };
    }

    if (pathname === '/api/v1/creations/videos/capability' && method === 'GET') {
      return { status: 200, data: { available: service.isAvailable() } };
    }

    const match = /^\/api\/v1\/creations\/videos\/([^/]+)(?:\/(approve|decline|cancel|media))?$/.exec(pathname);
    if (!match) return { status: 404, data: { error: 'NOT_FOUND', message: 'Not found.', request_id: requestId } };
    const jobId = decodeURIComponent(match[1]);
    const action = match[2];
    if (!VIDEO_ID_PATTERN.test(jobId)) return { status: 404, data: { error: 'VIDEO_NOT_FOUND', message: 'Video not found.', request_id: requestId } };

    if (!action && method === 'GET') {
      const job = await service.refresh(jobId, tenantId, principalId);
      if (!job) return { status: 404, data: { error: 'VIDEO_NOT_FOUND', message: 'Video not found.', request_id: requestId } };
      return { status: 200, data: { video: service.toView(job) } };
    }

    if (action === 'approve' && method === 'POST') {
      const result = await service.approve(jobId, tenantId, principalId, requestId);
      return { status: 200, data: { video: service.toView(result.job), reapprovalRequired: result.reapprovalRequired } };
    }

    if (action === 'decline' && method === 'POST') {
      return { status: 200, data: { video: service.toView(service.decline(jobId, tenantId, principalId, requestId)) } };
    }

    if (action === 'cancel' && method === 'POST') {
      const result = await service.cancel(jobId, tenantId, principalId, requestId);
      return { status: 200, data: { video: service.toView(result.job), cancelled: result.cancelled } };
    }

    if (action === 'media' && method === 'GET') {
      const media = service.media(jobId, tenantId, principalId);
      if (!media) return { status: 404, data: { error: 'VIDEO_NOT_FOUND', message: 'Video not found.', request_id: requestId } };
      const size = media.bytes.length;
      const baseHeaders: Record<string, string> = {
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, max-age=0, must-revalidate',
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': `${query?.download === '1' ? 'attachment' : 'inline'}; filename="${media.fileName}"`,
      };
      const range = parseRange(getHeaderValue(headers, 'range'), size);
      if (range === 'UNSATISFIABLE') {
        return { status: 416, data: Buffer.alloc(0), contentType: media.mimeType, isBinary: true, headers: { ...baseHeaders, 'Content-Range': `bytes */${size}` } };
      }
      if (range) {
        return {
          status: 206,
          data: media.bytes.subarray(range.start, range.end + 1),
          contentType: media.mimeType,
          isBinary: true,
          headers: { ...baseHeaders, 'Content-Range': `bytes ${range.start}-${range.end}/${size}` },
        };
      }
      return { status: 200, data: media.bytes, contentType: media.mimeType, isBinary: true, headers: baseHeaders };
    }
  } catch (error) {
    return failure(error, requestId);
  }

  return { status: 405, data: { error: 'METHOD_NOT_ALLOWED', message: 'Method not allowed.', request_id: requestId } };
};
