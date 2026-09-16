// R10.2-D Increment 4 — Desktop Quick Wake routes, extracted verbatim from
// server_web.ts's handleAsyncApiRequest.
import crypto from 'node:crypto';
import { NagexError } from '../../common/errors.js';
import type { DesktopRuntimeEngine } from '../../desktop/desktop-runtime.engine.js';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';

function getHeaderValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export interface DesktopRouteDeps {
  desktopRuntimeEngine: DesktopRuntimeEngine;
}

export const handleDesktopRoutes: AsyncRouteRegistrar<DesktopRouteDeps> = async (method, pathname, body, headers, _query, deps): Promise<ApiResult | undefined> => {
  const { desktopRuntimeEngine } = deps;

  if (pathname === '/api/v1/desktop/quickwake/status' && method === 'GET') {
    return { status: 200, data: { hotkey: desktopRuntimeEngine.getHotkey(), windowState: desktopRuntimeEngine.getWindowState(), isRunning: desktopRuntimeEngine.isRunning() } };
  }
  if (pathname === '/api/v1/desktop/quickwake/toggle' && method === 'POST') {
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_hk_toggle_${crypto.randomUUID()}`;
    const state = desktopRuntimeEngine.triggerGlobalHotkey(requestId);
    return { status: 200, data: { hotkey: desktopRuntimeEngine.getHotkey(), windowState: state, isRunning: desktopRuntimeEngine.isRunning() } };
  }
  if (pathname === '/api/v1/desktop/quickwake/tray/action' && method === 'POST') {
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_tray_act_${crypto.randomUUID()}`;
    const action = typeof body?.action === 'string' ? body.action.trim() : '';
    if (!action) {
      throw new NagexError({ code: 'INVALID_TRAY_ACTION', category: 'VALIDATION', message: 'Tray action string is required.', request_id: requestId });
    }
    const result = desktopRuntimeEngine.handleTrayAction(action as any, requestId);
    return { status: 200, data: result };
  }

  return undefined;
};
