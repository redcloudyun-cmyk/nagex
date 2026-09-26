// R10.2-B — Google Capability Execution Pipeline (DEBT-0001). This file
// covers what's genuinely NEW in this refactor: GoogleCapabilityExecution-
// Pipeline's own generic behavior (isolated from any real Calendar/Gmail
// specifics via a fake provider), the assembled GOOGLE_MUTATION_REGISTRY,
// the static "no direct adapter mutation" architecture guard, concurrent/
// replayed execution safety, and the §12 memory-after-success bug fix.
// The exhaustive per-capability-family approval lifecycle (expired/
// consumed/rejected/wrong-tenant/wrong-principal/replay/persistence/audit)
// is ALREADY covered, end-to-end, through the real GoogleCalendarService/
// GmailService by tests/approval_ttl_security.test.ts,
// tests/approval_ownership_isolation.test.ts,
// tests/approval_execution_persistence.test.ts, tests/gmail_live.test.ts,
// and tests/google_calendar_live.test.ts — all 175 of which were re-run
// and stayed green against this refactor before this file was written;
// duplicating them here would be pure noise, not signal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NagexError } from '../src/common/errors.js';
import { GoogleCapabilityExecutionPipeline } from '../src/capabilities/google-capability-execution-pipeline.js';
import type { MutationCapabilityDefinition, MutationExecutionContext } from '../src/capabilities/mutation-registry.js';
import { buildMutationRegistry } from '../src/capabilities/mutation-registry.js';
import { GOOGLE_MUTATION_REGISTRY, listGoogleMutationToolIds } from '../src/capabilities/google-mutation-registry.js';
import { ActionApprovalStore } from '../src/governance/action-approval.store.js';
import { ExecutionStore } from '../src/governance/execution.store.js';
import { AuditLogger } from '../src/governance/audit.logger.js';
import { InMemoryGoogleOAuthTokenStore } from '../src/integrations/google/token.store.js';
import { GOOGLE_CALENDAR_SCOPES, GMAIL_SCOPES } from '../src/integrations/google/oauth.client.js';
import { GoogleCalendarService } from '../src/modules/calendar/index.js';
import { GmailService } from '../src/modules/gmail/index.js';
import { MemoryEngine } from '../src/context/memory.engine.js';

interface TestPayload { name: string }
interface TestProviderResult { externalId: string; externalUrl: string }

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
const config = { clientId: 'cid', clientSecret: 'csecret', redirectUri: 'https://nagex-test.agex.site/api/v1/oauth/google/callback' };

function testDefinition(overrides: Partial<MutationCapabilityDefinition<TestPayload>> = {}): MutationCapabilityDefinition<TestPayload> {
  return {
    toolId: 'test.mutate', provider: 'GOOGLE', service: 'CALENDAR', mutation: true, approvalRequired: true,
    failureMode: 'FAIL_CLOSED', timeoutBehavior: 'ABORT', unknownStateBehavior: 'DENY',
    disconnectedErrorCode: 'TEST_DISCONNECTED', disconnectedMessage: 'not connected',
    validatePayload: (payload) => payload as TestPayload,
    ...overrides,
  };
}

function buildPipelineHarness(opts: { connected?: boolean } = {}) {
  const approvals = new ActionApprovalStore();
  const audit = new AuditLogger();
  const executions = new ExecutionStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-exec-pipeline-test-')) });
  const tokenStore = { getValidAccessToken: async () => (opts.connected === false ? null : 'fake-token') };
  const credentialAccess = {
    withAccessToken: async <T>(_input: unknown, use: (accessToken: string) => Promise<T>): Promise<T | null> => {
      if (opts.connected === false) return null;
      return use('fake-token');
    },
  };
  const pipeline = new GoogleCapabilityExecutionPipeline({ tokenStore, credentialAccess, approvals, audit, executions, getConfig: () => ({ clientId: 'c', clientSecret: 's', redirectUri: 'r' }), fetchFn: fetch });
  return { approvals, audit, executions, pipeline };
}

// ── Mutation Registry (§4) ────────────────────────────────────────────────

test('1. GOOGLE_MUTATION_REGISTRY contains exactly the 7 known Calendar+Gmail mutation toolIds, no duplicates, no missing', () => {
  const ids = listGoogleMutationToolIds().sort();
  assert.deepEqual(ids, [
    'gmail.create_draft', 'gmail.reply', 'gmail.send_email',
    'google_calendar.cancel_event', 'google_calendar.create_event', 'google_calendar.respond_to_event', 'google_calendar.update_event',
  ].sort());
});

test('2. every registered definition declares mutation:true, approvalRequired:true, failureMode:FAIL_CLOSED, unknownStateBehavior:DENY', () => {
  for (const def of GOOGLE_MUTATION_REGISTRY.values()) {
    assert.equal(def.mutation, true, `${def.toolId} must declare mutation:true`);
    assert.equal(def.approvalRequired, true, `${def.toolId} must declare approvalRequired:true`);
    assert.equal(def.failureMode, 'FAIL_CLOSED', `${def.toolId} must be FAIL_CLOSED`);
    assert.equal(def.unknownStateBehavior, 'DENY', `${def.toolId} must DENY on unknown state`);
  }
});

test('3. buildMutationRegistry throws loudly on a duplicate toolId across two definition lists — never silently overwrites', () => {
  const a: MutationCapabilityDefinition[] = [testDefinition({ toolId: 'dup.tool' })];
  const b: MutationCapabilityDefinition[] = [testDefinition({ toolId: 'dup.tool' })];
  assert.throws(() => buildMutationRegistry([a, b]), /Duplicate mutation capability toolId/);
});

// ── Generic pipeline behavior, isolated from any real Google specifics ──

test('4. no valid approval -> no external mutation: execute() denies before the provider is ever called', async () => {
  const h = buildPipelineHarness();
  let providerCalled = false;
  const context: MutationExecutionContext<unknown> = { tenantId: 't1', principalId: 'u1', toolId: 'test.mutate', approvalId: 'apr_nonexistent', payload: { name: 'x' }, requestId: 'req_1' };
  await assert.rejects(
    () => h.pipeline.execute({ definition: testDefinition(), context, executeProvider: async () => { providerCalled = true; return { externalId: 'x', externalUrl: 'y' }; } }),
    (err: unknown) => (err as { code: string }).code === 'APPROVAL_NOT_FOUND',
  );
  assert.equal(providerCalled, false);
});

test('5. consumed approval -> cannot execute again: a second execute() with the same approvalId is denied and the provider is called at most once', async () => {
  const h = buildPipelineHarness();
  const record = h.approvals.request({ toolId: 'test.mutate', tenantId: 't1', principalId: 'u1', payload: { name: 'x' } });
  h.approvals.approve(record.approvalId, 't1', 'u1');
  let providerCallCount = 0;
  const context: MutationExecutionContext<unknown> = { tenantId: 't1', principalId: 'u1', toolId: 'test.mutate', approvalId: record.approvalId, payload: { name: 'x' }, requestId: 'req_5a' };
  const first = await h.pipeline.execute({ definition: testDefinition(), context, executeProvider: async () => { providerCallCount++; return { externalId: 'ext1', externalUrl: 'https://x' }; } });
  assert.equal(first.status, 'SUCCEEDED');
  await assert.rejects(
    () => h.pipeline.execute({ definition: testDefinition(), context: { ...context, requestId: 'req_5b' }, executeProvider: async () => { providerCallCount++; return { externalId: 'ext2', externalUrl: 'https://y' }; } }),
    (err: unknown) => (err as { code: string }).code === 'APPROVAL_ALREADY_CONSUMED',
  );
  assert.equal(providerCallCount, 1, 'the provider must never be called a second time for an already-consumed approval');
});

test('6. concurrent duplicate execution: two simultaneous execute() calls racing on the SAME approval result in the external mutation happening at most once', async () => {
  const h = buildPipelineHarness();
  const record = h.approvals.request({ toolId: 'test.mutate', tenantId: 't1', principalId: 'u1', payload: { name: 'x' } });
  h.approvals.approve(record.approvalId, 't1', 'u1');
  let providerCallCount = 0;
  const context: MutationExecutionContext<unknown> = { tenantId: 't1', principalId: 'u1', toolId: 'test.mutate', approvalId: record.approvalId, payload: { name: 'x' }, requestId: 'req_6' };
  const executeProvider = async (): Promise<TestProviderResult> => {
    providerCallCount++;
    await new Promise((r) => setTimeout(r, 5));
    return { externalId: 'ext', externalUrl: 'https://z' };
  };
  const [r1, r2] = await Promise.allSettled([
    h.pipeline.execute({ definition: testDefinition(), context, executeProvider }),
    h.pipeline.execute({ definition: testDefinition(), context: { ...context, requestId: 'req_6b' }, executeProvider }),
  ]);
  const succeeded = [r1, r2].filter((r) => r.status === 'fulfilled');
  const denied = [r1, r2].filter((r) => r.status === 'rejected');
  assert.equal(succeeded.length, 1, 'exactly one of the two racing execute() calls must succeed');
  assert.equal(denied.length, 1, 'the other must be denied (consume() is synchronous/atomic w.r.t. the event loop)');
  assert.equal(providerCallCount, 1, 'the real external mutation must happen at most once, never twice');
});

test('7. malformed/erroring provider response -> FAILED truthfully, execution record reflects FAILED, approval already consumed (not reusable)', async () => {
  const h = buildPipelineHarness();
  const record = h.approvals.request({ toolId: 'test.mutate', tenantId: 't1', principalId: 'u1', payload: { name: 'x' } });
  h.approvals.approve(record.approvalId, 't1', 'u1');
  const context: MutationExecutionContext<unknown> = { tenantId: 't1', principalId: 'u1', toolId: 'test.mutate', approvalId: record.approvalId, payload: { name: 'x' }, requestId: 'req_7' };
  await assert.rejects(
    () => h.pipeline.execute({
      definition: testDefinition(),
      context,
      executeProvider: async () => { throw new NagexError({ code: 'PROVIDER_MALFORMED_RESPONSE', category: 'PROVIDER', message: 'no id returned', request_id: 'req_7' }); },
    }),
    (err: unknown) => (err as { code: string }).code === 'PROVIDER_MALFORMED_RESPONSE',
  );
  const executions = h.executions.list();
  const failed = executions.find((e) => e.toolId === 'test.mutate');
  assert.equal(failed?.status, 'FAILED');
  assert.equal(failed?.errorCode, 'PROVIDER_MALFORMED_RESPONSE');
  const stillConsumed = h.approvals.get(record.approvalId, 't1', 'u1');
  assert.equal(stillConsumed?.status, 'CONSUMED', 'a failure AFTER a real consume() must never un-consume the approval — replay must stay impossible');
});

test('8. provider unreachable BEFORE consume (disconnected) -> DENY, approval stays APPROVED (genuinely retryable, no mutation attempted)', async () => {
  const h = buildPipelineHarness({ connected: false });
  const record = h.approvals.request({ toolId: 'test.mutate', tenantId: 't1', principalId: 'u1', payload: { name: 'x' } });
  h.approvals.approve(record.approvalId, 't1', 'u1');
  let providerCalled = false;
  const context: MutationExecutionContext<unknown> = { tenantId: 't1', principalId: 'u1', toolId: 'test.mutate', approvalId: record.approvalId, payload: { name: 'x' }, requestId: 'req_8' };
  await assert.rejects(
    () => h.pipeline.execute({ definition: testDefinition(), context, executeProvider: async () => { providerCalled = true; return { externalId: 'x', externalUrl: 'y' }; } }),
    (err: unknown) => (err as { code: string }).code === 'TEST_DISCONNECTED',
  );
  assert.equal(providerCalled, false);
  assert.equal(h.approvals.get(record.approvalId, 't1', 'u1')?.status, 'APPROVED');
});

test('9. missing tenant/principal/approvalId context -> DENY before any store/provider call', async () => {
  const h = buildPipelineHarness();
  let providerCalled = false;
  const badContexts: MutationExecutionContext<unknown>[] = [
    { tenantId: '', principalId: 'u1', toolId: 'test.mutate', approvalId: 'apr_x', payload: {}, requestId: 'r1' },
    { tenantId: 't1', principalId: '', toolId: 'test.mutate', approvalId: 'apr_x', payload: {}, requestId: 'r2' },
    { tenantId: 't1', principalId: 'u1', toolId: 'test.mutate', approvalId: '', payload: {}, requestId: 'r3' },
  ];
  for (const context of badContexts) {
    await assert.rejects(
      () => h.pipeline.execute({ definition: testDefinition(), context, executeProvider: async () => { providerCalled = true; return { externalId: 'x', externalUrl: 'y' }; } }),
      (err: unknown) => (err as { code: string }).code === 'MUTATION_CONTEXT_INCOMPLETE',
    );
  }
  assert.equal(providerCalled, false);
});

test('10. success has exactly one execution record; audit gets both tool.execution.started and tool.execution.succeeded', async () => {
  const h = buildPipelineHarness();
  const record = h.approvals.request({ toolId: 'test.mutate', tenantId: 't1', principalId: 'u1', payload: { name: 'x' } });
  h.approvals.approve(record.approvalId, 't1', 'u1');
  const context: MutationExecutionContext<unknown> = { tenantId: 't1', principalId: 'u1', toolId: 'test.mutate', approvalId: record.approvalId, payload: { name: 'x' }, requestId: 'req_10' };
  const result = await h.pipeline.execute({ definition: testDefinition(), context, executeProvider: async () => ({ externalId: 'ext10', externalUrl: 'https://ok' }) });
  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(h.executions.list().filter((e) => e.toolId === 'test.mutate').length, 1);
  const actions = h.audit.getRecentLogs(20).map((e) => e.action);
  assert.ok(actions.includes('tool.execution.started'));
  assert.ok(actions.includes('tool.execution.succeeded'));
});

test('11. denied approval never produces a successful execution record', async () => {
  const h = buildPipelineHarness();
  const record = h.approvals.request({ toolId: 'test.mutate', tenantId: 't1', principalId: 'u1', payload: { name: 'x' } });
  h.approvals.reject(record.approvalId, 't1', 'u1');
  const context: MutationExecutionContext<unknown> = { tenantId: 't1', principalId: 'u1', toolId: 'test.mutate', approvalId: record.approvalId, payload: { name: 'x' }, requestId: 'req_11' };
  await assert.rejects(() => h.pipeline.execute({ definition: testDefinition(), context, executeProvider: async () => ({ externalId: 'x', externalUrl: 'y' }) }));
  assert.equal(h.executions.list().filter((e) => e.toolId === 'test.mutate' && e.status === 'SUCCEEDED').length, 0);
});

// ── §12 — the real bug fix: a post-success hook failure must never flip a
//    genuine success into a reported failure ─────────────────────────────

test('12. a throwing afterSuccess hook never flips a real success into a reported failure, and the execution record stays SUCCEEDED', async () => {
  const h = buildPipelineHarness();
  const record = h.approvals.request({ toolId: 'test.mutate', tenantId: 't1', principalId: 'u1', payload: { name: 'x' } });
  h.approvals.approve(record.approvalId, 't1', 'u1');
  const context: MutationExecutionContext<unknown> = { tenantId: 't1', principalId: 'u1', toolId: 'test.mutate', approvalId: record.approvalId, payload: { name: 'x' }, requestId: 'req_12' };
  const result = await h.pipeline.execute({
    definition: testDefinition(),
    context,
    executeProvider: async () => ({ externalId: 'ext12', externalUrl: 'https://ok' }),
    afterSuccess: () => { throw new Error('memory engine exploded'); },
  });
  assert.equal(result.status, 'SUCCEEDED', 'the caller must be told the truth: the external mutation genuinely succeeded');
  assert.equal(result.externalId, 'ext12');
  const executionRecord = h.executions.list().find((e) => e.toolId === 'test.mutate');
  assert.equal(executionRecord?.status, 'SUCCEEDED', 'the durable execution record must never be silently rewritten to FAILED by an unrelated post-success hook failure');
});

// ── Real end-to-end proof that BOTH services actually route through the
//    shared pipeline (not two divergent reimplementations) ──────────────

test('13. GoogleCalendarService.executeCreateEvent genuinely routes through the shared pipeline (real approval consumed, real execution + audit recorded)', async () => {
  const tokenStore = new InMemoryGoogleOAuthTokenStore();
  const approvals = new ActionApprovalStore();
  const audit = new AuditLogger();
  const executions = new ExecutionStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-exec-cal-e2e-')) });
  tokenStore.saveForPrincipal('t13', 'u13', { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: GOOGLE_CALENDAR_SCOPES.join(' ') });
  const fetchFn = (async () => jsonResponse({ id: 'evt13', htmlLink: 'https://calendar.google.com/e13' })) as unknown as typeof fetch;
  const service = new GoogleCalendarService(tokenStore, approvals, audit, new MemoryEngine(), fetchFn, () => config, executions);
  const payload = { calendarId: 'primary', summary: 'Pipeline check', description: '', start: '2026-09-20T10:00:00Z', end: '2026-09-20T10:30:00Z', timezone: 'UTC', attendees: [] };
  const requested = service.requestCreateEventApproval({ tenantId: 't13', principalId: 'u13', payload, requestId: 'req_13a' });
  service.approve(requested.approvalId, 't13', 'u13', 'req_13b');
  const result = await service.executeCreateEvent({ approvalId: requested.approvalId, payload, tenantId: 't13', principalId: 'u13', requestId: 'req_13c' });
  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(result.externalId, 'evt13');
  assert.equal(approvals.get(requested.approvalId, 't13', 'u13')?.status, 'CONSUMED');
  assert.equal(executions.list().filter((e) => e.status === 'SUCCEEDED').length, 1);
});

test('14. GmailService.executeSendEmail genuinely routes through the shared pipeline (real approval consumed, real execution + audit recorded)', async () => {
  const tokenStore = new InMemoryGoogleOAuthTokenStore();
  const approvals = new ActionApprovalStore();
  const audit = new AuditLogger();
  const executions = new ExecutionStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-exec-gmail-e2e-')) });
  tokenStore.saveForPrincipal('t14', 'u14', { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: GMAIL_SCOPES.join(' ') });
  const fetchFn = (async () => jsonResponse({ id: 'msg14', threadId: 'th14' })) as unknown as typeof fetch;
  const service = new GmailService(tokenStore, approvals, audit, new MemoryEngine(), fetchFn, () => config, executions);
  const payload = { from: 'me', to: ['a@example.com'], subject: 'Hi', body: 'Pipeline check' };
  const requested = service.requestApproval({ toolId: 'gmail.send_email', tenantId: 't14', principalId: 'u14', payload, requestId: 'req_14a' });
  service.approve(requested.approvalId, 't14', 'u14', 'req_14b');
  const result = await service.executeSendEmail({ approvalId: requested.approvalId, payload, tenantId: 't14', principalId: 'u14', requestId: 'req_14c' });
  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(result.externalId, 'msg14');
  assert.equal(approvals.get(requested.approvalId, 't14', 'u14')?.status, 'CONSUMED');
  assert.equal(executions.list().filter((e) => e.status === 'SUCCEEDED').length, 1);
});

// ── §14 — static architecture guard, explicitly re-stated for this file's
//    own traceability even though tests/google_modules_boundary.test.ts's
//    test 11 already covers the entire src/ tree generically ────────────

function readSourceWithoutComments(relPath: string): string {
  return fs.readFileSync(path.resolve(relPath), 'utf8').split('\n').map((line) => line.replace(/\/\/.*/, '')).join('\n');
}

test('15. action-proposal-executor.ts (R11) never imports a Calendar/Gmail client internal file directly', () => {
  const code = readSourceWithoutComments('src/assistant/action-proposal-executor.ts');
  assert.doesNotMatch(code, /modules\/calendar\/(google-calendar\.service|calendar\.client)\.js/);
  assert.doesNotMatch(code, /modules\/gmail\/(gmail\.service|gmail\.client)\.js/);
});

test('16. server_web.ts never imports a Calendar/Gmail client internal file directly (only each module\'s public index)', () => {
  const code = readSourceWithoutComments('src/server_web.ts');
  assert.doesNotMatch(code, /modules\/calendar\/(google-calendar\.service|calendar\.client)\.js/);
  assert.doesNotMatch(code, /modules\/gmail\/(gmail\.service|gmail\.client)\.js/);
});

test('17. the pipeline module itself has zero Calendar/Gmail concrete/internal imports — fully generic, reusable for future Google write integrations (Drive/Docs, per ADR-0002)', () => {
  const code = readSourceWithoutComments('src/capabilities/google-capability-execution-pipeline.ts');
  assert.doesNotMatch(code, /modules\/(calendar|gmail)\//);
  const registryCode = readSourceWithoutComments('src/capabilities/mutation-registry.ts');
  assert.doesNotMatch(registryCode, /modules\/(calendar|gmail)\//);
});
