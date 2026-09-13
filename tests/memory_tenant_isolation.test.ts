// Memory Tenant Isolation Correction.
//
// MemoryRecord had no tenantId at all — only owner_id. getActiveMemories/
// activateMemory/deleteMemory were tenant-blind or fully unscoped, and
// getRelevantMemories(principalId, prompt) — the sole memory-injection
// point for every Task/Plan/Workflow run's AI context, and for the Ambient/
// Telegram/Slack channels — was tenant-blind too: a cross-tenant
// principal-id collision could leak one tenant's private memory content
// into another tenant's AI-generated output, not just an API response.
//
// These tests prove the fix: every MemoryEngine operation is now scoped by
// tenantId + owner_id (a wrong tenant or wrong owner is externally
// indistinguishable from a genuinely nonexistent id, mirroring the
// requireOwned() pattern already used by TaskStore/CandidateStore/
// WorkflowDefinitionStore/ActionApprovalStore), the AI context retrieval
// root is tenant-scoped end to end, legacy pre-tenantId records are
// durably backfilled to the canonical default tenant exactly once, and the
// HTTP memory routes/provider writes/Candidate-to-Memory path never drop
// tenant identity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryEngine } from '../src/context/memory.engine.js';
import { NagexError } from '../src/common/errors.js';
import { ActionApprovalStore } from '../src/governance/action-approval.store.js';
import { AuditLogger } from '../src/governance/audit.logger.js';
import { ExecutionStore } from '../src/governance/execution.store.js';
import { GoogleCalendarService } from '../src/modules/calendar/index.js';
import { GmailService, GMAIL_SEND_EMAIL_TOOL_ID } from '../src/modules/gmail/index.js';
import { BrowserToolService } from '../src/modules/browser/index.js';
import { BrowserSessionStore } from '../src/modules/browser/browser-session.store.js';
import { CaptureStore } from '../src/workspace/capture.store.js';
import { CandidateStore } from '../src/workspace/candidate.store.js';
import { CandidateActionResolver } from '../src/workspace/action-resolver.js';
import { createNagexApplication } from '../src/app/create-nagex-application.js';
import { handleApiRequest } from '../src/server_web.js';

function tmpDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `nagex-mem-iso-${label}-`));
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function calendarPayload(overrides: Record<string, unknown> = {}) {
  return {
    calendarId: 'primary',
    summary: 'Memory Isolation Test Event',
    description: 'Created by memory_tenant_isolation.test.ts.',
    start: '2026-10-01T17:00:00.000Z',
    end: '2026-10-01T17:30:00.000Z',
    timezone: 'America/Los_Angeles',
    attendees: [],
    ...overrides,
  };
}

function gmailPayload(overrides: Record<string, unknown> = {}) {
  return {
    from: 'me',
    to: ['client@example.com'],
    cc: [],
    bcc: [],
    subject: 'Memory Isolation Test',
    body: 'Body.',
    attachments: [],
    threadId: null,
    replyToMessageId: null,
    ...overrides,
  };
}

// ── 1-4: core cross-tenant isolation, same principal ────────────────────

test('1. cross-tenant list isolation: Tenant B never sees Tenant A\'s USER memory', () => {
  const engine = new MemoryEngine({ dir: tmpDir('1') });
  const rec = engine.proposeMemory('USER', 'ten_a', 'usr_shared', { subject: 'Secret A', predicate: 'is', value: 'only for tenant A' });
  engine.activateMemory(rec.id, 'ten_a', 'usr_shared');

  assert.equal(engine.getActiveMemories('USER', 'ten_a', 'usr_shared').length, 1);
  assert.equal(engine.getActiveMemories('USER', 'ten_b', 'usr_shared').length, 0);
});

test('2. cross-tenant get isolation: wrong tenant is indistinguishable from a nonexistent id', () => {
  const engine = new MemoryEngine({ dir: tmpDir('2') });
  const rec = engine.proposeMemory('USER', 'ten_a', 'usr_shared', { subject: 'X', predicate: 'is', value: 1 });
  assert.ok(engine.get(rec.id, 'ten_a', 'usr_shared'));
  assert.equal(engine.get(rec.id, 'ten_b', 'usr_shared'), engine.get('mem_does_not_exist', 'ten_a', 'usr_shared'));
});

test('3. cross-tenant activate is blocked and never mutates the real record', () => {
  const engine = new MemoryEngine({ dir: tmpDir('3') });
  const rec = engine.proposeMemory('USER', 'ten_a', 'usr_shared', { subject: 'X', predicate: 'is', value: 1 });
  assert.throws(() => engine.activateMemory(rec.id, 'ten_b', 'usr_shared'), (err: unknown) => err instanceof NagexError && err.code === 'MEMORY_NOT_FOUND');
  // The real record must remain exactly as it was — still PROPOSED, still
  // readable and activatable by the rightful tenant.
  const activated = engine.activateMemory(rec.id, 'ten_a', 'usr_shared');
  assert.equal(activated.lifecycle, 'ACTIVE');
});

test('4. cross-tenant delete is blocked and never removes the real record', () => {
  const engine = new MemoryEngine({ dir: tmpDir('4') });
  const rec = engine.proposeMemory('USER', 'ten_a', 'usr_shared', { subject: 'X', predicate: 'is', value: 1 });
  engine.activateMemory(rec.id, 'ten_a', 'usr_shared');
  assert.throws(() => engine.deleteMemory(rec.id, 'ten_b', 'usr_shared'), (err: unknown) => err instanceof NagexError && err.code === 'MEMORY_NOT_FOUND');
  assert.ok(engine.get(rec.id, 'ten_a', 'usr_shared'), 'the real record must survive a blocked cross-tenant delete attempt');
});

// ── 5-7: same-tenant, wrong-principal isolation ─────────────────────────

test('5. same-tenant wrong-principal list/get isolation', () => {
  const engine = new MemoryEngine({ dir: tmpDir('5') });
  const rec = engine.proposeMemory('USER', 'ten_same', 'usr_a', { subject: 'X', predicate: 'is', value: 1 });
  engine.activateMemory(rec.id, 'ten_same', 'usr_a');

  assert.equal(engine.getActiveMemories('USER', 'ten_same', 'usr_b').length, 0);
  assert.equal(engine.get(rec.id, 'ten_same', 'usr_b'), undefined);
});

test('6. same-tenant wrong-principal activate/delete are blocked, leaving the real record untouched', () => {
  const engine = new MemoryEngine({ dir: tmpDir('6') });
  const rec = engine.proposeMemory('USER', 'ten_same', 'usr_a', { subject: 'X', predicate: 'is', value: 1 });

  assert.throws(() => engine.activateMemory(rec.id, 'ten_same', 'usr_b'), (err: unknown) => err instanceof NagexError && err.code === 'MEMORY_NOT_FOUND');
  engine.activateMemory(rec.id, 'ten_same', 'usr_a');
  assert.throws(() => engine.deleteMemory(rec.id, 'ten_same', 'usr_b'), (err: unknown) => err instanceof NagexError && err.code === 'MEMORY_NOT_FOUND');
  assert.ok(engine.get(rec.id, 'ten_same', 'usr_a'));
});

test('7. wrong-tenant and wrong-principal produce the identical MEMORY_NOT_FOUND response as a genuinely nonexistent record', () => {
  const engine = new MemoryEngine({ dir: tmpDir('7') });
  const rec = engine.proposeMemory('USER', 'ten_a', 'usr_a', { subject: 'X', predicate: 'is', value: 1 });

  const capture = (fn: () => unknown): NagexError => {
    try { fn(); } catch (err) { return err as NagexError; }
    throw new Error('expected fn to throw');
  };
  const wrongTenant = capture(() => engine.activateMemory(rec.id, 'ten_b', 'usr_a'));
  const wrongPrincipal = capture(() => engine.activateMemory(rec.id, 'ten_a', 'usr_b'));
  const nonexistent = capture(() => engine.activateMemory('mem_does_not_exist', 'ten_a', 'usr_a'));

  assert.equal(wrongTenant.code, 'MEMORY_NOT_FOUND');
  assert.equal(wrongPrincipal.code, 'MEMORY_NOT_FOUND');
  assert.equal(nonexistent.code, 'MEMORY_NOT_FOUND');
  assert.equal(wrongTenant.category, nonexistent.category);
  assert.equal(wrongPrincipal.category, nonexistent.category);
});

// ── 8: TENANT-scope regression — semantics preserved, not redesigned ────

test('8. TENANT-scope regression: same tenant + same owner_id stays visible, different tenant + same owner_id is isolated', () => {
  const engine = new MemoryEngine({ dir: tmpDir('8') });
  const rec = engine.proposeMemory('TENANT', 'ten_a', 'usr_shared', { subject: 'Company Policy', predicate: 'is', value: 'X' });
  engine.activateMemory(rec.id, 'ten_a', 'usr_shared');

  assert.equal(engine.getActiveMemories('TENANT', 'ten_a', 'usr_shared').length, 1);
  assert.equal(engine.getActiveMemories('TENANT', 'ten_b', 'usr_shared').length, 0, 'TENANT scope must not become shared visibility across tenants in this correction');
});

// ── 9: AI context isolation — the decisive security test ────────────────

test('9. getRelevantMemories() never leaks Tenant A content into Tenant B\'s AI context, even under a same-principal-id collision', () => {
  const dir = tmpDir('9');
  const oldDir = process.env.NAGEX_MEMORIES_DIR;
  process.env.NAGEX_MEMORIES_DIR = dir;
  try {
    const app = createNagexApplication();
    const distinctivePhrase = 'ZQXPHRASE_TENANT_A_ONLY_9f3c';
    const rec = app.memoryEngine.proposeMemory('USER', 'ten_ai_a', 'usr_same', { subject: 'Secret Project', predicate: 'codename', value: distinctivePhrase });
    app.memoryEngine.activateMemory(rec.id, 'ten_ai_a', 'usr_same');

    const promptMentioningPhrase = `Tell me about ${distinctivePhrase} secret project codename`;

    const tenantAResults = app.getRelevantMemories('ten_ai_a', 'usr_same', promptMentioningPhrase);
    assert.ok(tenantAResults.some((m) => JSON.stringify(m.content).includes(distinctivePhrase)), 'tenant A must retrieve its own memory for a matching prompt');

    const tenantBResults = app.getRelevantMemories('ten_ai_b', 'usr_same', promptMentioningPhrase);
    assert.equal(tenantBResults.some((m) => JSON.stringify(m.content).includes(distinctivePhrase)), false, 'tenant B must never see tenant A\'s memory content, even with the identical principalId and a prompt that would otherwise match');
  } finally {
    if (oldDir !== undefined) process.env.NAGEX_MEMORIES_DIR = oldDir; else delete process.env.NAGEX_MEMORIES_DIR;
  }
});

// ── 10-13: HTTP route ownership ──────────────────────────────────────────

test('10. GET /api/v1/memory only returns the caller\'s own tenant + principal memories', () => {
  const dir = tmpDir('10');
  const oldDir = process.env.NAGEX_MEMORIES_DIR;
  process.env.NAGEX_MEMORIES_DIR = dir;
  try {
    handleApiRequest('POST', '/api/v1/memory', { subject: 'HTTP Isolation A', predicate: 'note', value: 'a' }, { 'x-nagex-tenant': 'ten_http_a', 'x-principal-id': 'usr_http_shared' });
    handleApiRequest('POST', '/api/v1/memory', { subject: 'HTTP Isolation B', predicate: 'note', value: 'b' }, { 'x-nagex-tenant': 'ten_http_b', 'x-principal-id': 'usr_http_shared' });

    const asA = handleApiRequest('GET', '/api/v1/memory', null, { 'x-nagex-tenant': 'ten_http_a', 'x-principal-id': 'usr_http_shared' });
    const dataA = asA.data as { memories: Array<{ content: { subject: string } }> };
    assert.ok(dataA.memories.some((m) => m.content.subject === 'HTTP Isolation A'));
    assert.equal(dataA.memories.some((m) => m.content.subject === 'HTTP Isolation B'), false, 'tenant A must never see tenant B\'s memory over the API');
  } finally {
    if (oldDir !== undefined) process.env.NAGEX_MEMORIES_DIR = oldDir; else delete process.env.NAGEX_MEMORIES_DIR;
  }
});

test('11. DELETE /api/v1/memory/:id from the wrong tenant is blocked; the real record survives', () => {
  const dir = tmpDir('11');
  const oldDir = process.env.NAGEX_MEMORIES_DIR;
  process.env.NAGEX_MEMORIES_DIR = dir;
  try {
    const created = handleApiRequest('POST', '/api/v1/memory', { subject: 'HTTP Delete Test', predicate: 'note', value: 'x' }, { 'x-nagex-tenant': 'ten_http_del_a', 'x-principal-id': 'usr_http_del' });
    const memId = (created.data as { id: string }).id;

    const blocked = handleApiRequest('DELETE', `/api/v1/memory/${memId}`, null, { 'x-nagex-tenant': 'ten_http_del_b', 'x-principal-id': 'usr_http_del' });
    assert.equal(blocked.status, 404);
    assert.equal((blocked.data as { error: { code: string } }).error.code, 'MEMORY_NOT_FOUND');

    const stillThere = handleApiRequest('GET', '/api/v1/memory', null, { 'x-nagex-tenant': 'ten_http_del_a', 'x-principal-id': 'usr_http_del' });
    const stillData = stillThere.data as { memories: Array<{ id: string }> };
    assert.ok(stillData.memories.some((m) => m.id === memId), 'the real record must survive a blocked cross-tenant delete attempt');
  } finally {
    if (oldDir !== undefined) process.env.NAGEX_MEMORIES_DIR = oldDir; else delete process.env.NAGEX_MEMORIES_DIR;
  }
});

test('12. PUT /api/v1/memory/:id/pin from the wrong tenant is blocked and never mutates pinnedMemories', () => {
  const dir = tmpDir('12');
  const oldDir = process.env.NAGEX_MEMORIES_DIR;
  process.env.NAGEX_MEMORIES_DIR = dir;
  try {
    const created = handleApiRequest('POST', '/api/v1/memory', { subject: 'HTTP Pin Test', predicate: 'note', value: 'x' }, { 'x-nagex-tenant': 'ten_http_pin_a', 'x-principal-id': 'usr_http_pin' });
    const memId = (created.data as { id: string }).id;

    const blocked = handleApiRequest('PUT', `/api/v1/memory/${memId}/pin`, null, { 'x-nagex-tenant': 'ten_http_pin_b', 'x-principal-id': 'usr_http_pin' });
    assert.equal(blocked.status, 404);
    assert.equal((blocked.data as { error: string }).error, 'MEMORY_NOT_FOUND');

    const rightful = handleApiRequest('GET', '/api/v1/memory', null, { 'x-nagex-tenant': 'ten_http_pin_a', 'x-principal-id': 'usr_http_pin' });
    const rightfulData = rightful.data as { memories: Array<{ id: string; pinned: boolean }> };
    const record = rightfulData.memories.find((m) => m.id === memId);
    assert.equal(record?.pinned, false, 'a blocked cross-tenant pin attempt must never mutate pin state');
  } finally {
    if (oldDir !== undefined) process.env.NAGEX_MEMORIES_DIR = oldDir; else delete process.env.NAGEX_MEMORIES_DIR;
  }
});

test('13. PUT /api/v1/memory/:id/pin by the rightful tenant + principal works', () => {
  const dir = tmpDir('13');
  const oldDir = process.env.NAGEX_MEMORIES_DIR;
  process.env.NAGEX_MEMORIES_DIR = dir;
  try {
    const created = handleApiRequest('POST', '/api/v1/memory', { subject: 'HTTP Pin Rightful', predicate: 'note', value: 'x' }, { 'x-nagex-tenant': 'ten_http_pin_ok', 'x-principal-id': 'usr_http_pin_ok' });
    const memId = (created.data as { id: string }).id;

    const pinned = handleApiRequest('PUT', `/api/v1/memory/${memId}/pin`, null, { 'x-nagex-tenant': 'ten_http_pin_ok', 'x-principal-id': 'usr_http_pin_ok' });
    assert.equal(pinned.status, 200);
    assert.equal((pinned.data as { pinned: boolean }).pinned, true);
  } finally {
    if (oldDir !== undefined) process.env.NAGEX_MEMORIES_DIR = oldDir; else delete process.env.NAGEX_MEMORIES_DIR;
  }
});

// ── 14-16: provider write tests — real tenant identity preserved ────────

test('14. GoogleCalendarService writes the created Memory under the real request tenant, never a hardcoded one', async () => {
  const tokenStore: any = { getValidAccessToken: async () => 'mock_token' };
  const approvals = new ActionApprovalStore();
  const audit = new AuditLogger();
  const memory = new MemoryEngine({ dir: tmpDir('14') });
  const executions = new ExecutionStore({ dir: tmpDir('14_exec') });
  const fetchFn: typeof fetch = async () => jsonResponse({ id: 'gcal_evt_mem_iso', htmlLink: 'https://calendar.google.com/event?eid=mem_iso' });
  const service = new GoogleCalendarService(tokenStore, approvals, audit, memory, fetchFn, () => ({ clientId: 'cid', clientSecret: 'csecret', redirectUri: 'https://example.com/callback' }), executions);

  const requested = service.requestCreateEventApproval({ tenantId: 'ten_live_cal', principalId: 'usr_live_cal', payload: calendarPayload(), requestId: 'req_1' });
  service.approve(requested.approvalId, 'ten_live_cal', 'usr_live_cal', 'req_2');
  await service.executeCreateEvent({ approvalId: requested.approvalId, payload: calendarPayload(), tenantId: 'ten_live_cal', principalId: 'usr_live_cal', requestId: 'req_3' });

  const memories = memory.getActiveMemories('USER', 'ten_live_cal', 'usr_live_cal');
  assert.equal(memories.length, 1);
  assert.equal(memories[0].tenantId, 'ten_live_cal', 'the real request tenant must be preserved on the provider-created Memory, never ten_production_01');
  assert.equal(memory.getActiveMemories('USER', 'ten_production_01', 'usr_live_cal').length, 0, 'must never fall back to the default tenant for a real provider action');
});

test('15. GmailService writes the created Memory under the real request tenant', async () => {
  const tokenStore: any = { getValidAccessToken: async () => 'mock_token' };
  const approvals = new ActionApprovalStore();
  const audit = new AuditLogger();
  const memory = new MemoryEngine({ dir: tmpDir('15') });
  const executions = new ExecutionStore({ dir: tmpDir('15_exec') });
  const fetchFn: typeof fetch = async () => jsonResponse({ id: 'gmail_msg_mem_iso', threadId: 'gmail_thread_mem_iso' });
  const service = new GmailService(tokenStore, approvals, audit, memory, fetchFn, () => ({ clientId: 'cid', clientSecret: 'csecret', redirectUri: 'https://example.com/callback' }), executions);

  const requested = service.requestApproval({ toolId: GMAIL_SEND_EMAIL_TOOL_ID, tenantId: 'ten_live_gmail', principalId: 'usr_live_gmail', payload: gmailPayload(), requestId: 'req_1' });
  service.approve(requested.approvalId, 'ten_live_gmail', 'usr_live_gmail', 'req_2');
  await service.executeSendEmail({ approvalId: requested.approvalId, payload: gmailPayload(), tenantId: 'ten_live_gmail', principalId: 'usr_live_gmail', requestId: 'req_3' });

  const memories = memory.getActiveMemories('USER', 'ten_live_gmail', 'usr_live_gmail');
  assert.equal(memories.length, 1);
  assert.equal(memories[0].tenantId, 'ten_live_gmail');
});

test('16. BrowserToolService writes the created Memory under the real request tenant', async () => {
  const runtime: any = {
    openSession: async () => ({ url: 'https://example.com', title: 'Example' }),
    closeSession: async () => {},
    resolveSelector: async () => ({ count: 1, text: 'Submit Order', isFormControl: true, role: 'button' }),
    click: async () => {},
    snapshot: async () => ({ url: 'https://example.com', title: 'Example', text: 'Example content' }),
  };
  const sessions = new BrowserSessionStore();
  const approvals = new ActionApprovalStore();
  const audit = new AuditLogger();
  const memory = new MemoryEngine({ dir: tmpDir('16') });
  const executions = new ExecutionStore({ dir: tmpDir('16_exec') });
  const service = new BrowserToolService(runtime, sessions, approvals, audit, memory, executions, tmpDir('16_evidence'), () => true);

  const input = { tenantId: 'ten_live_browser', ownerId: 'usr_live_browser', requestId: 'req_1' };
  const session = await service.open(input);
  const sInput = { ...input, browserSessionId: session.browserSessionId };

  const clickRes = await service.click({ ...sInput, selector: 'button#submit-order', forceApproval: true });
  assert.equal(clickRes.status, 'APPROVAL_REQUIRED');
  const approvalId = (clickRes as { approval: { approvalId: string } }).approval.approvalId;
  service.approve(approvalId, 'ten_live_browser', 'usr_live_browser', 'req_2');
  await service.executeApprovedClick({ approvalId, browserSessionId: session.browserSessionId, selector: 'button#submit-order', tenantId: 'ten_live_browser', ownerId: 'usr_live_browser', requestId: 'req_3' });

  const memories = memory.getActiveMemories('USER', 'ten_live_browser', 'usr_live_browser');
  assert.equal(memories.length, 1);
  assert.equal(memories[0].tenantId, 'ten_live_browser');
});

// ── 17: Candidate → Memory ownership ─────────────────────────────────────

test('17. accepting a MEMORY candidate creates a Memory record whose tenant/owner exactly match the Candidate\'s own, never a body/payload field', async () => {
  const dir = tmpDir('17');
  const captureStore = new CaptureStore(tmpDir('17_cap'));
  const item = captureStore.createCapture({ ownerId: 'usr_cand_mem', tenantId: 'ten_cand_mem', type: 'TEXT', content: 'Prefers async updates', metadata: {} });
  const cap = captureStore.updateStatus(item.captureId, 'READY', { contentHash: 'hash_cand_mem' })!;

  const candidateStore = new CandidateStore({ dir: tmpDir('17_cand') });
  const cand = candidateStore.upsert({
    tenantId: 'ten_cand_mem',
    principalId: 'usr_cand_mem',
    captureId: cap.captureId,
    contentHash: 'hash_cand_mem',
    sourceRefs: [`capture:${cap.captureId}`],
    title: 'Remember preference',
    type: 'MEMORY',
    payload: { statement: 'Prefers async updates' },
  });
  candidateStore.accept(cand.candidateId, 'ten_cand_mem', 'usr_cand_mem');

  const memoryEngine = new MemoryEngine({ dir });
  const resolver = new CandidateActionResolver({ candidateStore, captureStore, memoryEngine });
  const result = await resolver.executeCandidate(cand.candidateId, 'ten_cand_mem', 'usr_cand_mem');

  assert.equal(result.action?.status, 'SUCCEEDED');
  const memId = result.action?.targetId as string;
  const created = memoryEngine.get(memId, 'ten_cand_mem', 'usr_cand_mem');
  assert.ok(created, 'the resulting Memory must be owned by the exact candidate tenant + principal');
  assert.equal(created!.tenantId, 'ten_cand_mem');
  assert.equal(created!.owner_id, 'usr_cand_mem');

  // A different tenant sharing no relationship to this candidate must never see it.
  assert.equal(memoryEngine.getActiveMemories('USER', 'ten_other', 'usr_cand_mem').length, 0);
});

// ── 18-20: legacy backfill ────────────────────────────────────────────────

test('18. a legacy record with no tenantId loads, is durably backfilled to ten_production_01, and survives restart without duplication', () => {
  const dir = tmpDir('18');
  const legacy = {
    id: 'mem_legacy_iso_001',
    scope: 'USER',
    owner_id: 'usr_legacy_iso',
    lifecycle: 'ACTIVE',
    content: { subject: 'Legacy', predicate: 'is', value: 'old' },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'mem_legacy_iso_001.json'), JSON.stringify(legacy), 'utf8');

  const engine1 = new MemoryEngine({ dir });
  const active1 = engine1.getActiveMemories('USER', 'ten_production_01', 'usr_legacy_iso');
  assert.equal(active1.length, 1);
  assert.equal(active1[0].tenantId, 'ten_production_01');

  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'mem_legacy_iso_001.json'), 'utf8'));
  assert.equal(onDisk.tenantId, 'ten_production_01', 'the backfill must be durably written to disk, not held only in memory');

  // Restart: the same record loads once, with no duplicate, and no repeated backfill needed.
  const engine2 = new MemoryEngine({ dir });
  const active2 = engine2.getActiveMemories('USER', 'ten_production_01', 'usr_legacy_iso');
  assert.equal(active2.length, 1);
  assert.equal(active2[0].id, 'mem_legacy_iso_001');
  const filesInDir = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.equal(filesInDir.length, 1, 'no duplicate record file may be created by a repeated backfill attempt');
});

test('19. a disk write failure during legacy backfill stops startup and never leaves a partially upgraded record usable', () => {
  const dir = tmpDir('19');
  const legacy = {
    id: 'mem_legacy_iso_fail_001',
    scope: 'USER',
    owner_id: 'usr_legacy_iso_fail',
    lifecycle: 'ACTIVE',
    content: { subject: 'Legacy', predicate: 'is', value: 'old' },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'mem_legacy_iso_fail_001.json'), JSON.stringify(legacy), 'utf8');

  const originalRename = fs.renameSync;
  (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = () => {
    throw new Error('Simulated disk failure during legacy backfill');
  };
  try {
    assert.throws(() => new MemoryEngine({ dir }), /Simulated disk failure during legacy backfill/);
  } finally {
    (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = originalRename;
  }

  // The original on-disk record must be untouched by the aborted attempt —
  // a fresh, unpatched construction can still recover and backfill it.
  const onDiskAfterFailedAttempt = JSON.parse(fs.readFileSync(path.join(dir, 'mem_legacy_iso_fail_001.json'), 'utf8'));
  assert.equal(onDiskAfterFailedAttempt.tenantId, undefined, 'a failed backfill attempt must never leave a half-written tenantId on the original record');

  const recovered = new MemoryEngine({ dir });
  const active = recovered.getActiveMemories('USER', 'ten_production_01', 'usr_legacy_iso_fail');
  assert.equal(active.length, 1, 'the legacy record must still be recoverable and backfillable on a later, unpatched attempt');
});

// ── 20: seed regression ───────────────────────────────────────────────────

test('20. exactly 4 seed memories exist, stamped with the canonical default tenant, with stable IDs across restart', () => {
  const dir = tmpDir('20');
  const oldDir = process.env.NAGEX_MEMORIES_DIR;
  process.env.NAGEX_MEMORIES_DIR = dir;
  try {
    const app1 = createNagexApplication();
    const seeds1 = [
      ...app1.memoryEngine.getActiveMemories('USER', 'ten_production_01', 'usr_admin_001'),
      ...app1.memoryEngine.getActiveMemories('SESSION', 'ten_production_01', 'usr_admin_001'),
    ];
    assert.equal(seeds1.length, 4, 'exactly 4 seed memories must exist');
    for (const seed of seeds1) {
      assert.equal(seed.tenantId, 'ten_production_01');
      assert.equal(seed.owner_id, 'usr_admin_001');
    }
    const ids1 = seeds1.map((m) => m.id).sort();

    const app2 = createNagexApplication();
    const seeds2 = [
      ...app2.memoryEngine.getActiveMemories('USER', 'ten_production_01', 'usr_admin_001'),
      ...app2.memoryEngine.getActiveMemories('SESSION', 'ten_production_01', 'usr_admin_001'),
    ];
    assert.equal(seeds2.length, 4, 'restart must not duplicate seed memories');
    assert.deepEqual(seeds2.map((m) => m.id).sort(), ids1, 'seed IDs must remain stable across restart');
  } finally {
    if (oldDir !== undefined) process.env.NAGEX_MEMORIES_DIR = oldDir; else delete process.env.NAGEX_MEMORIES_DIR;
  }
});

// ── 21: ownership-blocked mutation never reaches storage ─────────────────

test('21. a blocked cross-tenant activate/delete attempt never calls into the underlying file store', () => {
  const engine = new MemoryEngine({ dir: tmpDir('21') });
  const rec = engine.proposeMemory('USER', 'ten_a', 'usr_shared', { subject: 'S', predicate: 'is', value: 1 });

  let writeCalls = 0;
  const originalWrite = (engine as any).fileStore.writeOrThrow.bind((engine as any).fileStore);
  (engine as any).fileStore.writeOrThrow = (...args: unknown[]) => { writeCalls++; return originalWrite(...args); };
  assert.throws(() => engine.activateMemory(rec.id, 'ten_b', 'usr_shared'), (err: unknown) => err instanceof NagexError && err.code === 'MEMORY_NOT_FOUND');
  assert.equal(writeCalls, 0, 'a blocked cross-tenant activate must never reach fileStore.writeOrThrow');

  engine.activateMemory(rec.id, 'ten_a', 'usr_shared');

  let removeCalls = 0;
  const originalRemove = (engine as any).fileStore.removeOrThrow.bind((engine as any).fileStore);
  (engine as any).fileStore.removeOrThrow = (...args: unknown[]) => { removeCalls++; return originalRemove(...args); };
  assert.throws(() => engine.deleteMemory(rec.id, 'ten_b', 'usr_shared'), (err: unknown) => err instanceof NagexError && err.code === 'MEMORY_NOT_FOUND');
  assert.equal(removeCalls, 0, 'a blocked cross-tenant delete must never reach fileStore.removeOrThrow');
});

// ── 22: restart — tenantId, rightful retrieval, and isolation all survive ─

test('22. tenantId, rightful retrieval, and cross-tenant isolation all survive a fresh MemoryEngine instance over the same directory', () => {
  const dir = tmpDir('22');
  const engine1 = new MemoryEngine({ dir });
  const rec = engine1.proposeMemory('USER', 'ten_restart_a', 'usr_restart', { subject: 'Restart Test', predicate: 'is', value: 'ok' });
  engine1.activateMemory(rec.id, 'ten_restart_a', 'usr_restart');

  const engine2 = new MemoryEngine({ dir });
  const rightful = engine2.get(rec.id, 'ten_restart_a', 'usr_restart');
  assert.ok(rightful, 'rightful owner must still retrieve the record after restart');
  assert.equal(rightful!.tenantId, 'ten_restart_a');
  assert.equal(engine2.get(rec.id, 'ten_restart_b', 'usr_restart'), undefined, 'cross-tenant isolation must survive restart');
});
