import { NagexError } from '../../common/errors.js';
import type { BrowserTaskService } from '../../device-control/browser-task.service.js';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';
import { tryGetCallerIdentity } from '../request-identity.js';

// Browser tasks: "do this on that website", with the person in control.
//
//   POST /api/v1/browser-tasks                  start a task (a goal + the website address); answered at once, the task goes on in the background
//   GET  /api/v1/browser-tasks                  the caller's tasks
//   GET  /api/v1/browser-tasks/capability       whether NAgex can do browser tasks here (a planner is configured)
//   GET  /api/v1/browser-tasks/:id              the task: state, steps, what NAgex observed, the approval it waits on, the verified result
//   POST /api/v1/browser-tasks/:id/(approve|decline|pause|continue|cancel)
//   GET  /api/v1/browser-tasks/:id/screenshot   the latest picture of the page (owner only)
//
// Every route is owner-scoped (another person's task is the same 404 as one that does not exist). Approving is the signed-in owner's own act on the approval the task is waiting on; nothing
// else in NAgex can approve it.

export interface BrowserTaskRouteDeps {
  browserTaskService?: BrowserTaskService;
}

function getHeaderValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

const STATUS_BY_CODE: Record<string, number> = {
  BROWSER_TASK_GOAL_INVALID: 400,
  BROWSER_TASK_DOMAIN_REQUIRED: 400,
  BROWSER_TASK_DOMAIN_NOT_ALLOWED: 400,
  BROWSER_TASK_ALREADY_ACTIVE: 409,
  BROWSER_TASK_NOT_FOUND: 404,
  BROWSER_TASK_NOT_WAITING: 409,
  BROWSER_TASK_NOT_PAUSED: 409,
  DEVICE_SESSION_NOT_ACTIVE: 409,
  DEVICE_SESSION_NOT_FOUND: 404,
  DEVICE_SESSION_NOT_PAUSED: 409,
  DEVICE_SESSION_NOT_WAITING: 409,
  APPROVAL_NOT_FOUND: 404,
  APPROVAL_EXPIRED: 410,
  APPROVAL_NOT_PENDING: 409,
  BROWSER_RUNTIME_UNAVAILABLE: 503,
};

function failure(error: unknown, requestId: string): ApiResult {
  if (error instanceof NagexError) {
    const status = STATUS_BY_CODE[error.code] ?? (error.category === 'VALIDATION' ? 400 : error.category === 'NOT_FOUND' ? 404 : error.category === 'CONFLICT' ? 409 : error.category === 'POLICY' ? 403 : 500);
    return { status, data: { error: error.code, message: error.message, request_id: requestId, ...(error.details ? { details: error.details } : {}) } };
  }
  throw error;
}

export const handleBrowserTaskRoutes: AsyncRouteRegistrar<BrowserTaskRouteDeps> = async (method, pathname, body, headers, _query, deps): Promise<ApiResult | undefined> => {
  if (pathname !== '/api/v1/browser-tasks' && !pathname.startsWith('/api/v1/browser-tasks/')) return undefined;
  const caller = tryGetCallerIdentity(headers);
  if (!caller) return undefined; // route-access.ts has already answered 401 for anonymous callers
  const { tenantId, principalId } = caller;
  const requestId = getHeaderValue(headers, 'x-request-id') || `req_bt_${Date.now()}`;
  const service = deps.browserTaskService;

  if (pathname === '/api/v1/browser-tasks/capability' && method === 'GET') {
    return { status: 200, data: { available: Boolean(service) } };
  }
  if (!service) {
    return { status: 503, data: { error: 'BROWSER_TASK_UNAVAILABLE', message: 'NAgex cannot do browser tasks here: no model is configured to plan them.', request_id: requestId } };
  }

  try {
    if (pathname === '/api/v1/browser-tasks' && method === 'POST') {
      const task = await service.start({
        tenantId,
        ownerId: principalId,
        requestId,
        goal: typeof body?.goal === 'string' ? body.goal : '',
        ...(Array.isArray(body?.allowedDomains) ? { allowedDomains: (body!.allowedDomains as unknown[]).filter((d): d is string => typeof d === 'string').slice(0, 3) } : {}),
        ...(typeof body?.maxSteps === 'number' ? { maxSteps: Math.max(1, Math.min(50, Math.round(body.maxSteps))) } : {}),
      });
      return { status: 202, data: { task } };
    }

    if (pathname === '/api/v1/browser-tasks' && method === 'GET') {
      return { status: 200, data: { tasks: service.list(tenantId, principalId) } };
    }

    const match = /^\/api\/v1\/browser-tasks\/([^/]+)(?:\/(approve|decline|pause|continue|cancel|screenshot))?$/.exec(pathname);
    if (!match) return { status: 404, data: { error: 'NOT_FOUND', message: 'Not found.', request_id: requestId } };
    const taskId = decodeURIComponent(match[1]);
    const action = match[2];
    const input = { tenantId, ownerId: principalId, requestId, taskId };

    if (!action && method === 'GET') {
      const task = service.get(input);
      return task ? { status: 200, data: { task } } : { status: 404, data: { error: 'BROWSER_TASK_NOT_FOUND', message: 'Task not found.', request_id: requestId } };
    }

    if (action === 'screenshot' && method === 'GET') {
      const picture = await service.screenshot(input);
      if (!picture) return { status: 404, data: { error: 'BROWSER_TASK_NOT_FOUND', message: 'Task not found.', request_id: requestId } };
      return { status: 200, data: picture, contentType: 'image/png', isBinary: true, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } };
    }

    if (action && method === 'POST') {
      const task = action === 'approve' ? service.approve(input)
        : action === 'decline' ? service.decline(input)
        : action === 'pause' ? service.pause(input)
        : action === 'continue' ? service.continue(input)
        : service.cancel(input);
      return { status: 200, data: { task } };
    }
  } catch (error) {
    return failure(error, requestId);
  }

  return { status: 405, data: { error: 'METHOD_NOT_ALLOWED', message: 'Method not allowed.', request_id: requestId } };
};
