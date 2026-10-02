import test from 'node:test';
import assert from 'node:assert';
import { planStore, savePlan, getPlan, listPlans, type PersistedPlan } from '../src/planning/plan.store.js';

test('Plan Persistence - SAVE and GET', () => {
  const plan: PersistedPlan = {
    id: 'plan_test_001',
    tenantId: 'tenant_1',
    userId: 'user_1',
    title: 'Test Plan',
    originalPrompt: 'Do a test',
    status: 'READY',
    steps: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  savePlan(plan);
  
  const fetched = getPlan('plan_test_001');
  assert.ok(fetched);
  assert.strictEqual(fetched.id, 'plan_test_001');
  assert.strictEqual(fetched.title, 'Test Plan');
});

test('Plan Persistence - TENANT ISOLATION', () => {
  const plan1: PersistedPlan = {
    id: 'plan_test_002',
    tenantId: 'tenant_A',
    userId: 'user_1',
    title: 'Plan A',
    originalPrompt: '',
    status: 'READY',
    steps: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const plan2: PersistedPlan = {
    id: 'plan_test_003',
    tenantId: 'tenant_B',
    userId: 'user_1',
    title: 'Plan B',
    originalPrompt: '',
    status: 'READY',
    steps: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  savePlan(plan1);
  savePlan(plan2);

  const tenantAPlans = listPlans('tenant_A', 'user_1');
  assert.ok(tenantAPlans.some(p => p.id === 'plan_test_002'));
  assert.ok(!tenantAPlans.some(p => p.id === 'plan_test_003'));
});
