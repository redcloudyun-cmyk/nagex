import { test } from 'node:test';
import assert from 'node:assert';
import { DurableRuntimeEngine } from '../src/runtime/runtime.engine.js';
import { WorkflowEngine, type WorkflowDefinition } from '../src/workflow/workflow.engine.js';
import { KnowledgeEngine, verifyGroundedCitations } from '../src/context/knowledge.engine.js';
import { MemoryEngine } from '../src/context/memory.engine.js';
import { PluginFramework } from '../src/plugin/plugin.framework.js';

test('1. Workflow Engine Step Execution & Human Approval Pause', async () => {
  const runtime = new DurableRuntimeEngine();
  const wfEngine = new WorkflowEngine(runtime);
  const tenantContext = { tenant_id: 'ten_001', scope_type: 'TENANT' as const };

  const workflow: WorkflowDefinition = {
    id: 'wfl_approval_test',
    steps: [
      { id: 'step_1', type: 'AGENT', name: 'Analyze Task' },
      { id: 'step_2', type: 'APPROVAL', name: 'Human Manager Approval' },
      { id: 'step_3', type: 'END', name: 'Finish' },
    ],
    edges: [
      { from: 'step_1', to: 'step_2' },
      { from: 'step_2', to: 'step_3' },
    ],
  };

  const result = await wfEngine.executeWorkflow(tenantContext, workflow, {});

  assert.strictEqual(result.execution.state, 'WAITING');
  assert.strictEqual(result.execution.waiting_reason, 'APPROVAL');
  const step2Result = result.step_results['step_2'] as { status: string };
  assert.strictEqual(step2Result.status, 'WAITING_FOR_HUMAN_APPROVAL');

  // waiting_reason must not linger once the execution resumes past WAITING
  const resumed = runtime.transitionState(result.execution.id, 'RUNNING', undefined, tenantContext.tenant_id);
  assert.strictEqual(resumed.waiting_reason, null);
});

test('1b. Workflow Engine rejects malformed graphs instead of silently completing', async () => {
  const runtime = new DurableRuntimeEngine();
  const wfEngine = new WorkflowEngine(runtime);
  const tenantContext = { tenant_id: 'ten_001', scope_type: 'TENANT' as const };

  // Edge points at a step id that doesn't exist in `steps`
  const danglingWorkflow: WorkflowDefinition = {
    id: 'wfl_dangling_edge',
    steps: [{ id: 'step_1', type: 'AGENT', name: 'Analyze Task' }],
    edges: [{ from: 'step_1', to: 'step_missing' }],
  };
  await assert.rejects(
    () => wfEngine.executeWorkflow(tenantContext, danglingWorkflow, {}),
    (err: any) => err.code === 'WORKFLOW_STEP_NOT_FOUND'
  );

  // Step type without implemented branching/loop semantics must not be
  // silently treated as a generic pass-through step
  const unsupportedWorkflow: WorkflowDefinition = {
    id: 'wfl_unsupported_step',
    steps: [{ id: 'step_1', type: 'PARALLEL', name: 'Fan Out' }],
    edges: [],
  };
  await assert.rejects(
    () => wfEngine.executeWorkflow(tenantContext, unsupportedWorkflow, {}),
    (err: any) => err.code === 'UNSUPPORTED_STEP_TYPE'
  );

  // A cycle in the edge list must not hang the process forever
  const cyclicWorkflow: WorkflowDefinition = {
    id: 'wfl_cyclic',
    steps: [
      { id: 'step_1', type: 'AGENT', name: 'A' },
      { id: 'step_2', type: 'AGENT', name: 'B' },
    ],
    edges: [
      { from: 'step_1', to: 'step_2' },
      { from: 'step_2', to: 'step_1' },
    ],
  };
  await assert.rejects(
    () => wfEngine.executeWorkflow(tenantContext, cyclicWorkflow, {}),
    (err: any) => err.code === 'WORKFLOW_STEP_LIMIT_EXCEEDED'
  );
});

test('2. Knowledge Engine Candidate Retrieval ACL Filter', () => {
  const knEngine = new KnowledgeEngine();

  knEngine.addDocument({
    source_id: 'kns_public',
    title: 'Public Architecture Guide',
    classification: 'PUBLIC',
    content: 'General NAgex System Guide',
  });

  knEngine.addDocument({
    source_id: 'kns_secret',
    title: 'Confidential Key Storage Policy',
    classification: 'CONFIDENTIAL',
    content: 'Internal Security Policy for Master Keys',
  });

  // Query with only PUBLIC classification access
  const candidatesPublic = knEngine.retrieveCandidates('Guide', ['PUBLIC']);
  assert.strictEqual(candidatesPublic.length, 1);
  assert.strictEqual(candidatesPublic[0].classification, 'PUBLIC');

  // Query trying to retrieve CONFIDENTIAL document without permission -> Filtered out BEFORE candidate generation
  const candidatesConfidential = knEngine.retrieveCandidates('Policy', ['PUBLIC']);
  assert.strictEqual(candidatesConfidential.length, 0);
});

test('2b. Knowledge Engine Grounded Citation Check rejects fabricated references', () => {
  const knEngine = new KnowledgeEngine();

  const doc = knEngine.addDocument({
    source_id: 'kns_public',
    title: 'Public Architecture Guide',
    classification: 'PUBLIC',
    content: 'General NAgex System Guide',
  });

  const candidates = knEngine.retrieveCandidates('Guide', ['PUBLIC']);
  assert.strictEqual(candidates.length, 1);

  // Citing a document that was actually retrieved must pass, and report
  // grounded: true.
  const validCheck = verifyGroundedCitations(candidates, [doc.document_id]);
  assert.strictEqual(validCheck.grounded, true);
  assert.strictEqual(validCheck.candidates_considered, 1);

  // An answer that provides no citation is not rejected -- it is merely
  // flagged as ungrounded for downstream consumers to decide what to do
  // with (a future autonomy gate, a UI badge, etc).
  const uncitedCheck = verifyGroundedCitations(candidates, []);
  assert.strictEqual(uncitedCheck.grounded, false);

  // Citing a document_id that was never retrieved as a candidate for this
  // query is a fabricated (hallucinated) reference and must be rejected.
  assert.throws(
    () => verifyGroundedCitations(candidates, ['knc_does_not_exist']),
    (err: any) => err.code === 'UNGROUNDED_CITATION' && err.category === 'VALIDATION'
  );
});

test('3. Memory Engine Lifecycle & Active Context Query', () => {
  const memEngine = new MemoryEngine();

  const proposed = memEngine.proposeMemory('SESSION', 'ten_100', 'usr_100', {
    subject: 'user_preference',
    predicate: 'theme',
    value: 'dark',
  });

  assert.strictEqual(proposed.lifecycle, 'PROPOSED');

  // Proposed memory is not active yet
  const beforeActive = memEngine.getActiveMemories('SESSION', 'ten_100', 'usr_100');
  assert.strictEqual(beforeActive.length, 0);

  // Activate Memory
  memEngine.activateMemory(proposed.id, 'ten_100', 'usr_100');
  const afterActive = memEngine.getActiveMemories('SESSION', 'ten_100', 'usr_100');
  assert.strictEqual(afterActive.length, 1);
  assert.strictEqual(afterActive[0].content.value, 'dark');

  // A memory already in a terminal lifecycle state (e.g. superseded by a
  // newer fact) must not be silently resurrected by re-activation.
  (memEngine as any).memoryStore.get(proposed.id).lifecycle = 'SUPERSEDED';
  assert.throws(
    () => memEngine.activateMemory(proposed.id, 'ten_100', 'usr_100'),
    (err: any) => err.code === 'MEMORY_ALREADY_TERMINAL'
  );
});

test('4. Plugin Framework Sandbox Egress Control', () => {
  const pluginFw = new PluginFramework();

  pluginFw.registerPlugin({
    package: 'com.nagex.slack-plugin',
    version: '1.0.0',
    egress: [
      { host: 'hooks.slack.com', port: 443, protocol: 'HTTPS' },
    ],
  });

  // Allowed Egress
  const allowed = pluginFw.validateEgressAccess('com.nagex.slack-plugin', 'hooks.slack.com', 443, 'HTTPS');
  assert.strictEqual(allowed, true);

  // Denied Egress (Unauthorized Host)
  assert.throws(
    () => {
      pluginFw.validateEgressAccess('com.nagex.slack-plugin', 'malicious.external.com', 443, 'HTTPS');
    },
    (err: any) => err.code === 'PLUGIN_EGRESS_DENIED'
  );

  // Denied Egress (Correct Host/Port but Undeclared Protocol)
  assert.throws(
    () => {
      pluginFw.validateEgressAccess('com.nagex.slack-plugin', 'hooks.slack.com', 443, 'HTTP');
    },
    (err: any) => err.code === 'PLUGIN_EGRESS_DENIED'
  );
});
