import type { ApiResult, SyncRouteRegistrar } from '../http-types.js';
import { planStore, listPlans, savePlan, getPlan, type PersistedPlan } from '../../planning/plan.store.js';
import { randomUUID } from 'node:crypto';

export const handlePlanRoutes: SyncRouteRegistrar<Record<string, never>> = (method, pathname, body, headers): ApiResult | undefined => {
  const tenantId = Array.isArray(headers?.['x-nagex-tenant']) ? headers?.['x-nagex-tenant'][0] : (headers?.['x-nagex-tenant'] || 'default-tenant');
  const userId = Array.isArray(headers?.['x-principal-id']) ? headers?.['x-principal-id'][0] : (headers?.['x-principal-id'] || 'default-user');

  if (pathname === '/api/v1/plans' && method === 'GET') {
    const plans = listPlans(tenantId, userId);
    // Sort by descending createdAt
    plans.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return { status: 200, data: { plans, total: plans.length } };
  }

  if (pathname === '/api/v1/plans' && method === 'POST') {
    if (!body || typeof body !== 'object') {
      return { status: 400, data: { error: 'Invalid plan data' } };
    }
    const b = body as any;
    const plan: PersistedPlan = {
      id: b.id || `plan_${randomUUID()}`,
      tenantId,
      userId,
      title: b.title || b.goal || 'Untitled Plan',
      originalPrompt: b.originalPrompt || '',
      status: b.status || 'READY',
      steps: b.steps || [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    savePlan(plan);
    return { status: 200, data: plan };
  }

  if (pathname.startsWith('/api/v1/plans/') && method === 'GET') {
    const id = pathname.split('/').pop() || '';
    if (id === 'resolve') return undefined; // Handled by conversation.routes.ts
    const plan = getPlan(id);
    if (!plan || plan.tenantId !== tenantId || plan.userId !== userId) {
      return { status: 404, data: { error: 'Plan not found' } };
    }
    return { status: 200, data: plan };
  }
  
  if (pathname.startsWith('/api/v1/plans/') && method === 'PUT') {
    const id = pathname.split('/').pop() || '';
    if (id === 'resolve') return undefined;
    const plan = getPlan(id);
    if (!plan || plan.tenantId !== tenantId || plan.userId !== userId) {
      return { status: 404, data: { error: 'Plan not found' } };
    }
    const b = body as any;
    if (b.status) plan.status = b.status;
    if (b.steps) plan.steps = b.steps;
    savePlan(plan);
    return { status: 200, data: plan };
  }

  return undefined;
};
