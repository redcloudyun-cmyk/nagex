import { test } from 'node:test';
import assert from 'node:assert';
import { TaskDispatcher } from '../src/runtime/task.dispatcher.js';
import { DurableRuntimeEngine } from '../src/runtime/runtime.engine.js';
import { RuntimeReconciler } from '../src/runtime/reconciler.js';
import { ToolInvoker } from '../src/agent/tool.invoker.js';
import { PolicyDecisionPoint } from '../src/identity/pdp.js';
import { AgentExecutor } from '../src/agent/agent.executor.js';
import { MultiAgentOrchestrator } from '../src/agent/multi-agent.orchestrator.js';

test('1. Task Dispatcher & Lease Acquisition', () => {
  const dispatcher = new TaskDispatcher();
  const tenantContext = { tenant_id: 'ten_001', scope_type: 'TENANT' as const };
  const task = dispatcher.createTask(tenantContext, 'exe_100', 'MODEL_INFERENCE');

  assert.strictEqual(task.status, 'QUEUED');

  const leased = dispatcher.acquireLease(task.id, 'worker_1', 5000);
  assert.strictEqual(leased.status, 'LEASED');
  assert.strictEqual(leased.lease_owner, 'worker_1');

  const completed = dispatcher.completeTask(task.id, 'worker_1');
  assert.strictEqual(completed.status, 'SUCCEEDED');

  // A completed (terminal) task must never be re-leased
  assert.throws(
    () => dispatcher.acquireLease(task.id, 'worker_2', 5000),
    (err: any) => err.code === 'TASK_ALREADY_TERMINAL'
  );

  // Cross-tenant lease attempts are rejected
  const otherTenantTask = dispatcher.createTask(tenantContext, 'exe_200', 'MODEL_INFERENCE');
  assert.throws(
    () => dispatcher.acquireLease(otherTenantTask.id, 'worker_3', 5000, 'ten_other'),
    (err: any) => err.code === 'CROSS_TENANT_ACCESS_DENIED'
  );
});

test('2. Runtime Reconciler Worker Crash Recovery', () => {
  const dispatcher = new TaskDispatcher();
  const engine = new DurableRuntimeEngine();
  const tenantContext = { tenant_id: 'ten_001', scope_type: 'TENANT' as const };

  const exe = engine.createExecution(tenantContext, 'agt_123');
  const task = dispatcher.createTask(tenantContext, exe.id, 'PLUGIN_EXECUTION');

  // Acquire lease with negative duration to simulate immediate lease expiration / worker crash
  dispatcher.acquireLease(task.id, 'crashed_worker', -100);

  const reconciler = new RuntimeReconciler(dispatcher, engine);
  const recovered = reconciler.reconcileExpiredTasks();

  assert.strictEqual(recovered.length, 1);
  assert.strictEqual(recovered[0].status, 'QUEUED');

  // Execution attempt should be restored and incremented to 2 by Reconciler
  const updatedExe = engine.restoreCheckpoint(exe.id, 'chk_check');
  assert.strictEqual(updatedExe.attempt, 3);
});

test('3. Tool Invoker & Autonomy Level Safety Gate', async () => {
  const invoker = new ToolInvoker();

  invoker.registerTool({
    id: 'tool_delete_db',
    name: 'Delete Production Database',
    side_effect: 'IRREVERSIBLE_WRITE',
    handler: async () => ({ deleted: true }),
  });

  // L1 Agent attempt to execute IRREVERSIBLE_WRITE tool -> Should throw AGEX Policy Error
  await assert.rejects(
    async () => {
      await invoker.invokeTool('tool_delete_db', {}, 'L1');
    },
    (err: any) => err.code === 'AUTONOMY_LEVEL_EXCEEDED'
  );

  // L2 Agent attempt WITHOUT approval -> must still be blocked (MASTER.md
  // Rule 17: L2 and above go through an approval procedure, not a free pass)
  await assert.rejects(
    async () => {
      await invoker.invokeTool('tool_delete_db', {}, 'L2');
    },
    (err: any) => err.code === 'APPROVAL_REQUIRED'
  );

  // L2 Agent attempt WITH explicit approval -> Allowed to invoke
  const result = await invoker.invokeTool('tool_delete_db', {}, 'L2', true);
  assert.strictEqual(result.status, 'SUCCESS');
});

test('4. Agent Executor End-to-End Execution Flow', async () => {
  const pdp = new PolicyDecisionPoint();
  const invoker = new ToolInvoker();

  invoker.registerTool({
    id: 'tool_search',
    name: 'Search Knowledge Base',
    side_effect: 'READ_ONLY',
    handler: async (params) => ({ query: params.q, results: ['doc1', 'doc2'] }),
  });

  const executor = new AgentExecutor(pdp, invoker);

  const result = await executor.executeToolAction(
    { type: 'user', id: 'usr_001' },
    { tenant_id: 'ten_001', scope_type: 'TENANT' },
    {
      agent_id: 'agt_search_agent',
      autonomy_level: 'L2',
      permissions: ['agent:execute'],
    },
    'tool_search',
    { q: 'AGEX Architecture' }
  );

  assert.strictEqual(result.status, 'SUCCESS');
  assert.strictEqual(result.side_effect, 'READ_ONLY');
});

test('5. Multi-Agent Delegation Scope Cannot Exceed Parent Permissions', () => {
  const orchestrator = new MultiAgentOrchestrator();

  // Child requests a permission the parent never had -> excluded from the
  // effective scope (self-elevation is impossible)
  const scope = orchestrator.createDelegatedScope({
    parent_agent_id: 'agt_parent',
    child_agent_id: 'agt_child',
    parent_permissions: ['knowledge:read', 'agent:execute'],
    child_permissions: ['knowledge:read', 'billing:manage'],
    delegated_scope: ['knowledge:read', 'billing:manage'],
  });
  assert.deepStrictEqual(scope.effective_permissions, ['knowledge:read']);
  assert.ok(scope.delegation_id.startsWith('dlg_'));

  // Empty intersection -> rejected outright
  assert.throws(
    () => orchestrator.createDelegatedScope({
      parent_agent_id: 'agt_parent',
      child_agent_id: 'agt_child',
      parent_permissions: ['agent:execute'],
      child_permissions: ['billing:manage'],
      delegated_scope: ['billing:manage'],
    }),
    (err: any) => err.code === 'EMPTY_DELEGATED_SCOPE'
  );
});
