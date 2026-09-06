import { test } from 'node:test';
import assert from 'node:assert';
import { AuditLogger } from '../src/governance/audit.logger.js';
import { BillingLedgerEngine } from '../src/billing/billing.ledger.js';
import { CreditEngine, computeCreditCost } from '../src/billing/credit.engine.js';
import { NagexPlatformApiServer } from '../src/server.js';
import { PolicyDecisionPoint } from '../src/identity/pdp.js';
import { DurableRuntimeEngine } from '../src/runtime/runtime.engine.js';
import { validateTenantResource, type TenantResource } from '../src/tenant/tenant.model.js';

test('1. Audit Logger Sensitive Data Masking Rule', () => {
  const logger = new AuditLogger();

  logger.logEvent({
    actor: { type: 'user', id: 'usr_admin' },
    tenant_id: 'ten_001',
    action: 'secret:bind',
    resource: { type: 'Secret', id: 'sec_123' },
    result: 'SUCCESS',
    request_id: 'req_audit_test',
    details: {
      secret: 'super_secret_raw_key', // Should be deleted/sanitized
      password: 'my_password',       // Should be deleted/sanitized
      raw_cot: 'thinking_steps...',   // Should be deleted/sanitized
      safe_meta: 'bind_successful',
    },
  });

  const logs = logger.getAuditLogs('ten_001');
  assert.strictEqual(logs.length, 1);
  assert.strictEqual(logs[0].details?.['secret'], undefined);
  assert.strictEqual(logs[0].details?.['password'], undefined);
  assert.strictEqual(logs[0].details?.['raw_cot'], undefined);
  assert.strictEqual(logs[0].details?.['safe_meta'], 'bind_successful');
});

test('2. Billing Ledger Engine Idempotency & Adjustment', () => {
  const billing = new BillingLedgerEngine();

  // 2a. Record Usage with Idempotency Key
  const usage = billing.recordUsage({
    tenant_id: 'ten_001',
    execution_id: 'exe_001',
    usage_type: 'MODEL_INPUT_TOKEN',
    quantity: 1000,
    unit: 'TOKENS',
    idempotency_key: 'idem_unique_123',
  });

  assert.ok(usage.usage_id.startsWith('usg_'));

  // 2b. Duplicate Usage Record attempt -> Should throw Conflict Error
  assert.throws(
    () => {
      billing.recordUsage({
        tenant_id: 'ten_001',
        execution_id: 'exe_001',
        usage_type: 'MODEL_INPUT_TOKEN',
        quantity: 1000,
        unit: 'TOKENS',
        idempotency_key: 'idem_unique_123', // Duplicate!
      });
    },
    (err: any) => err.code === 'DUPLICATE_USAGE_RECORD'
  );

  // 2c. Immutable Posted Entry & Adjustment
  billing.postLedgerEntry('acc_001', 'CHARGE', '15.5000', 'USD', 'Invoice #1');
  billing.adjustLedger('acc_001', '-2.0000', 'USD', 'Correction for credit');

  const entries = billing.getLedgerEntries('acc_001');
  assert.strictEqual(entries.length, 2);
  assert.strictEqual(entries[0].entry_type, 'CHARGE');
  assert.strictEqual(entries[1].entry_type, 'ADJUSTMENT');
});

test('2b. Credit Engine: computeCreditCost, charge/grant, insufficient balance (S-07 Phase 1)', () => {
  // S-07 §6.2 worked example: $0.060 internal cost -> 90 Credits.
  const cost = computeCreditCost({
    llm_cost_unit: 0.04,
    rag_unit: 0.004,
    tool_unit: 0.005,
    runtime_unit: 0.011,
  });
  assert.strictEqual(cost, 90);

  const billing = new BillingLedgerEngine();
  const credits = new CreditEngine(billing);

  // Charging before any grant fails closed rather than allowing negative balance.
  assert.throws(
    () => credits.chargeCredits('ten_credit_test', { llm_cost_unit: 0.04 }, 'exe_001'),
    (err: any) => err.code === 'BILLING_INSUFFICIENT_CREDIT' && err.category === 'QUOTA'
  );

  const granted = credits.grantCredits('ten_credit_test', 100, 'Initial account seed');
  assert.strictEqual(granted.credit_balance, 100);

  const { account, cost: chargedCost, ledger_entry } = credits.chargeCredits(
    'ten_credit_test',
    { llm_cost_unit: 0.04, rag_unit: 0.004, tool_unit: 0.005, runtime_unit: 0.011 },
    'exe_002'
  );
  assert.strictEqual(chargedCost, 90);
  assert.strictEqual(account.credit_balance, 10);
  assert.strictEqual(ledger_entry.entry_type, 'CREDIT_USAGE');
  assert.strictEqual(ledger_entry.amount, '90');

  // Ledger immutability (S-06 Rule 56) applies to Credit entries too -- both
  // the grant and the charge are posted, and nothing was rewritten in place.
  const entries = billing.getLedgerEntries(account.billing_account_id);
  assert.strictEqual(entries.length, 2);
  assert.strictEqual(entries[0].entry_type, 'CREDIT_GRANT');
  assert.strictEqual(entries[1].entry_type, 'CREDIT_USAGE');

  // Remaining balance (10) is below the next charge (90) -> insufficient.
  assert.throws(
    () => credits.chargeCredits('ten_credit_test', { llm_cost_unit: 0.04, rag_unit: 0.004, tool_unit: 0.005, runtime_unit: 0.011 }, 'exe_003'),
    (err: any) => err.code === 'BILLING_INSUFFICIENT_CREDIT'
  );
  // A failed charge must not have deducted anything.
  assert.strictEqual(credits.getOrCreateAccount('ten_credit_test').credit_balance, 10);
});

test('3. NAGEX Platform API Server Endpoints & Security Interception', async () => {
  const pdp = new PolicyDecisionPoint();
  const runtime = new DurableRuntimeEngine();
  const logger = new AuditLogger();
  const billing = new BillingLedgerEngine();

  const server = new NagexPlatformApiServer(pdp, runtime, logger, billing);

  // 3a. Missing Tenant Header -> Should return 401 TENANT_CONTEXT_MISSING
  const resNoTenant = await server.handleRequest({
    path: '/api/v1/executions',
    method: 'POST',
    headers: {},
  });
  assert.strictEqual(resNoTenant.status, 401);

  // 3b. Successful Execution Request with Tenant Header
  const resSuccess = await server.handleRequest({
    path: '/api/v1/executions',
    method: 'POST',
    headers: {
      'x-nagex-tenant': 'ten_001',
      'x-principal-id': 'usr_001',
      'x-request-id': 'req_exec_test',
    },
    body: { target_resource_id: 'agt_search' },
  });

  assert.strictEqual(resSuccess.status, 201);
  const data = (resSuccess.body as any).data;
  assert.strictEqual(data.tenant_id, 'ten_001');

  // Verify Audit Logged for API request
  const logs = logger.getAuditLogs('ten_001');
  assert.strictEqual(logs.length, 1);
  assert.strictEqual(logs[0].action, 'agent:execute');
});

test('4. Tenant Resource Specification Validation', () => {
  const actor = { type: 'user' as const, id: 'usr_platform_admin' };
  const baseTenant: TenantResource = {
    api_version: 'nagex/v1',
    kind: 'Tenant',
    metadata: {
      id: 'ten_valid_001',
      scope_type: 'PLATFORM',
      revision: 1,
      lifecycle_state: 'ACTIVE',
      created_at: '2026-08-01T00:00:00Z',
      updated_at: '2026-08-01T00:00:00Z',
      created_by: actor,
      updated_by: actor,
    },
    specification: {
      display_name: 'NAGEX Production Tenant',
      home_region: 'ap-northeast-2',
      isolation_profile: 'ISOLATED_DATA',
      maximum_autonomy_level: 'L2',
    },
    status: { state: 'ACTIVE' },
  };

  // 4a. Well-formed spec passes
  assert.doesNotThrow(() => validateTenantResource(baseTenant));

  // 4b. Missing home_region is rejected
  assert.throws(
    () => validateTenantResource({
      ...baseTenant,
      specification: { ...baseTenant.specification, home_region: '' },
    }),
    (err: any) => err.code === 'VALIDATION_ERROR'
  );

  // 4c. Invalid isolation_profile is rejected
  assert.throws(
    () => validateTenantResource({
      ...baseTenant,
      specification: { ...baseTenant.specification, isolation_profile: 'GARBAGE' as any },
    }),
    (err: any) => err.code === 'VALIDATION_ERROR'
  );

  // 4d. Invalid maximum_autonomy_level is rejected
  assert.throws(
    () => validateTenantResource({
      ...baseTenant,
      specification: { ...baseTenant.specification, maximum_autonomy_level: 'L9' as any },
    }),
    (err: any) => err.code === 'VALIDATION_ERROR'
  );
});
