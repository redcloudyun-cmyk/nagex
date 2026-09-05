import { test } from 'node:test';
import assert from 'node:assert';
import { generateResourceId } from '../src/common/utils.js';
import { PolicyDecisionPoint, describeDeniedDecision } from '../src/identity/pdp.js';
import { PERMISSION_RISK } from '../src/identity/permission.registry.js';
import { handleApiRequest } from '../src/server_web.js';
import { ModelRouter, type ModelCandidate } from '../src/model-gateway/model-router.js';
import { DurableRuntimeEngine } from '../src/runtime/runtime.engine.js';

test('1. Resource ID Generation & Prefix Validation', () => {
  const agentId = generateResourceId('agt');
  assert.ok(agentId.startsWith('agt_'));

  const tenantId = generateResourceId('ten');
  assert.ok(tenantId.startsWith('ten_'));
});

test('1b. Permission Registry loads real risk classifications from specs/permissions/*.yaml', () => {
  // specs/permissions/core.permissions.yaml (6 entries) + agent.permissions.yaml
  // (5 entries) = 11. This count check fails loudly if the YAML loader
  // silently drops entries or falls back to a stale hardcoded set.
  assert.strictEqual(Object.keys(PERMISSION_RISK).length, 11);

  assert.strictEqual(PERMISSION_RISK['tenant:delete'], 'CRITICAL');
  assert.strictEqual(PERMISSION_RISK['secret:manage'], 'CRITICAL');
  assert.strictEqual(PERMISSION_RISK['agent:execute'], 'HIGH');
  assert.strictEqual(PERMISSION_RISK['agent:read'], 'LOW');
});

test('2. Policy Decision Point (PDP) Authorization Evaluation', () => {
  const pdp = new PolicyDecisionPoint();

  // Test 2a. Allowed Action
  const allowDecision = pdp.evaluate({
    principal: { type: 'user', id: 'usr_123' },
    tenant_context: { tenant_id: 'ten_001', scope_type: 'TENANT' },
    action: 'agent:execute',
    resource_type: 'Agent',
    resource_id: 'agt_999',
    resource_tenant_id: 'ten_001',
    principal_permissions: ['agent:execute'],
  });
  assert.strictEqual(allowDecision.decision, 'ALLOW');

  // Test 2b. Cross-Tenant Default Deny
  const crossTenantDecision = pdp.evaluate({
    principal: { type: 'user', id: 'usr_123' },
    tenant_context: { tenant_id: 'ten_001', scope_type: 'TENANT' },
    action: 'agent:read',
    resource_type: 'Agent',
    resource_id: 'agt_999',
    resource_tenant_id: 'ten_002', // Different Tenant!
    principal_permissions: ['agent:read'],
  });
  assert.strictEqual(crossTenantDecision.decision, 'DENY');
  assert.strictEqual(crossTenantDecision.reason_code, 'CROSS_TENANT_ACCESS_DENIED');

  // Test 2c. High-Risk Action Approval Requirement
  const conditionalDecision = pdp.evaluate({
    principal: { type: 'user', id: 'usr_123' },
    tenant_context: { tenant_id: 'ten_001', scope_type: 'TENANT' },
    action: 'agent:publish',
    resource_type: 'Agent',
    resource_id: 'agt_999',
    resource_tenant_id: 'ten_001',
    principal_permissions: ['agent:publish'],
  });
  assert.strictEqual(conditionalDecision.decision, 'CONDITIONAL');
  assert.strictEqual(conditionalDecision.reason_code, 'REQUIRE_APPROVAL');

  // Test 2d. CRITICAL-risk actions (per specs/permissions/core.permissions.yaml)
  // require approval even though they don't match either hardcoded verb.
  const criticalDecision = pdp.evaluate({
    principal: { type: 'user', id: 'usr_123' },
    tenant_context: { tenant_id: 'ten_001', scope_type: 'TENANT' },
    action: 'secret:manage',
    resource_type: 'Secret',
    resource_id: 'sec_999',
    principal_permissions: ['secret:manage'],
  });
  assert.strictEqual(criticalDecision.decision, 'CONDITIONAL');
  assert.strictEqual(criticalDecision.reason_code, 'REQUIRE_APPROVAL');

  // Test 2e. HIGH-risk (but not CRITICAL) actions stay ALLOW — the console's
  // core task-execution flow depends on agent:execute never being gated.
  const highRiskDecision = pdp.evaluate({
    principal: { type: 'user', id: 'usr_123' },
    tenant_context: { tenant_id: 'ten_001', scope_type: 'TENANT' },
    action: 'tenant:create',
    resource_type: 'Tenant',
    resource_id: 'ten_new',
    principal_permissions: ['tenant:create'],
  });
  assert.strictEqual(highRiskDecision.decision, 'ALLOW');

  // Test 2f. describeDeniedDecision must keep CONDITIONAL distinguishable
  // from DENY in HTTP status, error code, and audit result — the three
  // call sites (server.ts, server_web.ts, agent.executor.ts) all delegate
  // to this single helper specifically so they can't drift apart again.
  const deniedOutcome = describeDeniedDecision({ decision: 'DENY', reason_code: 'PERMISSION_MISSING' });
  assert.strictEqual(deniedOutcome.httpStatus, 403);
  assert.strictEqual(deniedOutcome.errorCode, 'PERMISSION_DENIED');
  assert.strictEqual(deniedOutcome.auditResult, 'DENIED');

  const conditionalOutcome = describeDeniedDecision({ decision: 'CONDITIONAL', reason_code: 'REQUIRE_APPROVAL' });
  assert.strictEqual(conditionalOutcome.httpStatus, 202);
  assert.strictEqual(conditionalOutcome.errorCode, 'APPROVAL_REQUIRED');
  assert.strictEqual(conditionalOutcome.auditResult, 'PENDING_APPROVAL');
});

test('2g. server_web handleApiRequest reads tenant/principal from headers, not hardcoded constants', () => {
  // Default (no headers) still works for the un-authenticated demo console
  const defaulted = handleApiRequest('GET', '/api/v1/health', null);
  assert.strictEqual(defaulted.status, 200);

  // A caller-supplied X-AGEX-Tenant must actually end up on the created execution
  const withHeaders = handleApiRequest(
    'POST',
    '/api/v1/executions',
    { agent_id: 'agt_code_reviewer', objective: 'test' },
    { 'x-agex-tenant': 'ten_custom_01', 'x-principal-id': 'usr_custom_01', 'x-request-id': 'req_correlated_01' }
  );
  assert.strictEqual(withHeaders.status, 201);
  assert.strictEqual((withHeaders.data as any).tenant_id, 'ten_custom_01');

  // A caller-supplied X-Request-Id must be echoed back for correlation
  // rather than a fresh server-generated id replacing it.
  assert.strictEqual((withHeaders.data as any).request_id, 'req_correlated_01');
});

test('2h. server_web billing: agent execution charges real credits via CreditEngine (S-07 Phase 1)', () => {
  const tenantHeaders = { 'x-agex-tenant': 'ten_billing_test_01', 'x-principal-id': 'usr_billing_test' };

  // A fresh tenant is lazily seeded with the initial grant.
  const initialUsage = handleApiRequest('GET', '/api/v1/billing/usage', null, tenantHeaders);
  assert.strictEqual(initialUsage.status, 200);
  assert.strictEqual((initialUsage.data as any).remaining_credits, 10000);
  assert.strictEqual((initialUsage.data as any).used_credits, 0);

  // Executing an agent must deduct the S-07 §6.2 worked-example charge (90
  // Credits) from the real ledger-backed balance, not a hardcoded mock.
  const exec = handleApiRequest(
    'POST',
    '/api/v1/executions',
    { agent_id: 'agt_code_reviewer', objective: 'billing test' },
    tenantHeaders
  );
  assert.strictEqual(exec.status, 201);

  const usageAfterExec = handleApiRequest('GET', '/api/v1/billing/usage', null, tenantHeaders);
  assert.strictEqual((usageAfterExec.data as any).remaining_credits, 9910);
  assert.strictEqual((usageAfterExec.data as any).used_credits, 90);

  // Draining the balance to below one charge (90 Credits) must return a
  // clean 402 BILLING_INSUFFICIENT_CREDIT instead of throwing/crashing.
  // 9910 remaining / 90 per charge = 110 more successful charges (9900
  // spent, 10 left); the 111th must fail.
  let lastResult;
  for (let i = 0; i < 111; i++) {
    lastResult = handleApiRequest(
      'POST',
      '/api/v1/executions',
      { agent_id: 'agt_code_reviewer', objective: 'drain' },
      tenantHeaders
    );
  }
  assert.strictEqual(lastResult!.status, 402);
  assert.strictEqual((lastResult!.data as any).error, 'BILLING_INSUFFICIENT_CREDIT');
});

test('2i. server_web POST /api/v1/billing/estimate matches the real charge amount (S-07 §11.4)', () => {
  const estimate = handleApiRequest('POST', '/api/v1/billing/estimate', {});
  assert.strictEqual(estimate.status, 200);
  const data = estimate.data as any;
  assert.strictEqual(data.providerMode, 'AGEX_MANAGED');
  assert.strictEqual(data.estimatedCredits, 90);
  assert.ok(Math.abs(data.estimatedProviderCost - 0.06) < 1e-9);
  assert.strictEqual(data.currency, 'USD');

  // The estimate must never disagree with what an actual execution charges.
  const tenantHeaders = { 'x-agex-tenant': 'ten_estimate_test', 'x-principal-id': 'usr_estimate_test' };
  handleApiRequest('POST', '/api/v1/executions', { agent_id: 'agt_code_reviewer', objective: 'estimate check' }, tenantHeaders);
  const usage = handleApiRequest('GET', '/api/v1/billing/usage', null, tenantHeaders);
  assert.strictEqual((usage.data as any).used_credits, data.estimatedCredits);
});

test('3. Model Router Security-First Selection Order', () => {
  const candidates: ModelCandidate[] = [
    {
      model_id: 'gpt-4o',
      provider_id: 'prv_openai',
      provider_class: 'DIRECT_APPROVED',
      capabilities: ['TOOL_CALLING', 'STRUCTURED_OUTPUT'],
      supported_classifications: ['PUBLIC', 'INTERNAL'],
      region: ['us-central1'],
      latency_ms: 300,
      healthy: true,
      cost_per_1k_tokens: 0.015,
    },
    {
      model_id: 'claude-3-5-sonnet',
      provider_id: 'prv_anthropic',
      provider_class: 'ENTERPRISE_APPROVED',
      capabilities: ['TOOL_CALLING', 'STRUCTURED_OUTPUT'],
      supported_classifications: ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL'],
      region: ['us-east1'],
      latency_ms: 250,
      healthy: true,
      cost_per_1k_tokens: 0.02,
    },
  ];

  const router = new ModelRouter(candidates);

  // Request requiring CONFIDENTIAL classification
  const selected = router.selectModel({
    required_capabilities: ['TOOL_CALLING'],
    data_classification: 'CONFIDENTIAL',
  });

  assert.strictEqual(selected.model_id, 'claude-3-5-sonnet');

  // Region/Residency must be a hard constraint (S-04 §2 step 5), not a soft
  // preference that silently falls back to ignoring it.
  assert.throws(
    () => router.selectModel({
      required_capabilities: ['TOOL_CALLING'],
      data_classification: 'PUBLIC',
      target_region: 'eu-west1',
    }),
    (err: any) => err.code === 'REGION_CONSTRAINT_VIOLATED'
  );

  // Provider Trust Class (S-04 §2 step 6) must outrank latency/cost among
  // otherwise-tied candidates.
  const trustCandidates: ModelCandidate[] = [
    {
      model_id: 'aggregator-fast-cheap',
      provider_id: 'prv_aggregator',
      provider_class: 'AGGREGATOR',
      capabilities: ['TOOL_CALLING'],
      supported_classifications: ['PUBLIC'],
      region: ['us-central1'],
      latency_ms: 50,
      healthy: true,
      cost_per_1k_tokens: 0.001,
    },
    {
      model_id: 'private-slower-pricier',
      provider_id: 'prv_private',
      provider_class: 'PRIVATE',
      capabilities: ['TOOL_CALLING'],
      supported_classifications: ['PUBLIC'],
      region: ['us-central1'],
      latency_ms: 500,
      healthy: true,
      cost_per_1k_tokens: 0.05,
    },
  ];
  const trustRouter = new ModelRouter(trustCandidates);
  const trustSelected = trustRouter.selectModel({
    required_capabilities: ['TOOL_CALLING'],
    data_classification: 'PUBLIC',
  });
  assert.strictEqual(trustSelected.model_id, 'private-slower-pricier');
});

test('4. Durable Runtime Engine Execution & Checkpoint Restore', () => {
  const engine = new DurableRuntimeEngine();
  const tenantContext = { tenant_id: 'ten_001', scope_type: 'TENANT' as const };

  const exe = engine.createExecution(tenantContext, 'agt_123');
  assert.strictEqual(exe.state, 'CREATED');

  const running = engine.transitionState(exe.id, 'RUNNING');
  assert.strictEqual(running.state, 'RUNNING');

  const restored = engine.restoreCheckpoint(exe.id, 'chk_001');
  assert.strictEqual(restored.checkpoint_id, 'chk_001');
  assert.strictEqual(restored.attempt, 2);
});

test('5. Durable Runtime: Bounded Retry, Terminal State Guard & Tenant Ownership', () => {
  const engine = new DurableRuntimeEngine();
  const tenantContext = { tenant_id: 'ten_001', scope_type: 'TENANT' as const };

  // 5a. Bounded retry: restoreCheckpoint must eventually refuse and fail the execution
  const exe = engine.createExecution(tenantContext, 'agt_retry_test');
  for (let i = 0; i < 4; i++) {
    engine.restoreCheckpoint(exe.id, `chk_${i}`);
  }
  assert.throws(
    () => engine.restoreCheckpoint(exe.id, 'chk_final'),
    (err: any) => err.code === 'MAX_RETRY_ATTEMPTS_EXCEEDED'
  );

  // 5b. Terminal state guard: a FAILED execution cannot be mutated further
  assert.throws(
    () => engine.transitionState(exe.id, 'RUNNING'),
    (err: any) => err.code === 'EXECUTION_ALREADY_TERMINAL'
  );

  // 5c. Cross-tenant ownership check on state mutation
  const exe2 = engine.createExecution(tenantContext, 'agt_owner_test');
  assert.throws(
    () => engine.transitionState(exe2.id, 'RUNNING', undefined, 'ten_other'),
    (err: any) => err.code === 'CROSS_TENANT_ACCESS_DENIED'
  );

  // Same-tenant caller is still permitted
  const running = engine.transitionState(exe2.id, 'RUNNING', undefined, tenantContext.tenant_id);
  assert.strictEqual(running.state, 'RUNNING');
});

test('6. server_web GET /api/v1/vcs/status returns real, well-shaped repo data', () => {
  const result = handleApiRequest('GET', '/api/v1/vcs/status', null);
  assert.strictEqual(result.status, 200);

  const data = result.data as {
    available: boolean;
    branch: string | null;
    changed_files: Array<{ path: string; status: string }>;
    commits: Array<{ hash: string; author: string; date: string; message: string }>;
  };

  assert.strictEqual(typeof data.available, 'boolean');
  assert.ok(Array.isArray(data.changed_files));
  assert.ok(Array.isArray(data.commits));

  // This repo is a real git checkout in every environment this test runs in
  // (local dev and CI, which does a real `actions/checkout`), so when git is
  // available the response must reflect an actual repo, not empty stand-ins.
  if (data.available) {
    assert.strictEqual(typeof data.branch, 'string');
    assert.ok(data.branch!.length > 0);
    assert.ok(data.commits.length > 0);
    const first = data.commits[0];
    assert.strictEqual(typeof first.hash, 'string');
    assert.strictEqual(typeof first.author, 'string');
    assert.strictEqual(typeof first.message, 'string');
    assert.ok(!Number.isNaN(Date.parse(first.date)));
  }
});
