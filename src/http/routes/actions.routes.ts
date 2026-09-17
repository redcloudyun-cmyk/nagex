// R19 — Action HTTP Route Module
import { DEFAULT_GOOGLE_TENANT_ID } from '../../integrations/google/token.store.js';
import type { ActionStore } from '../../workspace/action.store.js';
import type { ActionExecutionEngine } from '../../actions/action-execution.engine.js';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';

function getHeaderValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export interface ActionRouteDeps {
  actionStore: ActionStore;
  actionEngine: ActionExecutionEngine;
}

export const handleActionsRoutes: AsyncRouteRegistrar<ActionRouteDeps> = async (
  method,
  pathname,
  body,
  headers,
  _query,
  deps
): Promise<ApiResult | undefined> => {
  const { actionStore, actionEngine } = deps;
  const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
  const userId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';

  if (pathname === '/api/v1/actions' && method === 'GET') {
    const items = actionStore.listActions(tenantId, userId);
    return {
      status: 200,
      data: {
        actions: items,
        total: items.length,
      },
    };
  }

  if (pathname === '/api/v1/actions' && method === 'POST') {
    const actionType = typeof body?.actionType === 'string' ? (body.actionType as any) : 'CALENDAR_CREATE';
    const provider = typeof body?.provider === 'string' ? body.provider : 'google';
    const capability = typeof body?.capability === 'string' ? body.capability : 'calendar.create_event';
    const target = typeof body?.target === 'string' ? body.target : 'Primary Calendar';
    const parameters = (body?.parameters && typeof body.parameters === 'object') ? (body.parameters as Record<string, unknown>) : {};
    const riskLevel = typeof body?.riskLevel === 'string' ? (body.riskLevel as any) : undefined;
    const idempotencyKey = typeof body?.idempotencyKey === 'string' ? body.idempotencyKey : undefined;

    const record = actionStore.createAction({
      userId,
      organizationId: tenantId,
      workspaceId: tenantId,
      actionType,
      provider,
      capability,
      target,
      parameters,
      riskLevel,
      idempotencyKey,
    });

    return {
      status: 201,
      data: record,
    };
  }

  if (pathname.startsWith('/api/v1/actions/') && method === 'GET') {
    const actionId = pathname.slice('/api/v1/actions/'.length);
    const record = actionStore.getAction(actionId, tenantId, userId);
    if (!record) {
      return {
        status: 404,
        data: { error: 'ACTION_NOT_FOUND', message: `Action ${actionId} was not found or access denied.` },
      };
    }
    return { status: 200, data: record };
  }

  if (pathname.startsWith('/api/v1/actions/') && pathname.endsWith('/approve') && method === 'POST') {
    const actionId = pathname.slice('/api/v1/actions/'.length, pathname.length - '/approve'.length);
    const requestId = `req_act_appr_${Date.now()}`;
    const record = await actionEngine.approveAction(actionId, tenantId, userId, requestId);
    return { status: 200, data: record };
  }

  if (pathname.startsWith('/api/v1/actions/') && pathname.endsWith('/reject') && method === 'POST') {
    const actionId = pathname.slice('/api/v1/actions/'.length, pathname.length - '/reject'.length);
    const requestId = `req_act_rej_${Date.now()}`;
    const record = await actionEngine.rejectAction(actionId, tenantId, userId, requestId);
    return { status: 200, data: record };
  }

  if (pathname.startsWith('/api/v1/actions/') && pathname.endsWith('/execute') && method === 'POST') {
    const actionId = pathname.slice('/api/v1/actions/'.length, pathname.length - '/execute'.length);
    const requestId = `req_act_exec_${Date.now()}`;
    const record = await actionEngine.executeAction(actionId, tenantId, userId, requestId);
    return { status: 200, data: record };
  }

  if (pathname.startsWith('/api/v1/actions/') && pathname.endsWith('/revert') && method === 'POST') {
    const actionId = pathname.slice('/api/v1/actions/'.length, pathname.length - '/revert'.length);
    const requestId = `req_act_rev_${Date.now()}`;
    const revertDraft = await actionEngine.revertAction(actionId, tenantId, userId, requestId);
    return { status: 201, data: revertDraft };
  }

  return undefined;
};
