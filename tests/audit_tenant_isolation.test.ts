// Audit Route Tenant Scoping Correction.
//
// GET /api/v1/audit/logs called auditLogger.getRecentLogs(20) — a global,
// unscoped slice of the last 20 audit events across every tenant in the
// process, disclosed to any caller regardless of its own tenant header.
// AuditLogger already had a tenant-scoped getAuditLogs(tenantId), but it
// returned a tenant's ENTIRE unbounded history in original insertion
// order, not "latest N, newest-first" — swapping it in naively would have
// traded the leak for a silent ordering/limit regression. These tests
// prove the actual fix: getAuditLogs(tenantId, limit?) filters by tenant
// FIRST, then (only when a limit is given) slices/reverses within that
// already-tenant-scoped set, so another tenant's volume can never reduce,
// reorder, or otherwise influence this tenant's own latest-N result — and
// the one-argument (no limit) call shape used by 5 pre-existing callers is
// completely unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuditLogger } from '../src/governance/audit.logger.js';
import { handleApiRequest, handleAsyncApiRequest } from '../src/server_web.js';

function emit(logger: AuditLogger, tenantId: string, action: string, resourceId: string, requestId: string) {
  return logger.logEvent({
    actor: { type: 'user', id: 'usr_shared' },
    tenant_id: tenantId,
    action,
    resource: { type: 'TestResource', id: resourceId },
    result: 'SUCCESS',
    request_id: requestId,
  });
}

// ── 1-2: basic cross-tenant isolation ────────────────────────────────────

test('1. tenant A emits A1, tenant B emits B1: each tenant sees only its own event', () => {
  const logger = new AuditLogger();
  const a1 = emit(logger, 'ten_a', 'action.a1', 'res_a1', 'req_a1');
  const b1 = emit(logger, 'ten_b', 'action.b1', 'res_b1', 'req_b1');

  const listA = logger.getAuditLogs('ten_a');
  const listB = logger.getAuditLogs('ten_b');

  assert.ok(listA.some((r) => r.audit_id === a1.audit_id));
  assert.equal(listA.some((r) => r.audit_id === b1.audit_id), false);
  assert.ok(listB.some((r) => r.audit_id === b1.audit_id));
  assert.equal(listB.some((r) => r.audit_id === a1.audit_id), false);
});

test('2. identical action/resource id across two tenants does not cross-leak', () => {
  const logger = new AuditLogger();
  const a1 = emit(logger, 'ten_a', 'tool.execution.succeeded', 'res_shared_id', 'req_1');
  const b1 = emit(logger, 'ten_b', 'tool.execution.succeeded', 'res_shared_id', 'req_2');

  const listA = logger.getAuditLogs('ten_a');
  const listB = logger.getAuditLogs('ten_b');

  assert.equal(listA.length, 1);
  assert.equal(listA[0].audit_id, a1.audit_id);
  assert.equal(listB.length, 1);
  assert.equal(listB[0].audit_id, b1.audit_id);
});

// ── 3: latest-N semantics (mandatory) ────────────────────────────────────

test('3. latest-N is calculated within tenant — other tenants\' volume never reduces or reorders it', () => {
  const logger = new AuditLogger();

  // Interleave: 25 events for tenant A with 25 events for tenant B, so a
  // naive getRecentLogs(20).filter(tenant) would return FEWER than 20 (or
  // zero) tenant-A records, crowded out by tenant B's own volume.
  const emittedA: string[] = [];
  for (let i = 0; i < 25; i++) {
    const rec = emit(logger, 'ten_a', 'action.a', `res_a_${i}`, `req_a_${i}`);
    emittedA.push(rec.audit_id);
    emit(logger, 'ten_b', 'action.b', `res_b_${i}`, `req_b_${i}`);
  }

  const result = logger.getAuditLogs('ten_a', 20);
  assert.equal(result.length, 20, 'tenant B volume must never reduce tenant A\'s own latest-20 count');
  assert.ok(result.every((r) => r.tenant_id === 'ten_a'), 'no tenant B record may appear in tenant A\'s result');

  // Newest-first, and exactly the last 20 of the 25 tenant-A events emitted.
  const expectedNewestFirst = emittedA.slice(-20).reverse();
  assert.deepEqual(result.map((r) => r.audit_id), expectedNewestFirst);

  // Explicitly guard against the incorrect implementation the directive
  // warns about: getRecentLogs(20).filter(tenant) limits ACROSS both
  // tenants first — with each tenant-A emission immediately followed by a
  // tenant-B one, the global last 20 records are only the last 10 A/B
  // pairs, i.e. only 10 tenant-A records, not tenant A's true newest 20.
  const buggyFilterAfterLimit = logger.getRecentLogs(20).filter((r) => r.tenant_id === 'ten_a');
  assert.equal(buggyFilterAfterLimit.length, 10, 'sanity check: filter-after-limit would have wrongly undercounted to 10 — confirms this test actually exercises the bug the fix prevents');
  assert.ok(buggyFilterAfterLimit.length < result.length, 'the buggy approach must undercount relative to the correct tenant-first result');
});

// ── 4-5: ordering / backward compatibility ───────────────────────────────

test('4. getAuditLogs(tenantId) with no limit remains unbounded, insertion order — existing callers unchanged', () => {
  const logger = new AuditLogger();
  const first = emit(logger, 'ten_a', 'first', 'res_1', 'req_1');
  const second = emit(logger, 'ten_a', 'second', 'res_2', 'req_2');
  const third = emit(logger, 'ten_a', 'third', 'res_3', 'req_3');

  const result = logger.getAuditLogs('ten_a');
  assert.equal(result.length, 3);
  assert.deepEqual(result.map((r) => r.audit_id), [first.audit_id, second.audit_id, third.audit_id], 'no-limit call must preserve original insertion order, not reverse it');
});

test('5. getAuditLogs(tenantId, limit) returns newest-first', () => {
  const logger = new AuditLogger();
  const first = emit(logger, 'ten_a', 'first', 'res_1', 'req_1');
  const second = emit(logger, 'ten_a', 'second', 'res_2', 'req_2');
  const third = emit(logger, 'ten_a', 'third', 'res_3', 'req_3');

  const result = logger.getAuditLogs('ten_a', 2);
  assert.deepEqual(result.map((r) => r.audit_id), [third.audit_id, second.audit_id], 'limited call must be newest-first, matching getRecentLogs\' own convention');
  void first;
});

test('5b. limit <= 0 returns an empty array, matching getRecentLogs\' own convention', () => {
  const logger = new AuditLogger();
  emit(logger, 'ten_a', 'first', 'res_1', 'req_1');
  assert.deepEqual(logger.getAuditLogs('ten_a', 0), []);
  assert.deepEqual(logger.getAuditLogs('ten_a', -1), []);
});

// ── 6: empty tenant ───────────────────────────────────────────────────────

test('6. an unknown/empty-history tenant gets an empty array, both limited and unlimited', () => {
  const logger = new AuditLogger();
  emit(logger, 'ten_a', 'action', 'res_1', 'req_1');
  assert.deepEqual(logger.getAuditLogs('ten_never_seen'), []);
  assert.deepEqual(logger.getAuditLogs('ten_never_seen', 20), []);
});

// ── 7: getRecentLogs regression — untouched ──────────────────────────────

test('7. getRecentLogs(limit) is unchanged: still global, newest-first, unscoped by tenant', () => {
  const logger = new AuditLogger();
  const a1 = emit(logger, 'ten_a', 'a', 'res_a', 'req_a');
  const b1 = emit(logger, 'ten_b', 'b', 'res_b', 'req_b');

  const recent = logger.getRecentLogs(20);
  assert.equal(recent.length, 2);
  assert.deepEqual(recent.map((r) => r.audit_id), [b1.audit_id, a1.audit_id], 'getRecentLogs must remain global and newest-first, exactly as before this correction');
});

// ── 8: real HTTP route — production wiring, not just the class ──────────

test('8. GET /api/v1/audit/logs is tenant-scoped end to end through the real production route', async () => {
  const tenantA = 'ten_audit_accept_a';
  const tenantB = 'ten_audit_accept_b';

  // A real, safe, already-existing action that emits a real audit event
  // (oauth:google_disconnected) — never a raw file write, never a
  // destructive action. Both synthetic tenants have no real Google
  // connection, so revoke() is a harmless no-op beyond logging.
  const disconnectA = await handleAsyncApiRequest('POST', '/api/v1/oauth/google/disconnect', null, { 'x-nagex-tenant': tenantA, 'x-principal-id': 'usr_audit_shared' });
  assert.equal(disconnectA.status, 200);
  const disconnectB = await handleAsyncApiRequest('POST', '/api/v1/oauth/google/disconnect', null, { 'x-nagex-tenant': tenantB, 'x-principal-id': 'usr_audit_shared' });
  assert.equal(disconnectB.status, 200);

  const resultA = handleApiRequest('GET', '/api/v1/audit/logs', null, { 'x-nagex-tenant': tenantA, 'x-principal-id': 'usr_audit_shared' });
  const dataA = resultA.data as { logs: Array<{ tenant_id: string; action: string }>; total: number };
  assert.ok(dataA.logs.some((l) => l.action === 'oauth:google_disconnected' && l.tenant_id === tenantA));
  assert.equal(dataA.logs.some((l) => l.tenant_id === tenantB), false, 'tenant A must never see tenant B\'s audit events over the real route');
  assert.equal(dataA.total, dataA.logs.length, 'total must reflect only the tenant-scoped result, never a global count');

  const resultB = handleApiRequest('GET', '/api/v1/audit/logs', null, { 'x-nagex-tenant': tenantB, 'x-principal-id': 'usr_audit_shared' });
  const dataB = resultB.data as { logs: Array<{ tenant_id: string }>; total: number };
  assert.ok(dataB.logs.some((l) => l.tenant_id === tenantB));
  assert.equal(dataB.logs.some((l) => l.tenant_id === tenantA), false, 'tenant B must never see tenant A\'s audit events over the real route');
});
