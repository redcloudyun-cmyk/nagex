import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CaptureStore } from '../src/workspace/capture.store.js';
import { QuickCaptureService } from '../src/workspace/quick-capture.service.js';
import { handleAsyncApiRequest } from '../src/server_web.js';
import { generateTextPdf } from './_pdf_fixtures.js';

function createTempStore(): { store: CaptureStore; service: QuickCaptureService; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-test-workspace-'));
  const store = new CaptureStore(tmpDir);
  const service = new QuickCaptureService(store);
  return {
    store,
    service,
    cleanup: () => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

test('QuickCaptureService: captures text note and processes to READY status', async () => {
  const { service, cleanup } = createTempStore();
  try {
    const item = await service.captureTextOrLink({
      ownerId: 'usr_test_01',
      tenantId: 'ten_test_01',
      type: 'TEXT',
      content: 'Remember to finalize the NAgex hackathon submission documentation.',
      source: 'WEB',
    });

    assert.ok(item.captureId.startsWith('cap_'));
    assert.equal(item.status, 'READY');
    assert.equal(item.type, 'TEXT');
    assert.ok(item.metadata.extractedTitle);
    assert.ok(item.metadata.extractedSummary);
  } finally {
    cleanup();
  }
});

test('QuickCaptureService: captures action item text and detects NEEDS_REVIEW status with suggested TASK action', async () => {
  const { service, cleanup } = createTempStore();
  try {
    const item = await service.captureTextOrLink({
      ownerId: 'usr_test_02',
      tenantId: 'ten_test_01',
      type: 'TEXT',
      content: 'TODO: Review and sign Nebius Cloud deployment agreement before tomorrow.',
      source: 'DESKTOP',
    });

    assert.equal(item.status, 'NEEDS_REVIEW');
    assert.ok(item.metadata.suggestedAction);
    assert.equal(item.metadata.suggestedAction.type, 'TASK');
  } finally {
    cleanup();
  }
});

test('QuickCaptureService: captures FILE payload with UPLOADING -> PROCESSING -> READY lifecycle', async () => {
  const { service, cleanup } = createTempStore();
  try {
    // A genuine, structurally valid PDF (Phase 1 STEP 4, item R) so
    // pdf-extractor.ts's real pdfjs-dist parsing has real content to find —
    // a hand-built %PDF-/BT/Tj string is no longer accepted by a real
    // parser, since it lacks a valid xref/trailer.
    const realPdf = await generateTextPdf(['This document describes the target architecture for NAgex.']);
    const item = await service.uploadBinaryObject({
      ownerId: 'usr_test_03',
      tenantId: 'ten_test_01',
      type: 'FILE',
      filename: 'architecture.pdf',
      mimeType: 'application/pdf',
      data: realPdf,
      source: 'WEB',
    });

    assert.equal(item.status, 'READY');
    assert.equal(item.metadata.originalName, 'architecture.pdf');
    assert.ok(item.vaultPath?.includes('files'));
  } finally {
    cleanup();
  }
});

test('QuickCaptureService: getInboxSummary and getVaultSummary aggregate items truthfully', async () => {
  const { service, cleanup } = createTempStore();
  try {
    await service.captureTextOrLink({
      ownerId: 'usr_test_04',
      tenantId: 'ten_test_01',
      type: 'LINK',
      content: 'https://nebius.com/ai-cloud',
      source: 'WEB',
    });

    await service.uploadBinaryObject({
      ownerId: 'usr_test_04',
      tenantId: 'ten_test_01',
      type: 'AUDIO',
      filename: 'meeting_notes.webm',
      mimeType: 'audio/webm',
      data: Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
      source: 'MOBILE',
    });

    const inbox = service.getInboxSummary('usr_test_04');
    assert.equal(inbox.items.length, 2);

    const vault = await service.getVaultSummary('usr_test_04');
    assert.equal(vault.totalItems, 2);
    assert.ok(vault.totalSizeBytes > 0);
    assert.equal(vault.categories.length, 4);
  } finally {
    cleanup();
  }
});

test('REST API routes: /api/v1/workspace/capture, /inbox, /vault, and /capture/:id', async () => {
  const headers = { 'x-nagex-tenant': 'ten_production_01', 'x-principal-id': 'usr_rest_test' };

  // 1. POST /api/v1/workspace/capture
  const created = await handleAsyncApiRequest(
    'POST',
    '/api/v1/workspace/capture',
    { type: 'TEXT', content: 'Prepare presentation deck for hackathon demo.', source: 'WEB' },
    headers
  );
  assert.equal(created.status, 201);
  const captureId = (created.data as any).captureId;
  assert.ok(captureId);

  // 2. GET /api/v1/workspace/inbox
  const inbox = await handleAsyncApiRequest('GET', '/api/v1/workspace/inbox', null, headers);
  assert.equal(inbox.status, 200);
  assert.ok(Array.isArray((inbox.data as any).items));

  // 3. GET /api/v1/workspace/vault
  const vault = await handleAsyncApiRequest('GET', '/api/v1/workspace/vault', null, headers);
  assert.equal(vault.status, 200);
  assert.ok((vault.data as any).quotaSizeBytes > 0);

  // 4. PATCH /api/v1/workspace/capture/:id
  const updated = await handleAsyncApiRequest(
    'PATCH',
    `/api/v1/workspace/capture/${captureId}`,
    { status: 'ACTIONED' },
    headers
  );
  assert.equal(updated.status, 200);
  assert.equal((updated.data as any).status, 'ACTIONED');
});
