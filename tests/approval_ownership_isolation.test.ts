// Approval Ownership Isolation Correction.
//
// ActionApprovalStore records always carried tenantId/principalId, but
// get/approve/reject/assertExecutable/consume were approvalId-only — any
// caller who knew (or obtained, e.g. via the then-unscoped GET route)
// another tenant's approvalId could read, approve, reject, or execute it.
// These tests prove the fix: every operation is now scoped by
// approvalId + tenantId + principalId, and a wrong tenant/principal is
// externally indistinguishable from a genuinely nonexistent approvalId.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ActionApprovalStore, PersistentActionApprovalStore } from '../src/governance/action-approval.store.js';
import { AuditLogger } from '../src/governance/audit.logger.js';
import { ExecutionStore } from '../src/governance/execution.store.js';
import { MemoryEngine } from '../src/context/memory.engine.js';
import { CapabilityBroker } from '../src/capabilities/capability-broker.js';
import { CapabilityRegistry } from '../src/capabilities/capability.registry.js';
import { GoogleCalendarService } from '../src/modules/calendar/index.js';
import { GmailService } from '../src/modules/gmail/index.js';
import { NagexError } from '../src/common/errors.js';

function tmpDir(label: string): string {
  return path.join(os.tmpdir(), `nagex-appr-iso-${label}-${crypto.randomBytes(6).toString('hex')}`);
}

function payload() {
  return { calendarId: 'primary', summary: 'Sync', description: '', start: '2026-10-01T10:00:00Z', end: '2026-10-01T11:00:00Z', timezone: 'UTC', attendees: [] };
}

// ── 1-4: get isolation ───────────────────────────────────────────────────

test('same principalId, tenant A vs B: get isolation', () => {
  const store = new ActionApprovalStore();
  const record = store.request({ toolId: 'google_calendar.create_event', tenantId: 'ten_a', principalId: 'usr_shared', payload: payload() });
  assert.ok(store.get(record.approvalId, 'ten_a', 'usr_shared'));
  assert.equal(store.get(record.approvalId, 'ten_b', 'usr_shared'), undefined);
});

test('same tenant, principal A vs B: get isolation', () => {
  const store = new ActionApprovalStore();
  const record = store.request({ toolId: 'google_calendar.create_event', tenantId: 'ten_1', principalId: 'usr_a', payload: payload() });
  assert.ok(store.get(record.approvalId, 'ten_1', 'usr_a'));
  assert.equal(store.get(record.approvalId, 'ten_1', 'usr_b'), undefined);
});

test('wrong tenant is indistinguishable from a nonexistent approval', () => {
  const store = new ActionApprovalStore();
  const record = store.request({ toolId: 'google_calendar.create_event', tenantId: 'ten_a', principalId: 'usr_1', payload: payload() });
  assert.equal(store.get(record.approvalId, 'ten_b', 'usr_1'), store.get('apr_does_not_exist', 'ten_a', 'usr_1'));
});

test('wrong principal is indistinguishable from a nonexistent approval', () => {
  const store = new ActionApprovalStore();
  const record = store.request({ toolId: 'google_calendar.create_event', tenantId: 'ten_1', principalId: 'usr_a', payload: payload() });
  assert.equal(store.get(record.approvalId, 'ten_1', 'usr_b'), store.get('apr_does_not_exist', 'ten_1', 'usr_a'));
});

// ── 5-8: approve isolation ───────────────────────────────────────────────

test('same principalId, tenant A vs B: approve isolation', () => {
  const store = new ActionApprovalStore();
  const record = store.request({ toolId: 'google_calendar.create_event', tenantId: 'ten_a', principalId: 'usr_shared', payload: payload() });
  assert.throws(() => store.approve(record.approvalId, 'ten_b', 'usr_shared'), (err: unknown) => err instanceof NagexError && err.code === 'APPROVAL_NOT_FOUND');
  assert.equal(store.get(record.approvalId, 'ten_a', 'usr_shared')!.status, 'PENDING', 'blocked approve leaves the real record PENDING');
});

test('same tenant, principal A vs B: approve isolation', () => {
  const store = new ActionApprovalStore();
  const record = store.request({ toolId: 'google_calendar.create_event', tenantId: 'ten_1', principalId: 'usr_a', payload: payload() });
  assert.throws(() => store.approve(record.approvalId, 'ten_1', 'usr_b'), (err: unknown) => err instanceof NagexError && err.code === 'APPROVAL_NOT_FOUND');
  assert.equal(store.get(record.approvalId, 'ten_1', 'usr_a')!.status, 'PENDING');
});

function captureError(fn: () => unknown): NagexError {
  try {
    fn();
  } catch (err) {
    return err as NagexError;
  }
  throw new Error('expected fn to throw');
}

test('wrong-tenant and wrong-principal approve attempts produce the identical APPROVAL_NOT_FOUND response as a nonexistent approval', () => {
  const store = new ActionApprovalStore();
  const record = store.request({ toolId: 'google_calendar.create_event', tenantId: 'ten_a', principalId: 'usr_a', payload: payload() });

  const wrongTenantErr = captureError(() => store.approve(record.approvalId, 'ten_b', 'usr_a'));
  const wrongPrincipalErr = captureError(() => store.approve(record.approvalId, 'ten_a', 'usr_b'));
  const nonexistentErr = captureError(() => store.approve('apr_does_not_exist', 'ten_a', 'usr_a'));

  assert.equal(wrongTenantErr.code, 'APPROVAL_NOT_FOUND');
  assert.equal(wrongPrincipalErr.code, 'APPROVAL_NOT_FOUND');
  assert.equal(nonexistentErr.code, 'APPROVAL_NOT_FOUND');
  assert.equal(wrongTenantErr.category, nonexistentErr.category);
  assert.equal(wrongPrincipalErr.category, nonexistentErr.category);
});

// ── 9-10: reject isolation ───────────────────────────────────────────────

test('blocked reject leaves the real record PENDING (wrong tenant)', () => {
  const store = new ActionApprovalStore();
  const record = store.request({ toolId: 'google_calendar.create_event', tenantId: 'ten_a', principalId: 'usr_shared', payload: payload() });
  assert.throws(() => store.reject(record.approvalId, 'ten_b', 'usr_shared'), (err: unknown) => err instanceof NagexError && err.code === 'APPROVAL_NOT_FOUND');
  assert.equal(store.get(record.approvalId, 'ten_a', 'usr_shared')!.status, 'PENDING');
});

test('blocked reject leaves the real record PENDING (wrong principal)', () => {
  const store = new ActionApprovalStore();
  const record = store.request({ toolId: 'google_calendar.create_event', tenantId: 'ten_1', principalId: 'usr_a', payload: payload() });
  assert.throws(() => store.reject(record.approvalId, 'ten_1', 'usr_b'), (err: unknown) => err instanceof NagexError && err.code === 'APPROVAL_NOT_FOUND');
  assert.equal(store.get(record.approvalId, 'ten_1', 'usr_a')!.status, 'PENDING');
});

// ── 11-14: assertExecutable / consume isolation ──────────────────────────

test('wrong-tenant assertExecutable is blocked', () => {
  const store = new ActionApprovalStore();
  const record = store.request({ toolId: 'browser.click', tenantId: 'ten_a', principalId: 'usr_1', payload: payload() });
  store.approve(record.approvalId, 'ten_a', 'usr_1');
  assert.throws(() => store.assertExecutable(record.approvalId, 'ten_b', 'usr_1', 'browser.click', 'req_1'), (err: unknown) => err instanceof NagexError && err.code === 'APPROVAL_NOT_FOUND');
});

test('wrong-principal assertExecutable is blocked', () => {
  const store = new ActionApprovalStore();
  const record = store.request({ toolId: 'browser.click', tenantId: 'ten_1', principalId: 'usr_a', payload: payload() });
  store.approve(record.approvalId, 'ten_1', 'usr_a');
  assert.throws(() => store.assertExecutable(record.approvalId, 'ten_1', 'usr_b', 'browser.click', 'req_1'), (err: unknown) => err instanceof NagexError && err.code === 'APPROVAL_NOT_FOUND');
});

test('wrong-tenant consume is blocked; the real approval remains APPROVED, unconsumed', () => {
  const store = new ActionApprovalStore();
  const record = store.request({ toolId: 'google_calendar.create_event', tenantId: 'ten_a', principalId: 'usr_1', payload: payload() });
  store.approve(record.approvalId, 'ten_a', 'usr_1');
  assert.throws(
    () => store.consume(record.approvalId, 'ten_b', 'usr_1', 'google_calendar.create_event', payload(), 'req_1', 'exe_1'),
    (err: unknown) => err instanceof NagexError && err.code === 'APPROVAL_NOT_FOUND',
  );
  assert.equal(store.get(record.approvalId, 'ten_a', 'usr_1')!.status, 'APPROVED', 'a blocked cross-tenant consume must never mark the real approval CONSUMED');
});

test('wrong-principal consume is blocked; the real approval remains APPROVED, unconsumed', () => {
  const store = new ActionApprovalStore();
  const record = store.request({ toolId: 'google_calendar.create_event', tenantId: 'ten_1', principalId: 'usr_a', payload: payload() });
  store.approve(record.approvalId, 'ten_1', 'usr_a');
  assert.throws(
    () => store.consume(record.approvalId, 'ten_1', 'usr_b', 'google_calendar.create_event', payload(), 'req_1', 'exe_1'),
    (err: unknown) => err instanceof NagexError && err.code === 'APPROVAL_NOT_FOUND',
  );
  assert.equal(store.get(record.approvalId, 'ten_1', 'usr_a')!.status, 'APPROVED');
});

// ── 15: wrong-tenant Broker execution — no side effect, no consumption ───

function buildBrokerHarness(fetchFn: typeof fetch) {
  const approvals = new ActionApprovalStore();
  const audit = new AuditLogger();
  const memory = new MemoryEngine();
  const executions = new ExecutionStore({ dir: tmpDir('exec') });
  const tokenStore: any = { getValidAccessToken: async () => 'mock_token' };
  const getConfig: any = () => ({ clientId: 'mock', clientSecret: 'mock', redirectUri: 'mock' });
  const calendarService = new GoogleCalendarService(tokenStore, approvals, audit, memory, fetchFn, getConfig, executions);
  const gmailService = new GmailService(tokenStore, approvals, audit, memory, fetchFn, getConfig, executions);
  const browserService: any = { open: async () => { throw new Error('not exercised'); } };
  const registry = new CapabilityRegistry();
  // Set before constructing the Broker — its idempotency FileRecordStore
  // resolves this env var inside its own constructor, so setting it
  // afterward would leave every test sharing the real, non-test-isolated
  // default idempotency directory across separate test/process runs.
  process.env.NAGEX_TEST_APPR_ISO_IDEMPOTENCY_DIR = tmpDir('idempotency');
  const broker = new CapabilityBroker(calendarService, gmailService, browserService, audit, registry, 'test_appr_iso_idempotency', 'NAGEX_TEST_APPR_ISO_IDEMPOTENCY_DIR');
  return { approvals, broker, executions };
}

test('wrong-tenant Broker execution causes no external side effect and does not consume the real approval', async () => {
  let googleCalled = false;
  const { approvals, broker, executions } = buildBrokerHarness(async () => {
    googleCalled = true;
    return new Response(JSON.stringify({ id: 'evt_should_never_exist' }), { status: 200 });
  });

  const requested = await broker.execute({ capabilityId: 'google_calendar.create_event', tenantId: 'ten_victim', principalId: 'usr_victim', requestId: 'req_1', payload: payload(), source: 'WEB' });
  assert.equal(requested.status, 'APPROVAL_REQUIRED');
  const approvalId = (requested as { approval?: { approvalId: string } }).approval!.approvalId;
  approvals.approve(approvalId, 'ten_victim', 'usr_victim');

  // The attacker claims a different tenant/principal but supplies the
  // victim's real approvalId and the exact disclosed payload.
  await assert.rejects(
    () => broker.execute({ capabilityId: 'google_calendar.create_event', tenantId: 'ten_attacker', principalId: 'usr_attacker', requestId: 'req_2', payload: payload(), approvalId, source: 'WEB' }),
    (err: unknown) => err instanceof NagexError && err.code === 'APPROVAL_NOT_FOUND',
  );

  assert.equal(googleCalled, false, 'no external Google Calendar call may occur for a cross-tenant execution attempt');
  assert.equal(executions.list().length, 0, 'no ExecutionRecord may be created for a blocked cross-tenant attempt');
  assert.equal(approvals.get(approvalId, 'ten_victim', 'usr_victim')!.status, 'APPROVED', 'the victim\'s real approval must remain APPROVED, unconsumed, still usable by its rightful owner');
});

test('legitimate owner: approve works, execute works, consume happens exactly once, replay still blocked', async () => {
  let callCount = 0;
  const { approvals, broker } = buildBrokerHarness(async () => {
    callCount++;
    return new Response(JSON.stringify({ id: 'evt_real', htmlLink: 'https://calendar.google.com/event?eid=real' }), { status: 200 });
  });

  const requested = await broker.execute({ capabilityId: 'google_calendar.create_event', tenantId: 'ten_owner', principalId: 'usr_owner', requestId: 'req_1', payload: payload(), source: 'WEB' });
  const approvalId = (requested as { approval?: { approvalId: string } }).approval!.approvalId;

  approvals.approve(approvalId, 'ten_owner', 'usr_owner');
  assert.equal(approvals.get(approvalId, 'ten_owner', 'usr_owner')!.status, 'APPROVED');

  const executed = await broker.execute({ capabilityId: 'google_calendar.create_event', tenantId: 'ten_owner', principalId: 'usr_owner', requestId: 'req_2', payload: payload(), approvalId, source: 'WEB' });
  assert.equal(executed.status, 'EXECUTED');
  assert.equal(callCount, 1);
  assert.equal(approvals.get(approvalId, 'ten_owner', 'usr_owner')!.status, 'CONSUMED');

  // Replay by the legitimate owner is still blocked — one-time consumption untouched.
  await assert.rejects(
    () => broker.execute({ capabilityId: 'google_calendar.create_event', tenantId: 'ten_owner', principalId: 'usr_owner', requestId: 'req_3', payload: payload(), approvalId, source: 'WEB' }),
    (err: unknown) => err instanceof NagexError && err.code === 'APPROVAL_ALREADY_CONSUMED',
  );
  assert.equal(callCount, 1, 'a replay attempt must never reach Google a second time');
});

// ── 16: restart persistence remains valid ────────────────────────────────

test('restart persistence: ownership scoping survives a fresh store instance pointed at the same directory', () => {
  const dir = tmpDir('restart');
  try {
    const storeA = new PersistentActionApprovalStore({ dir });
    const record = storeA.request({ toolId: 'google_calendar.create_event', tenantId: 'ten_1', principalId: 'usr_1', payload: payload() });

    const storeB = new PersistentActionApprovalStore({ dir });
    assert.ok(storeB.get(record.approvalId, 'ten_1', 'usr_1'), 'the legitimate owner must still be able to read the approval after a restart');
    assert.equal(storeB.get(record.approvalId, 'ten_2', 'usr_1'), undefined, 'cross-tenant isolation must survive a restart');

    const approved = storeB.approve(record.approvalId, 'ten_1', 'usr_1');
    assert.equal(approved.status, 'APPROVED');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
