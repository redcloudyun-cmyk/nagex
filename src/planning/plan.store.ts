import { FileRecordStore, resolveNagexDataDir } from '../governance/file-record.store.js';
import type { PlanStepNecessity } from '../model-gateway/ai-service.js';

// R24.8B — what a stored plan keeps per step: DESCRIPTIVE content only. Resolver-derived and execution
// state (resolved tool/skill ids, readiness, approval flags, results, parameters) is never persisted from a
// client and is not part of this shape (legacy records may still carry extra fields on disk; they are ignored).
export interface StoredPlanStep {
  step: number;
  title: string;
  reasoning?: string;
  skill?: string;
  tool?: string;
  necessity: PlanStepNecessity;
  dependsOn: number[];
}

export interface PersistedPlan {
  id: string;
  tenantId: string;
  userId: string;
  title: string;
  originalPrompt: string;
  status: 'DRAFT' | 'READY' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED' | 'FAILED';
  steps: StoredPlanStep[];
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
