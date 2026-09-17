// R10.2-D Increment 5 — Model provider status/health-check routes,
// extracted verbatim from server_web.ts's handleAsyncApiRequest. This is
// existing HTTP behavior only — it does not implement the future Model
// Gateway milestone (no new providers, routing policy, credential
// pooling, billing, or fallback logic are added here).
import type { AiService } from '../../model-gateway/ai-service.js';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';

export interface ProvidersRouteDeps {
  service: AiService;
}

export const handleProvidersRoutes: AsyncRouteRegistrar<ProvidersRouteDeps> = async (method, pathname, _body, _headers, _query, deps): Promise<ApiResult | undefined> => {
  const { service } = deps;

  if (pathname === '/api/v1/providers/status' && method === 'GET') {
    // R7 §2/§3 — same real per-provider statuses() this already returned,
    // plus the active/fallback summary Settings' AI & Model section needs.
    // Never a hardcoded configured/connected value: both come straight
    // from UnifiedModelRouter's real registration-order + observed
    // per-provider state (see providers.ts's HttpModelProvider.status()).
    // R7.1: a pure read — never triggers a generation itself. The only
    // way this reflects LIVE/DEGRADED is real prior generate() traffic or
    // an explicit POST /api/v1/providers/health-check probe (below).
    return { status: 200, data: { providers: service.statuses(), ...service.activeProviderSummary() } };
  }
  if (pathname === '/api/v1/providers/health-check' && method === 'POST') {
    // R7.1 — the one real, explicit way to move a provider from
    // CONFIGURED to LIVE/DEGRADED without waiting for organic traffic:
    // a cheap, minimal, bounded probe per configured provider (each
    // already individually timeout-bounded — see providers.ts), never
    // an infinite retry, never a fabricated result.
    const providers = await service.healthCheck();
    return { status: 200, data: { providers, ...service.activeProviderSummary() } };
  }

  return undefined;
};
