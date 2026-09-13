// Capture Ownership Isolation Correction.
//
// CaptureItem has carried both tenantId and ownerId since its original
// introduction (confirmed via source history at Preflight), but
// CaptureStore.getCapture/updateStatus/deleteCapture/listCaptures never
// checked either (or, for listCaptures, checked owner only) — and
// QuickCaptureService.actionCapture had ZERO ownership check of any kind,
// reachable via two real production routes. These tests prove the fix:
// every id-specific Capture operation now requires an exact tenantId +
// ownerId match, routed through CaptureStore's new centralized
// requireOwned() gate — a mismatch is externally indistinguishable from a
// genuinely nonexistent captureId (no FORBIDDEN/TENANT_MISMATCH/
// OWNER_MISMATCH code), and never mutates the real record or touches
// storage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { CaptureStore } from '../src/workspace/capture.store.js';
import { QuickCaptureService } from '../src/workspace/quick-capture.service.js';
import { LocalStorageProvider } from '../src/storage/local-storage.provider.js';

function tmpDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `nagex-cap-iso-${label}-`));
}

function buildHarness(label: string) {
  const dir = tmpDir(label);
  const captureStore = new CaptureStore(path.join(dir, 'captures'));
  const storageProvider = new LocalStorageProvider(path.join(dir, 'storage'));
  const service = new QuickCaptureService(captureStore, storageProvider);
  return { dir, captureStore, storageProvider, service };
}

// Deterministic acceptance identities.
const TENANT_A = 'ten_capture_accept_a';
const TENANT_B = 'ten_capture_accept_b';
const OWNER_X = 'usr_capture_owner_x';
const OWNER_Y = 'usr_capture_owner_y';

// ── 1-8: same owner / different tenant ───────────────────────────────────

test('1. same owner, different tenant: get is blocked, identical to a nonexistent id', async () => {
  const { captureStore } = buildHarness('1');
  const item = captureStore.createCapture({ ownerId: OWNER_X, tenantId: TENANT_A, type: 'TEXT', content: 'secret' });
  assert.equal(captureStore.getCapture(item.captureId, TENANT_B, OWNER_X), null);
  assert.equal(captureStore.getCapture(item.captureId, TENANT_B, OWNER_X), captureStore.getCapture('cap_does_not_exist', TENANT_A, OWNER_X));
});

test('2. same owner, different tenant: list does not contain the other tenant\'s capture', async () => {
  const { captureStore } = buildHarness('2');
  captureStore.createCapture({ ownerId: OWNER_X, tenantId: TENANT_A, type: 'TEXT', content: 'secret' });
  const listB = captureStore.listCaptures(TENANT_B, OWNER_X);
  assert.equal(listB.length, 0);
});

test('3. same owner, different tenant: action/update is blocked and leaves status unchanged', async () => {
  const { captureStore, service } = buildHarness('3');
  const item = await service.captureTextOrLink({ ownerId: OWNER_X, tenantId: TENANT_A, type: 'TEXT', content: 'secret' });
  const blocked = await service.actionCapture(item.captureId, TENANT_B, OWNER_X, 'ARCHIVED');
  assert.equal(blocked, null);
  const rightful = captureStore.getCapture(item.captureId, TENANT_A, OWNER_X);
  assert.equal(rightful?.status, item.status, 'status must remain unchanged after a blocked cross-tenant action attempt');
});

test('4. same owner, different tenant: delete is blocked; record, metadata, and blob all survive', async () => {
  const { captureStore, storageProvider, service } = buildHarness('4');
  const item = await service.uploadBinaryObject({ ownerId: OWNER_X, tenantId: TENANT_A, type: 'FILE', filename: 'doc.txt', mimeType: 'text/plain', data: Buffer.from('secret bytes') });
  const objectKey = item.metadata.objectKey!;

  let deleteCalls = 0;
  const originalDelete = storageProvider.deleteObject.bind(storageProvider);
  storageProvider.deleteObject = async (key: string) => { deleteCalls++; return originalDelete(key); };

  const deleted = await service.deleteCaptureItem(item.captureId, TENANT_B, OWNER_X);
  assert.equal(deleted, false);
  assert.equal(deleteCalls, 0, 'a blocked cross-tenant delete must never call the storage provider');
  assert.ok(captureStore.getCapture(item.captureId, TENANT_A, OWNER_X), 'the real record must survive');
  assert.ok(await storageProvider.headObject(objectKey), 'the real blob must survive');
});

test('5. same owner, different tenant: download URL is refused, no signed URL issued', async () => {
  const { service } = buildHarness('5');
  const item = await service.uploadBinaryObject({ ownerId: OWNER_X, tenantId: TENANT_A, type: 'FILE', filename: 'doc.txt', mimeType: 'text/plain', data: Buffer.from('secret bytes') });
  const url = await service.getDownloadUrl(item.captureId, TENANT_B, OWNER_X);
  assert.equal(url, null);
});

test('6. same owner, different tenant: preview URL is refused', async () => {
  const { service } = buildHarness('6');
  const item = await service.uploadBinaryObject({ ownerId: OWNER_X, tenantId: TENANT_A, type: 'FILE', filename: 'doc.txt', mimeType: 'text/plain', data: Buffer.from('secret bytes') });
  const url = await service.getPreviewUrl(item.captureId, TENANT_B, OWNER_X);
  assert.equal(url, null);
});

test('7. same owner, different tenant: retry is blocked', async () => {
  const { service } = buildHarness('7');
  const item = await service.captureTextOrLink({ ownerId: OWNER_X, tenantId: TENANT_A, type: 'TEXT', content: 'secret' });
  const retried = await service.retryCapture(item.captureId, TENANT_B, OWNER_X);
  assert.equal(retried, null);
});

test('8. same owner, different tenant: inbox and vault summaries never contain the other tenant\'s capture', async () => {
  const { service } = buildHarness('8');
  await service.captureTextOrLink({ ownerId: OWNER_X, tenantId: TENANT_A, type: 'TEXT', content: 'tenant-a-secret-content' });
  const inboxB = service.getInboxSummary(TENANT_B, OWNER_X);
  assert.equal(inboxB.items.length, 0);
  const vaultB = await service.getVaultSummary(TENANT_B, OWNER_X);
  assert.equal(vaultB.totalItems, 0);
  assert.equal(vaultB.recentItems.length, 0);
});

// ── 9-16: same tenant / different owner — identical protections ─────────

test('9. same tenant, different owner: get is blocked', async () => {
  const { captureStore } = buildHarness('9');
  const item = captureStore.createCapture({ ownerId: OWNER_X, tenantId: TENANT_A, type: 'TEXT', content: 'secret' });
  assert.equal(captureStore.getCapture(item.captureId, TENANT_A, OWNER_Y), null);
});

test('10. same tenant, different owner: list does not leak', async () => {
  const { captureStore } = buildHarness('10');
  captureStore.createCapture({ ownerId: OWNER_X, tenantId: TENANT_A, type: 'TEXT', content: 'secret' });
  assert.equal(captureStore.listCaptures(TENANT_A, OWNER_Y).length, 0);
});

test('11. same tenant, different owner: action/update is blocked, status unchanged', async () => {
  const { captureStore, service } = buildHarness('11');
  const item = await service.captureTextOrLink({ ownerId: OWNER_X, tenantId: TENANT_A, type: 'TEXT', content: 'secret' });
  const blocked = await service.actionCapture(item.captureId, TENANT_A, OWNER_Y, 'ARCHIVED');
  assert.equal(blocked, null);
  const rightful = captureStore.getCapture(item.captureId, TENANT_A, OWNER_X);
  assert.equal(rightful?.status, item.status);
});

test('12. same tenant, different owner: delete is blocked; record and blob survive', async () => {
  const { captureStore, storageProvider, service } = buildHarness('12');
  const item = await service.uploadBinaryObject({ ownerId: OWNER_X, tenantId: TENANT_A, type: 'FILE', filename: 'doc.txt', mimeType: 'text/plain', data: Buffer.from('secret bytes') });
  const objectKey = item.metadata.objectKey!;

  let deleteCalls = 0;
  const originalDelete = storageProvider.deleteObject.bind(storageProvider);
  storageProvider.deleteObject = async (key: string) => { deleteCalls++; return originalDelete(key); };

  const deleted = await service.deleteCaptureItem(item.captureId, TENANT_A, OWNER_Y);
  assert.equal(deleted, false);
  assert.equal(deleteCalls, 0, 'a blocked cross-owner delete must never call the storage provider');
  assert.ok(captureStore.getCapture(item.captureId, TENANT_A, OWNER_X));
  assert.ok(await storageProvider.headObject(objectKey));
});

test('13. same tenant, different owner: download URL refused', async () => {
  const { service } = buildHarness('13');
  const item = await service.uploadBinaryObject({ ownerId: OWNER_X, tenantId: TENANT_A, type: 'FILE', filename: 'doc.txt', mimeType: 'text/plain', data: Buffer.from('secret bytes') });
  assert.equal(await service.getDownloadUrl(item.captureId, TENANT_A, OWNER_Y), null);
});

test('14. same tenant, different owner: preview URL refused', async () => {
  const { service } = buildHarness('14');
  const item = await service.uploadBinaryObject({ ownerId: OWNER_X, tenantId: TENANT_A, type: 'FILE', filename: 'doc.txt', mimeType: 'text/plain', data: Buffer.from('secret bytes') });
  assert.equal(await service.getPreviewUrl(item.captureId, TENANT_A, OWNER_Y), null);
});

test('15. same tenant, different owner: retry is blocked', async () => {
  const { service } = buildHarness('15');
  const item = await service.captureTextOrLink({ ownerId: OWNER_X, tenantId: TENANT_A, type: 'TEXT', content: 'secret' });
  assert.equal(await service.retryCapture(item.captureId, TENANT_A, OWNER_Y), null);
});

test('16. same tenant, different owner: inbox and vault summaries never leak', async () => {
  const { service } = buildHarness('16');
  await service.captureTextOrLink({ ownerId: OWNER_X, tenantId: TENANT_A, type: 'TEXT', content: 'owner-x-secret-content' });
  const inboxY = service.getInboxSummary(TENANT_A, OWNER_Y);
  assert.equal(inboxY.items.length, 0);
  const vaultY = await service.getVaultSummary(TENANT_A, OWNER_Y);
  assert.equal(vaultY.totalItems, 0);
});

// ── 17-18: identical nonexistence semantics, wrong tenant vs wrong owner ──

test('17. wrong-tenant and wrong-owner attempts are indistinguishable from a nonexistent id', async () => {
  const { captureStore } = buildHarness('17');
  const item = captureStore.createCapture({ ownerId: OWNER_X, tenantId: TENANT_A, type: 'TEXT', content: 'secret' });
  const wrongTenant = captureStore.getCapture(item.captureId, TENANT_B, OWNER_X);
  const wrongOwner = captureStore.getCapture(item.captureId, TENANT_A, OWNER_Y);
  const nonexistent = captureStore.getCapture('cap_does_not_exist', TENANT_A, OWNER_X);
  assert.equal(wrongTenant, wrongOwner);
  assert.equal(wrongTenant, nonexistent);
});

test('18. nonexistent id: every operation returns the same not-found result as a blocked real id, never throws', async () => {
  const { service } = buildHarness('18');
  const fakeId = 'cap_does_not_exist';
  assert.equal(await service.getCaptureItem(fakeId, TENANT_A, OWNER_X), null);
  assert.equal(await service.actionCapture(fakeId, TENANT_A, OWNER_X, 'ARCHIVED'), null);
  assert.equal(await service.deleteCaptureItem(fakeId, TENANT_A, OWNER_X), false);
  assert.equal(await service.getDownloadUrl(fakeId, TENANT_A, OWNER_X), null);
  assert.equal(await service.getPreviewUrl(fakeId, TENANT_A, OWNER_X), null);
  assert.equal(await service.retryCapture(fakeId, TENANT_A, OWNER_X), null);
});

// ── 19: actionCandidate — the previously fully-audit-only tenant param ──

test('19. actionCandidate uses tenantId in the real ownership lookup, not just audit logging', async () => {
  const { service } = buildHarness('19');
  const item = await service.captureTextOrLink({ ownerId: OWNER_X, tenantId: TENANT_A, type: 'TEXT', content: 'secret' });
  const blocked = await service.actionCandidate({ captureId: item.captureId, candidateId: 'cand_x', action: 'ACCEPT', ownerId: OWNER_X, tenantId: TENANT_B });
  assert.equal(blocked, null, 'a cross-tenant actionCandidate attempt must be blocked even though ownerId matches');
});

// ── 20-22: rightful owner full lifecycle — must remain unbroken ─────────

test('20. rightful owner: create, read, list, action, delete all succeed', async () => {
  const { captureStore, service } = buildHarness('20');
  const item = await service.captureTextOrLink({ ownerId: OWNER_X, tenantId: TENANT_A, type: 'TEXT', content: 'rightful content' });

  const read = await service.getCaptureItem(item.captureId, TENANT_A, OWNER_X);
  assert.ok(read);

  const listed = captureStore.listCaptures(TENANT_A, OWNER_X);
  assert.ok(listed.some((i) => i.captureId === item.captureId));

  const actioned = await service.actionCapture(item.captureId, TENANT_A, OWNER_X, 'ARCHIVED');
  assert.equal(actioned?.status, 'ARCHIVED');

  const deleted = await service.deleteCaptureItem(item.captureId, TENANT_A, OWNER_X);
  assert.equal(deleted, true);
  assert.equal(captureStore.getCapture(item.captureId, TENANT_A, OWNER_X), null);
});

test('21. rightful owner: download/preview/retry all succeed for an uploaded object', async () => {
  const { service, storageProvider } = buildHarness('21');
  // Real WebM header magic bytes (\x1a\x45\xdf\xa3) — the same known-good
  // AUDIO fixture already proven safe through the real processing pipeline
  // by tests/cloud_vault_smoke.test.ts; a plain-text buffer under type
  // 'FILE' routes to real PDF parsing and correctly throws INVALID_PDF,
  // which would test the processor, not the ownership fix under test here.
  const audioBytes = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x99, 0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22]);
  const item = await service.uploadBinaryObject({ ownerId: OWNER_X, tenantId: TENANT_A, type: 'AUDIO', filename: 'memo.webm', mimeType: 'audio/webm', data: audioBytes });

  const downloadUrl = await service.getDownloadUrl(item.captureId, TENANT_A, OWNER_X);
  assert.ok(downloadUrl);
  const previewUrl = await service.getPreviewUrl(item.captureId, TENANT_A, OWNER_X);
  assert.ok(previewUrl);

  const retried = await service.retryCapture(item.captureId, TENANT_A, OWNER_X);
  assert.ok(retried);

  const deleted = await service.deleteCaptureItem(item.captureId, TENANT_A, OWNER_X);
  assert.equal(deleted, true);
  assert.equal(await storageProvider.headObject(item.metadata.objectKey!), null, 'rightful delete must actually remove the blob');
});

test('22. rightful owner: vault and inbox summaries correctly include the owner\'s own capture', async () => {
  const { service } = buildHarness('22');
  await service.captureTextOrLink({ ownerId: OWNER_X, tenantId: TENANT_A, type: 'TEXT', content: 'rightful visible content' });
  const inbox = service.getInboxSummary(TENANT_A, OWNER_X);
  assert.equal(inbox.items.length, 1);
  const vault = await service.getVaultSummary(TENANT_A, OWNER_X);
  assert.equal(vault.totalItems, 1);
  assert.equal(vault.recentItems.length, 1);
});

// ── 23: restart durability ────────────────────────────────────────────────

test('23. tenantId, ownerId, and isolation all survive a fresh CaptureStore instance over the same directory', async () => {
  const dir = tmpDir('23');
  const captureDir = path.join(dir, 'captures');
  const store1 = new CaptureStore(captureDir);
  const item = store1.createCapture({ ownerId: OWNER_X, tenantId: TENANT_A, type: 'TEXT', content: 'restart content' });

  const store2 = new CaptureStore(captureDir);
  const rightful = store2.getCapture(item.captureId, TENANT_A, OWNER_X);
  assert.ok(rightful, 'rightful owner must still retrieve the record after restart');
  assert.equal(rightful!.tenantId, TENANT_A);
  assert.equal(rightful!.ownerId, OWNER_X);
  assert.equal(store2.getCapture(item.captureId, TENANT_B, OWNER_X), null, 'cross-tenant isolation must survive restart');
  assert.equal(store2.getCapture(item.captureId, TENANT_A, OWNER_Y), null, 'cross-owner isolation must survive restart');
});
