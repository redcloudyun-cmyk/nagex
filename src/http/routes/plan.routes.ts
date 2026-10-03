import { randomUUID } from 'node:crypto';
import type { ApiResult, SyncRouteRegistrar } from '../http-types.js';
import { listPlans, savePlan, getPlan, type PersistedPlan, type StoredPlanStep } from '../../planning/plan.store.js';
import type { IdentityStore } from '../../identity/identity.store.js';
import type { SessionStore } from '../../sessions/session.store.js';
import { callerIdentity, resolveAuthenticatedIdentity } from '../request-identity.js';

// R24.8B — Plan ownership and update authority.
//
// Field classes for a stored plan:
//   SYSTEM_MANAGED     id, tenantId, userId, createdAt, updatedAt
//                      -> always set by the server (the id is a fresh server-generated UUID; a
//                         client-supplied id, tenant or owner is never read, so a client can neither
//                         pick an existing plan id nor name another owner/tenant).
//   USER_EDITABLE      title, originalPrompt (create only), descriptive step content
//                      (step number, title, reasoning, skill, tool, necessity, dependsOn),
//                      and status transitions between DRAFT, READY and CANCELLED.
//   EXECUTION_MANAGED  status IN_PROGRESS / COMPLETED / FAILED, any per-step execution state,
//                      readiness, approval or result metadata, and the resolver-derived step fields
//                      (resolvedToolId, executionReadiness, approvalRequired, parameters, ...).
//                      -> never accepted from a client; only an execution/approval path may write them.
//
// Mutations (POST/PUT) require a real authenticated session: the legacy default-principal fallback
// does not apply to them. Reads keep the legacy header identity (recorded SECURITY_GATE debt).

export interface PlanRouteDeps {
  sessionStore?: SessionStore;
  identityStore?: IdentityStore;
}

const USER_STATUSES = new Set(['DRAFT', 'READY', 'CANCELLED']);
const EXECUTION_STATUSES = new Set(['IN_PROGRESS', 'COMPLETED', 'FAILED']);
const MAX_STEPS = 50;

function str(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
}

// Keeps ONLY descriptive step content. Everything else a client sends (statuses, results, readiness,
// approval flags, resolved tool/skill ids, parameters) is dropped, never stored.
export function sanitizeSteps(raw: unknown): StoredPlanStep[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_STEPS).map((entry, index) => {
    const s = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    const dependsOn = Array.isArray(s.dependsOn) ? s.dependsOn.filter((n): n is number => Number.isInteger(n) && n > 0 && n <= MAX_STEPS).slice(0, 20) : [];
    const step: StoredPlanStep = {
      step: Number.isInteger(s.step) && (s.step as number) > 0 ? (s.step as number) : index + 1,
      title: str(s.title, 200) ?? str(s.action, 200) ?? `Step ${index + 1}`,
      necessity: s.necessity === 'OPTIONAL' ? 'OPTIONAL' : 'REQUIRED',
      dependsOn,
    };
    const reasoning = str(s.reasoning, 1000); if (reasoning) step.reasoning = reasoning;
    const skill = str(s.skill, 100); if (skill) step.skill = skill;
    const tool = str(s.tool, 100); if (tool) step.tool = tool;
    return step;
  });
}

export const handlePlanRoutes: SyncRouteRegistrar<PlanRouteDeps> = (method, pathname, body, headers, _query, deps): ApiResult | undefined => {
  // Server-owned identity for every mutation.
  const mutationIdentity = () => (deps?.sessionStore && deps?.identityStore
    ? resolveAuthenticatedIdentity(headers, { sessionStore: deps.sessionStore, identityStore: deps.identityStore })
    : null);
  const authRequired: ApiResult = { status: 401, data: { error: 'AUTHENTICATION_REQUIRED', message: 'Sign in to create or change plans.' } };

  if (pathname === '/api/v1/plans' && method === 'GET') {
    const { tenantId: readTenant, principalId: readUser } = callerIdentity(headers);
    const plans = listPlans(readTenant, readUser);
    plans.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return { status: 200, data: { plans, total: plans.length } };
  }

  if (pathname === '/api/v1/plans' && method === 'POST') {
    const identity = mutationIdentity();
    if (!identity) return authRequired;
    if (!body || typeof body !== 'object') {
      return { status: 400, data: { error: 'INVALID_PLAN', message: 'Invalid plan data.' } };
    }
    const b = body as Record<string, unknown>;
    // Always a fresh server-generated id: a client-supplied `id` (or tenantId/userId/status/createdAt) is ignored.
    const now = new Date().toISOString();
    const plan: PersistedPlan = {
      id: `plan_${randomUUID()}`,
      tenantId: identity.tenantId,
      userId: identity.userId,
      title: str(b.title, 200) ?? str(b.goal, 200) ?? 'Untitled Plan',
      originalPrompt: str(b.originalPrompt, 4000) ?? '',
      status: 'READY',
      steps: sanitizeSteps(b.steps),
      createdAt: now,
      updatedAt: now,
    };
    savePlan(plan);
    return { status: 200, data: plan };
  }

  if (pathname.startsWith('/api/v1/plans/') && method === 'GET') {
    const id = pathname.split('/').pop() || '';
    if (id === 'resolve') return undefined; // Handled by conversation.routes.ts
    const { tenantId: readTenant, principalId: readUser } = callerIdentity(headers);
    const plan = getPlan(id);
    if (!plan || plan.tenantId !== readTenant || plan.userId !== readUser) {
      return { status: 404, data: { error: 'Plan not found' } };
    }
    return { status: 200, data: plan };
  }

  if (pathname.startsWith('/api/v1/plans/') && method === 'PUT') {
    const id = pathname.split('/').pop() || '';
    if (id === 'resolve') return undefined;
    const identity = mutationIdentity();
    if (!identity) return authRequired;
    const plan = getPlan(id);
    // Foreign and unknown ids are the same 404: ownership is never revealed.
    if (!plan || plan.tenantId !== identity.tenantId || plan.userId !== identity.userId) {
      return { status: 404, data: { error: 'Plan not found' } };
    }
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    if (EXECUTION_STATUSES.has(plan.status)) {
      return { status: 409, data: { error: 'PLAN_STATE_LOCKED', message: 'This plan is managed by execution and cannot be edited.' } };
    }
    if (b.status !== undefined) {
      if (typeof b.status !== 'string' || EXECUTION_STATUSES.has(b.status) || !USER_STATUSES.has(b.status)) {
        return { status: 400, data: { error: 'PLAN_STATUS_NOT_EDITABLE', message: 'Only DRAFT, READY or CANCELLED can be set by the user; execution states are managed by NAgex.' } };
      }
      plan.status = b.status as PersistedPlan['status'];
    }
    const title = str(b.title, 200);
    if (title) plan.title = title;
    if (b.steps !== undefined) plan.steps = sanitizeSteps(b.steps);
    savePlan(plan);
    return { status: 200, data: plan };
  }

  return undefined;
};
