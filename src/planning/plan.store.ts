import { FileRecordStore, resolveNagexDataDir } from '../governance/file-record.store.js';
import type { ResolvedPlanStep } from './plan-resolver.js';

export interface PersistedPlan {
  id: string;
  tenantId: string;
  userId: string;
  title: string;
  originalPrompt: string;
  status: 'DRAFT' | 'READY' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED' | 'FAILED';
  steps: ResolvedPlanStep[];
  createdAt: string;
  updatedAt: string;
}

const dir = resolveNagexDataDir('plans', 'NAGEX_PLANS_DIR');
export const planStore = new FileRecordStore<PersistedPlan>(dir, (val): val is PersistedPlan => {
  const v = val as Partial<PersistedPlan>;
  return typeof v === 'object' && v !== null && typeof v.id === 'string' && typeof v.tenantId === 'string';
});

export function savePlan(plan: PersistedPlan): void {
  plan.updatedAt = new Date().toISOString();
  planStore.write(plan.id, plan);
}

export function getPlan(id: string): PersistedPlan | undefined {
  return planStore.read(id) || undefined;
}

export function listPlans(tenantId: string, userId: string): PersistedPlan[] {
  return planStore.readAll().filter((p: PersistedPlan) => p.tenantId === tenantId && p.userId === userId);
}
