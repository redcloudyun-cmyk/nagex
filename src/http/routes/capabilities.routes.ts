// R10.2-D Increment 5 — Capability Broker execution route, extracted
// verbatim from server_web.ts's handleAsyncApiRequest. This route is
// already exactly the canonical execution boundary required (HTTP ->
// CapabilityBroker.execute(), which itself owns Policy/Approval/runtime
// dispatch) — this move relocates the HTTP translation only, no new
// direct tool/provider call is introduced.
import { NagexError } from '../../common/errors.js';
import type { CapabilityBroker } from '../../capabilities/index.js';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';

export interface CapabilitiesRouteDeps {
  capabilityBroker: CapabilityBroker;
  modelErrorResult: (error: unknown) => ApiResult;
}

export const handleCapabilitiesRoutes: AsyncRouteRegistrar<CapabilitiesRouteDeps> = async (method, pathname, body, headers, _query, deps): Promise<ApiResult | undefined> => {
  const { capabilityBroker, modelErrorResult } = deps;

  if (pathname === '/api/v1/capabilities/execute' && method === 'POST') {
    const tenantId = (Array.isArray(headers['x-nagex-tenant']) ? headers['x-nagex-tenant'][0] : headers['x-nagex-tenant']) || 'ten_production_01';
    const principalId = (Array.isArray(headers['x-principal-id']) ? headers['x-principal-id'][0] : headers['x-principal-id']) || 'usr_admin_001';
    const headerRequestId = headers['x-request-id'] || headers['X-Request-Id'];
    const requestId = (Array.isArray(headerRequestId) ? headerRequestId[0] : headerRequestId) || `req_cap_${Date.now()}`;

    const capabilityId = typeof body?.capabilityId === 'string' ? body.capabilityId : '';
    const payload = body?.payload ?? {};
    const idempotencyKey = typeof body?.idempotencyKey === 'string' ? body.idempotencyKey : undefined;
    const sourceRaw = typeof body?.source === 'string' ? body.source : 'WEB';
    const source = ['WEB', 'QUICK_WAKE', 'TELEGRAM', 'SLACK', 'TASK', 'SYSTEM'].includes(sourceRaw)
      ? (sourceRaw as any)
      : 'WEB';

    try {
      const result = await capabilityBroker.execute({
        capabilityId,
        tenantId,
        principalId,
        requestId,
        payload,
        source,
        idempotencyKey,
      });

      if (result.status === 'EXECUTED') {
        return { status: 200, data: result };
      }
      if (result.status === 'APPROVAL_REQUIRED') {
        return { status: 202, data: result };
      }
      if (result.status === 'BLOCKED') {
        const httpStatus = result.reasonCode === 'CAPABILITY_NOT_FOUND' ? 404 : 403;
        return { status: httpStatus, data: result };
      }
      return { status: 400, data: result };
    } catch (error) {
      if (error instanceof NagexError) {
        if (error.code === 'CAPABILITY_NOT_FOUND') {
          return { status: 404, data: { error: error.code, message: error.message, request_id: requestId } };
        }
        if (error.code === 'CAPABILITY_IDEMPOTENCY_CONFLICT') {
          return { status: 409, data: { error: error.code, message: error.message, request_id: requestId } };
        }
        if (['CAPABILITY_DISABLED', 'CAPABILITY_BLOCKED_BY_SAFETY', 'CAPABILITY_POLICY_FAILED'].includes(error.code)) {
          return { status: 403, data: { error: error.code, message: error.message, request_id: requestId } };
        }
      }
      return modelErrorResult(error);
    }
  }

  return undefined;
};
