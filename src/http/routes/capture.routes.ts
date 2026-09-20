import { LinkCaptureService } from '../../capture/link-capture.service.js';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';

export interface CaptureRouteDeps {
  linkCaptureService: LinkCaptureService;
}

export const handleCaptureRoutes: AsyncRouteRegistrar<CaptureRouteDeps> = async (
  method,
  pathname,
  body,
  _headers,
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
  }

  return undefined;
};
