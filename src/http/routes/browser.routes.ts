// R10.2-D Increment 4 — Browser Agent routes (MASTER.md Section 14.5 item
// 06), extracted verbatim from server_web.ts's handleAsyncApiRequest. Every
// route here only ever translates HTTP <-> BrowserToolService — it never
// touches Playwright directly (that lives entirely behind
// browser.runtime.ts/browser.service.ts). click is the one route with a
// genuinely different shape: the server resolves the live target element
// and decides whether the click is harmless (executes immediately) or
// consequential (returns APPROVAL_REQUIRED with a real ActionApprovalRecord
// instead of executing) — see browser.service.ts's click() for the full
// reasoning. click/execute is the separate step that runs only after that
// approval has been granted via the existing, unchanged, tool-agnostic
// POST /api/v1/approvals/:id/approve.
import crypto from 'node:crypto';
import { NagexError } from '../../common/errors.js';
import { DEFAULT_GOOGLE_TENANT_ID } from '../../integrations/google/token.store.js';
import type { BrowserToolService } from '../../modules/browser/index.js';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';

function getHeaderValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export interface BrowserRouteDeps {
  browserApiService: BrowserToolService;
}

export const handleBrowserRoutes: AsyncRouteRegistrar<BrowserRouteDeps> = async (method, pathname, body, headers, _query, deps): Promise<ApiResult | undefined> => {
  const { browserApiService } = deps;

  if (pathname === '/api/v1/browser/sessions' && method === 'POST') {
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
    const ownerId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
    const result = await browserApiService.open({ tenantId, ownerId, requestId });
    return { status: 201, data: result };
  }
  if (pathname === '/api/v1/tools/browser/navigate' && method === 'POST') {
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
    const ownerId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
    const browserSessionId = typeof body?.browserSessionId === 'string' ? body.browserSessionId : '';
    const url = typeof body?.url === 'string' ? body.url : '';
    if (!browserSessionId) throw new NagexError({ code: 'BROWSER_SESSION_ID_REQUIRED', category: 'VALIDATION', message: 'browserSessionId is required.', request_id: requestId });
    if (!url) throw new NagexError({ code: 'BROWSER_URL_REQUIRED', category: 'VALIDATION', message: 'url is required.', request_id: requestId });
    const result = await browserApiService.navigate({ tenantId, ownerId, requestId, browserSessionId, url });
    return { status: 200, data: result };
  }
  if (pathname === '/api/v1/tools/browser/tabs' && method === 'POST') {
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
    const ownerId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
    const browserSessionId = typeof body?.browserSessionId === 'string' ? body.browserSessionId : '';
    if (!browserSessionId) throw new NagexError({ code: 'BROWSER_SESSION_ID_REQUIRED', category: 'VALIDATION', message: 'browserSessionId is required.', request_id: requestId });
    const result = await browserApiService.tabs({ tenantId, ownerId, requestId, browserSessionId });
    return { status: 200, data: { tabs: result } };
  }
  if (pathname === '/api/v1/tools/browser/snapshot' && method === 'POST') {
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
    const ownerId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
    const browserSessionId = typeof body?.browserSessionId === 'string' ? body.browserSessionId : '';
    if (!browserSessionId) throw new NagexError({ code: 'BROWSER_SESSION_ID_REQUIRED', category: 'VALIDATION', message: 'browserSessionId is required.', request_id: requestId });
    const result = await browserApiService.snapshot({ tenantId, ownerId, requestId, browserSessionId });
    return { status: 200, data: result };
  }
  if (pathname === '/api/v1/tools/browser/screenshot' && method === 'POST') {
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
    const ownerId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
    const browserSessionId = typeof body?.browserSessionId === 'string' ? body.browserSessionId : '';
    if (!browserSessionId) throw new NagexError({ code: 'BROWSER_SESSION_ID_REQUIRED', category: 'VALIDATION', message: 'browserSessionId is required.', request_id: requestId });
    const result = await browserApiService.screenshot({ tenantId, ownerId, requestId, browserSessionId });
    return { status: 200, data: result };
  }
  if (pathname === '/api/v1/tools/browser/scroll' && method === 'POST') {
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
    const ownerId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
    const browserSessionId = typeof body?.browserSessionId === 'string' ? body.browserSessionId : '';
    const direction = body?.direction === 'up' ? 'up' : 'down';
    if (!browserSessionId) throw new NagexError({ code: 'BROWSER_SESSION_ID_REQUIRED', category: 'VALIDATION', message: 'browserSessionId is required.', request_id: requestId });
    await browserApiService.scroll({ tenantId, ownerId, requestId, browserSessionId, direction, amountPx: typeof body?.amountPx === 'number' ? body.amountPx : undefined });
    return { status: 200, data: { status: 'SUCCEEDED' } };
  }
  if (pathname === '/api/v1/tools/browser/wait' && method === 'POST') {
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
    const ownerId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
    const browserSessionId = typeof body?.browserSessionId === 'string' ? body.browserSessionId : '';
    const ms = typeof body?.ms === 'number' ? body.ms : 1000;
    if (!browserSessionId) throw new NagexError({ code: 'BROWSER_SESSION_ID_REQUIRED', category: 'VALIDATION', message: 'browserSessionId is required.', request_id: requestId });
    await browserApiService.wait({ tenantId, ownerId, requestId, browserSessionId, ms });
    return { status: 200, data: { status: 'SUCCEEDED' } };
  }
  if (pathname === '/api/v1/tools/browser/type' && method === 'POST') {
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
    const ownerId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
    const browserSessionId = typeof body?.browserSessionId === 'string' ? body.browserSessionId : '';
    const selector = typeof body?.selector === 'string' ? body.selector : '';
    const text = typeof body?.text === 'string' ? body.text : '';
    if (!browserSessionId || !selector) throw new NagexError({ code: 'BROWSER_SELECTOR_REQUIRED', category: 'VALIDATION', message: 'browserSessionId and selector are required.', request_id: requestId });
    await browserApiService.type({ tenantId, ownerId, requestId, browserSessionId, selector, text });
    return { status: 200, data: { status: 'SUCCEEDED' } };
  }
  if (pathname === '/api/v1/tools/browser/select' && method === 'POST') {
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
    const ownerId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
    const browserSessionId = typeof body?.browserSessionId === 'string' ? body.browserSessionId : '';
    const selector = typeof body?.selector === 'string' ? body.selector : '';
    const value = typeof body?.value === 'string' ? body.value : '';
    if (!browserSessionId || !selector) throw new NagexError({ code: 'BROWSER_SELECTOR_REQUIRED', category: 'VALIDATION', message: 'browserSessionId and selector are required.', request_id: requestId });
    await browserApiService.select({ tenantId, ownerId, requestId, browserSessionId, selector, value });
    return { status: 200, data: { status: 'SUCCEEDED' } };
  }
  if (pathname === '/api/v1/tools/browser/click' && method === 'POST') {
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
    const ownerId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
    const browserSessionId = typeof body?.browserSessionId === 'string' ? body.browserSessionId : '';
    const selector = typeof body?.selector === 'string' ? body.selector : '';
    if (!browserSessionId || !selector) throw new NagexError({ code: 'BROWSER_SELECTOR_REQUIRED', category: 'VALIDATION', message: 'browserSessionId and selector are required.', request_id: requestId });
    const result = await browserApiService.click({ tenantId, ownerId, requestId, browserSessionId, selector });
    return { status: result.status === 'APPROVAL_REQUIRED' ? 201 : 200, data: result };
  }
  if (pathname === '/api/v1/tools/browser/click/execute' && method === 'POST') {
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
    const ownerId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
    const approvalId = typeof body?.approvalId === 'string' ? body.approvalId : '';
    const browserSessionId = typeof body?.browserSessionId === 'string' ? body.browserSessionId : '';
    const selector = typeof body?.selector === 'string' ? body.selector : '';
    if (!approvalId) throw new NagexError({ code: 'APPROVAL_ID_REQUIRED', category: 'VALIDATION', message: 'approvalId is required.', request_id: requestId });
    if (!browserSessionId || !selector) throw new NagexError({ code: 'BROWSER_SELECTOR_REQUIRED', category: 'VALIDATION', message: 'browserSessionId and selector are required.', request_id: requestId });
    const result = await browserApiService.executeApprovedClick({ approvalId, browserSessionId, selector, tenantId, ownerId, requestId });
    return { status: 200, data: result };
  }
  if (pathname === '/api/v1/tools/browser/close' && method === 'POST') {
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
    const ownerId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
    const browserSessionId = typeof body?.browserSessionId === 'string' ? body.browserSessionId : '';
    if (!browserSessionId) throw new NagexError({ code: 'BROWSER_SESSION_ID_REQUIRED', category: 'VALIDATION', message: 'browserSessionId is required.', request_id: requestId });
    await browserApiService.close({ tenantId, ownerId, requestId, browserSessionId });
    return { status: 200, data: { status: 'SUCCEEDED' } };
  }
  if (pathname === '/api/v1/tools/browser/find' && method === 'POST') {
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
    const ownerId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
    const browserSessionId = typeof body?.browserSessionId === 'string' ? body.browserSessionId : '';
    const query = typeof body?.query === 'string' ? body.query : '';
    if (!browserSessionId || !query) throw new NagexError({ code: 'BROWSER_QUERY_REQUIRED', category: 'VALIDATION', message: 'browserSessionId and query are required.', request_id: requestId });
    const result = await browserApiService.find({ tenantId, ownerId, requestId, browserSessionId, query });
    return { status: 200, data: result };
  }
  if (pathname === '/api/v1/tools/browser/extract' && method === 'POST') {
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
    const ownerId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
    const browserSessionId = typeof body?.browserSessionId === 'string' ? body.browserSessionId : '';
    const target = (typeof body?.target === 'string' ? body.target : 'all') as any;
    if (!browserSessionId) throw new NagexError({ code: 'BROWSER_SESSION_ID_REQUIRED', category: 'VALIDATION', message: 'browserSessionId is required.', request_id: requestId });
    const result = await browserApiService.extract({ tenantId, ownerId, requestId, browserSessionId, target });
    return { status: 200, data: result };
  }
  if (pathname === '/api/v1/tools/browser/back' && method === 'POST') {
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
    const ownerId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
    const browserSessionId = typeof body?.browserSessionId === 'string' ? body.browserSessionId : '';
    if (!browserSessionId) throw new NagexError({ code: 'BROWSER_SESSION_ID_REQUIRED', category: 'VALIDATION', message: 'browserSessionId is required.', request_id: requestId });
    const result = await browserApiService.back({ tenantId, ownerId, requestId, browserSessionId });
    return { status: 200, data: result };
  }
  if (pathname === '/api/v1/tools/browser/forward' && method === 'POST') {
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
    const ownerId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
    const browserSessionId = typeof body?.browserSessionId === 'string' ? body.browserSessionId : '';
    if (!browserSessionId) throw new NagexError({ code: 'BROWSER_SESSION_ID_REQUIRED', category: 'VALIDATION', message: 'browserSessionId is required.', request_id: requestId });
    const result = await browserApiService.forward({ tenantId, ownerId, requestId, browserSessionId });
    return { status: 200, data: result };
  }
  if (pathname === '/api/v1/tools/browser/reload' && method === 'POST') {
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
    const ownerId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
    const browserSessionId = typeof body?.browserSessionId === 'string' ? body.browserSessionId : '';
    if (!browserSessionId) throw new NagexError({ code: 'BROWSER_SESSION_ID_REQUIRED', category: 'VALIDATION', message: 'browserSessionId is required.', request_id: requestId });
    const result = await browserApiService.reload({ tenantId, ownerId, requestId, browserSessionId });
    return { status: 200, data: result };
  }

  return undefined;
};
