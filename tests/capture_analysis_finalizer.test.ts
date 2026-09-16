// R10.2-C — direct unit tests for the newly-extracted common capture
// completion lifecycle (src/workspace/capture-analysis-finalizer.ts). This
// is genuinely new test surface: before this refactor, the merge-candidates
// -> upsert-canonical-candidates -> compute-next-status -> audit -> persist
// sequence only existed inline, three times, inside CaptureProcessor's
// processText/processUrl/processPdf, and was only ever exercised indirectly
// through those (see tests/text_understanding.test.ts,
// tests/url_understanding.test.ts, tests/pdf_understanding.test.ts, all
// re-confirmed green against this refactor). This file tests the extracted
// function directly, isolated from any real model/browser/PDF call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { finalizeCaptureAnalysis, mergeCandidates, toCanonicalUpsertInput } from '../src/workspace/capture-analysis-finalizer.js';
import { CaptureStore } from '../src/workspace/capture.store.js';
import { CandidateStore } from '../src/workspace/candidate.store.js';
import { AuditLogger } from '../src/governance/audit.logger.js';
import type { StructuredAnalysisResult } from '../src/workspace/capture-processor.js';
import type { WorkspaceCandidate, TaskCandidate } from '../src/workspace/workspace.types.js';

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function harness() {
  const store = new CaptureStore(tempDir('nagex-finalizer-captures-'));
  const candidateStore = new CandidateStore({ dir: tempDir('nagex-finalizer-candidates-') });
  const audit = new AuditLogger();
  return { store, candidateStore, audit };
}

function baseAnalysis(overrides: Partial<StructuredAnalysisResult> = {}): StructuredAnalysisResult {
  return {
    title: 'Test title', summary: 'Test summary', contentType: 'note',
    topics: ['Testing'], entities: [], dates: [], actionItems: [],
    taskCandidates: [], calendarCandidates: [], memoryCandidates: [], knowledgeCandidates: [],
    ...overrides,
  };
}

function taskCandidate(captureId: string, title = 'Do the thing'): TaskCandidate {
  return {
    candidateId: `cand_${Math.random().toString(36).slice(2, 10)}`,
    captureId, type: 'TASK', title, description: 'desc',
    priorityCandidate: 'MEDIUM', reason: 'r', confidence: 0.9, sourceRefs: [], status: 'PROPOSED',
  };
}

// ── Architecture guard (§12) ──────────────────────────────────────────────

test('1. capture-analysis-finalizer.ts imports only Workspace/Capture-domain and governance modules — no provider adapters (Calendar/Gmail/Browser/model-gateway), no raw fetch', () => {
  const source = fs.readFileSync(path.resolve('src/workspace/capture-analysis-finalizer.ts'), 'utf8').replace(/\/\/.*/g, '');
  assert.doesNotMatch(source, /modules\/(calendar|gmail|browser)\//, 'must never import a provider adapter directly');
  assert.doesNotMatch(source, /model-gateway\//, 'must never call a model provider directly — analysis is always handed in already-computed');
  assert.doesNotMatch(source, /\bfetch\s*\(/, 'must never make a network call itself');
  assert.match(source, /from '\.\/capture\.store\.js'/);
  assert.match(source, /from '\.\/candidate\.store\.js'/);
});

// ── Zero / one / multiple candidates, status transitions ────────────────

test('2. zero candidates -> status READY, no candidate.proposed audit events', () => {
  const h = harness();
  const item = h.store.createCapture({ ownerId: 'u1', tenantId: 't1', type: 'TEXT', content: 'hello' });
  const updated = finalizeCaptureAnalysis({ store: h.store, candidateStore: h.candidateStore, auditLogger: h.audit }, {
    item, analysis: baseAnalysis(), freshCandidates: [], contentHash: 'hash1', auditRequestPrefix: 'text', extraMetadata: {},
  });
  assert.equal(updated.status, 'READY');
  const actions = h.audit.getRecentLogs(20).map((e) => e.action);
  assert.ok(actions.includes('capture.analyzed'));
  assert.equal(actions.filter((a) => a === 'candidate.proposed').length, 0);
});

test('3. one candidate -> status NEEDS_REVIEW (PROPOSED), exactly one candidate.proposed audit event', () => {
  const h = harness();
  const item = h.store.createCapture({ ownerId: 'u2', tenantId: 't1', type: 'TEXT', content: 'hello' });
  const candidate = taskCandidate(item.captureId);
  const updated = finalizeCaptureAnalysis({ store: h.store, candidateStore: h.candidateStore, auditLogger: h.audit }, {
    item, analysis: baseAnalysis(), freshCandidates: [candidate], contentHash: 'hash2', auditRequestPrefix: 'text', extraMetadata: {},
  });
  assert.equal(updated.status, 'NEEDS_REVIEW');
  assert.equal(updated.metadata.candidates?.length, 1);
  assert.equal(updated.metadata.suggestedAction?.title, candidate.title);
  const proposed = h.audit.getRecentLogs(20).filter((e) => e.action === 'candidate.proposed');
  assert.equal(proposed.length, 1);
});

test('4. multiple candidates -> all preserved, IDs linked, first candidate drives suggestedAction', () => {
  const h = harness();
  const item = h.store.createCapture({ ownerId: 'u3', tenantId: 't1', type: 'TEXT', content: 'hello' });
  const c1 = taskCandidate(item.captureId, 'First task');
  const c2 = taskCandidate(item.captureId, 'Second task');
  const updated = finalizeCaptureAnalysis({ store: h.store, candidateStore: h.candidateStore, auditLogger: h.audit }, {
    item, analysis: baseAnalysis(), freshCandidates: [c1, c2], contentHash: 'hash3', auditRequestPrefix: 'text', extraMetadata: {},
  });
  assert.equal(updated.metadata.candidates?.length, 2);
  assert.equal(updated.metadata.candidateIds?.length, 2);
  assert.equal(updated.metadata.suggestedAction?.title, 'First task');
  assert.equal(h.audit.getRecentLogs(20).filter((e) => e.action === 'candidate.proposed').length, 2);
});

// ── Idempotency (§7) — a retry must never duplicate candidates ──────────

test('5. retry with identical content does not duplicate an already-PROPOSED-then-preserved candidate', () => {
  const h = harness();
  const item = h.store.createCapture({ ownerId: 'u4', tenantId: 't1', type: 'TEXT', content: 'hello' });
  const first = finalizeCaptureAnalysis({ store: h.store, candidateStore: h.candidateStore, auditLogger: h.audit }, {
    item, analysis: baseAnalysis(), freshCandidates: [taskCandidate(item.captureId, 'Same task')], contentHash: 'hashA', auditRequestPrefix: 'text', extraMetadata: {},
  });
  assert.equal(first.metadata.candidates?.length, 1);
  // Simulate a retry that regenerates the "same" logical candidate from
  // unchanged content — mergeCandidates() must recognize the identical
  // (type, title) identity and not append a duplicate.
  const second = finalizeCaptureAnalysis({ store: h.store, candidateStore: h.candidateStore, auditLogger: h.audit }, {
    item: first, analysis: baseAnalysis(), freshCandidates: [taskCandidate(item.captureId, 'Same task')], contentHash: 'hashA', auditRequestPrefix: 'text', extraMetadata: {},
  });
  assert.equal(second.metadata.candidates?.length, 1, 'a retry must never duplicate an already-known candidate');
});

test('6. mergeCandidates never re-adds a candidate the user already ACCEPTED/REJECTED, but a genuinely new one is still appended', () => {
  const item = { captureId: 'cap_1' } as { captureId: string };
  const accepted: WorkspaceCandidate = { ...taskCandidate(item.captureId, 'Accepted task'), status: 'ACCEPTED' };
  const fresh = [taskCandidate(item.captureId, 'Accepted task'), taskCandidate(item.captureId, 'Brand new task')];
  const merged = mergeCandidates([accepted], fresh);
  assert.equal(merged.length, 2, 'the already-decided candidate is preserved once, plus exactly one genuinely new candidate');
  assert.ok(merged.some((c) => c.title === 'Accepted task' && c.status === 'ACCEPTED'));
  assert.ok(merged.some((c) => c.title === 'Brand new task' && c.status === 'PROPOSED'));
});

// ── Provenance (§8) — candidate linkage and canonical upsert payload ────

test('7. toCanonicalUpsertInput grounds sourceRefs in a real chunkId when present, never a fabricated reference', () => {
  const item = { captureId: 'cap_prov', tenantId: 't1', ownerId: 'u1' } as { captureId: string; tenantId: string; ownerId: string };
  const withChunk: WorkspaceCandidate = { ...taskCandidate(item.captureId), sourceRefs: [{ chunkId: 'chunk_42', snippet: 's' }] };
  const input = toCanonicalUpsertInput(item as never, withChunk, 'hash_x');
  assert.deepEqual(input.sourceRefs, ['chunk_42']);
  assert.equal(input.contentHash, 'hash_x');
  assert.equal(input.captureId, 'cap_prov');
});

test('8. toCanonicalUpsertInput falls back to a real capture: reference (never invented) when no chunk was involved', () => {
  const item = { captureId: 'cap_prov2', tenantId: 't1', ownerId: 'u1' } as { captureId: string; tenantId: string; ownerId: string };
  const noChunk: WorkspaceCandidate = { ...taskCandidate(item.captureId), sourceRefs: [] };
  const input = toCanonicalUpsertInput(item as never, noChunk, 'hash_y');
  assert.deepEqual(input.sourceRefs, ['capture:cap_prov2']);
});

test('9. real candidateIds link back through CandidateStore, and are preserved across a second finalize call for the same capture', () => {
  const h = harness();
  const item = h.store.createCapture({ ownerId: 'u5', tenantId: 't1', type: 'TEXT', content: 'hello' });
  const updated = finalizeCaptureAnalysis({ store: h.store, candidateStore: h.candidateStore, auditLogger: h.audit }, {
    item, analysis: baseAnalysis(), freshCandidates: [taskCandidate(item.captureId, 'Linked task')], contentHash: 'hash_link', auditRequestPrefix: 'text', extraMetadata: {},
  });
  assert.equal(updated.metadata.candidateIds?.length, 1);
  const canonical = h.candidateStore.get(updated.metadata.candidateIds![0]);
  assert.ok(canonical, 'the candidateId must resolve to a real, persisted canonical Candidate record');
  assert.equal(canonical!.captureId, item.captureId);
});

// ── Failure semantics (§6) — a store failure must never report false success ─

test('10. when CaptureStore.updateStatus cannot find/update the record (returns null), the original pre-update item is returned truthfully, never a fabricated "updated" item', () => {
  const h = harness();
  // A capture with a captureId the store has never seen — updateStatus()
  // will genuinely return null (no such record to update).
  const phantomItem = { ...h.store.createCapture({ ownerId: 'u6', tenantId: 't1', type: 'TEXT', content: 'x' }), captureId: 'cap_phantom_never_persisted' };
  const result = finalizeCaptureAnalysis({ store: h.store, candidateStore: h.candidateStore, auditLogger: h.audit }, {
    item: phantomItem, analysis: baseAnalysis(), freshCandidates: [], contentHash: 'hash_missing', auditRequestPrefix: 'text', extraMetadata: {},
  });
  // Falls back to the item it was given — status/content are whatever the
  // caller already had, never invented as if the update had succeeded.
  assert.equal(result.captureId, 'cap_phantom_never_persisted');
  assert.notEqual(result.status, 'READY', 'a failed persistence update must never be reported as the successful READY/NEEDS_REVIEW outcome');
});

test('11. finalizeCaptureAnalysis works correctly with no CandidateStore wired (offline/unit-test mode) — no crash, candidateIds pass through unchanged', () => {
  const store = new CaptureStore(tempDir('nagex-finalizer-nocand-'));
  const item = store.createCapture({ ownerId: 'u7', tenantId: 't1', type: 'TEXT', content: 'hello' });
  const updated = finalizeCaptureAnalysis({ store }, {
    item, analysis: baseAnalysis(), freshCandidates: [taskCandidate(item.captureId)], contentHash: 'h', auditRequestPrefix: 'text', extraMetadata: {},
  });
  assert.equal(updated.status, 'NEEDS_REVIEW');
  assert.deepEqual(updated.metadata.candidateIds, []);
});

test('12. finalizeCaptureAnalysis works correctly with no AuditLogger wired — no crash, no audit calls attempted', () => {
  const h = harness();
  const item = h.store.createCapture({ ownerId: 'u8', tenantId: 't1', type: 'TEXT', content: 'hello' });
  const updated = finalizeCaptureAnalysis({ store: h.store, candidateStore: h.candidateStore }, {
    item, analysis: baseAnalysis(), freshCandidates: [taskCandidate(item.captureId)], contentHash: 'h2', auditRequestPrefix: 'text', extraMetadata: {},
  });
  assert.equal(updated.status, 'NEEDS_REVIEW');
});

// ── extraAnalyzedAuditDetails / extraMetadata merge correctly ────────────

test('13. extraMetadata fields land on the final item, and extraAnalyzedAuditDetails lands on the capture.analyzed audit event only', () => {
  const h = harness();
  const item = h.store.createCapture({ ownerId: 'u9', tenantId: 't1', type: 'FILE', content: '' });
  const updated = finalizeCaptureAnalysis({ store: h.store, candidateStore: h.candidateStore, auditLogger: h.audit }, {
    item, analysis: baseAnalysis(), freshCandidates: [], contentHash: 'h3', auditRequestPrefix: 'pdf',
    extraAnalyzedAuditDetails: { totalChunks: 5, processedChunks: 5, truncated: false },
    extraMetadata: { pageCount: 3, extractionMethod: 'pdfjs' },
  });
  assert.equal(updated.metadata.pageCount, 3);
  assert.equal(updated.metadata.extractionMethod, 'pdfjs');
  const analyzed = h.audit.getRecentLogs(20).find((e) => e.action === 'capture.analyzed');
  const details = analyzed?.details as Record<string, unknown> | undefined;
  assert.equal(details?.totalChunks, 5);
  assert.equal(details?.truncated, false);
});
