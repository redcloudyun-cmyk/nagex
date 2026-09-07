import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { validateS3ConfigFromEnv, S3StorageProvider } from '../src/storage/s3-storage.provider.js';
import { CaptureStore } from '../src/workspace/capture.store.js';
import { QuickCaptureService } from '../src/workspace/quick-capture.service.js';

test('Real Nebius S3 Integration Test: validates complete live Nebius storage lifecycle', async () => {
  const providerEnv = process.env.NAGEX_STORAGE_PROVIDER || '';
  if (providerEnv.toLowerCase() !== 's3') {
    console.log(`REAL_NEBIUS_TEST=NOT_RUN`);
    console.log(`[Nebius S3 Test] Skipped because NAGEX_STORAGE_PROVIDER is not set to "s3" (current: "${providerEnv || 'unset'}").`);
    return;
  }

  const s3Validation = validateS3ConfigFromEnv();
  if (!s3Validation.config || s3Validation.missingFields.length > 0) {
    console.log(`REAL_NEBIUS_TEST=NOT_RUN`);
    console.log(`[Nebius S3 Test] Skipped because S3 env configuration is incomplete. Missing: [${s3Validation.missingFields.join(', ')}]`);
    return;
  }

  console.log(`[Nebius S3 Test] Real S3 credentials detected. Executing live Nebius smoke test against bucket "${s3Validation.config.bucket}"...`);

  // Ensure production fail-closed behavior during real integration test
  delete process.env.NAGEX_S3_ALLOW_MOCK_FALLBACK;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-nebius-integration-'));
  const store = new CaptureStore(tmpDir);
  const s3Provider = new S3StorageProvider(s3Validation.config);
  const service = new QuickCaptureService(store, s3Provider);

  const ownerId = 'usr_nebius_test';
  const tenantId = 'ten_nebius_prod';

  try {
    // ------------------------------------------------------------------------
    // TEST FIXTURE 1: Small Real PDF File
    // ------------------------------------------------------------------------
    const pdfBuffer = Buffer.from(
      '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj 3 0 obj<</Type/Page/MediaBox[0 0 612 792]>>endobj\nxref\n0 4\n0000000000 65535 f\n0000000009 00000 n\n0000000052 00000 n\n0000000101 00000 n\ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n150\n%%EOF'
    );
    const pdfChecksum = crypto.createHash('sha256').update(pdfBuffer).digest('hex');

    // A. Init upload
    const initPdf = await service.initUpload({
      ownerId,
      tenantId,
      filename: 'nebius_smoke_test.pdf',
      mimeType: 'application/pdf',
      sizeBytes: pdfBuffer.length,
      intent: 'FILE',
    });
    assert.ok(initPdf.uploadUrl, 'initUpload returned presigned PUT URL');

    // B. Upload bytes to presigned PUT URL
    const putPdfRes = await fetch(initPdf.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/pdf' },
      body: pdfBuffer,
    });
    assert.ok(putPdfRes.ok, `Presigned PUT for PDF succeeded (HTTP ${putPdfRes.status})`);

    // C. HEAD object remotely
    const headPdf = await s3Provider.headObject(initPdf.objectKey);
    assert.ok(headPdf, 'Remote HEAD for PDF returned metadata');
    assert.equal(headPdf.sizeBytes, pdfBuffer.length);

    // D. Complete upload with checksum validation
    const completedPdf = await service.completeUpload({
      captureId: initPdf.captureId,
      ownerId,
      tenantId,
      objectKey: initPdf.objectKey,
      mimeType: 'application/pdf',
      checksum: pdfChecksum,
      sizeBytes: pdfBuffer.length,
      originalFilename: 'nebius_smoke_test.pdf',
    });
    assert.equal(completedPdf.status, 'READY');

    // E. Obtain signed GET URL
    const getPdfUrl = await service.getDownloadUrl(completedPdf.captureId, ownerId);
    assert.ok(getPdfUrl, 'Obtained signed GET URL for PDF');

    // F. Download & checksum actual bytes
    const getPdfRes = await fetch(getPdfUrl);
    assert.ok(getPdfRes.ok, `GET download for PDF succeeded (HTTP ${getPdfRes.status})`);
    const downloadedPdfBuf = Buffer.from(await getPdfRes.arrayBuffer());
    const downloadedPdfChecksum = crypto.createHash('sha256').update(downloadedPdfBuf).digest('hex');
    assert.equal(downloadedPdfChecksum, pdfChecksum, 'Downloaded PDF checksum matches expected');

    // G. Persistence Test — restart store & service
    const storePersisted = new CaptureStore(tmpDir);
    const servicePersisted = new QuickCaptureService(storePersisted, s3Provider);
    const pdfRecord = storePersisted.getCapture(completedPdf.captureId);
    assert.ok(pdfRecord, 'PDF capture item metadata persisted across service restart');
    assert.equal(pdfRecord.metadata.checksum, pdfChecksum);

    // H. Delete capture & confirm remote removal
    const pdfDeleted = await servicePersisted.deleteCaptureItem(completedPdf.captureId, ownerId);
    assert.equal(pdfDeleted, true, 'deleteCaptureItem returned true');
    const headPdfAfterDelete = await s3Provider.headObject(initPdf.objectKey);
    assert.equal(headPdfAfterDelete, null, 'HEAD on remote deleted object confirmed 404/not found');

    // ------------------------------------------------------------------------
    // TEST FIXTURE 2: Small Real WebM Audio Fixture
    // ------------------------------------------------------------------------
    const webmBuffer = Buffer.from([
      0x1a, 0x45, 0xdf, 0xa3, 0x99, 0x42, 0x86, 0x8b, 0x42, 0x82, 0x88, 0x6d, 0x61, 0x74, 0x72, 0x6f, 0x73, 0x6b, 0x61,
      0x42, 0x87, 0x81, 0x04, 0x42, 0x85, 0x81, 0x02,
    ]);
    const webmChecksum = crypto.createHash('sha256').update(webmBuffer).digest('hex');

    // A. Init upload for audio
    const initAudio = await service.initUpload({
      ownerId,
      tenantId,
      filename: 'nebius_voice_memo.webm',
      mimeType: 'audio/webm',
      sizeBytes: webmBuffer.length,
      intent: 'AUDIO',
    });

    // B. Upload bytes to presigned PUT URL
    const putAudioRes = await fetch(initAudio.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'audio/webm' },
      body: webmBuffer,
    });
    assert.ok(putAudioRes.ok, `Presigned PUT for WebM audio succeeded (HTTP ${putAudioRes.status})`);

    // C. HEAD object remotely
    const headAudio = await s3Provider.headObject(initAudio.objectKey);
    assert.ok(headAudio, 'Remote HEAD for audio returned metadata');

    // D. Complete upload with checksum validation
    const completedAudio = await service.completeUpload({
      captureId: initAudio.captureId,
      ownerId,
      tenantId,
      objectKey: initAudio.objectKey,
      mimeType: 'audio/webm',
      checksum: webmChecksum,
      sizeBytes: webmBuffer.length,
      originalFilename: 'nebius_voice_memo.webm',
    });
    assert.equal(completedAudio.status, 'READY');

    // E. Obtain signed GET URL & download
    const getAudioUrl = await service.getDownloadUrl(completedAudio.captureId, ownerId);
    assert.ok(getAudioUrl);
    const getAudioRes = await fetch(getAudioUrl);
    assert.ok(getAudioRes.ok);
    const downloadedAudioBuf = Buffer.from(await getAudioRes.arrayBuffer());
    const downloadedAudioChecksum = crypto.createHash('sha256').update(downloadedAudioBuf).digest('hex');
    assert.equal(downloadedAudioChecksum, webmChecksum, 'Downloaded audio checksum matches expected');

    // F. Delete audio capture & confirm remote 404
    const audioDeleted = await service.deleteCaptureItem(completedAudio.captureId, ownerId);
    assert.equal(audioDeleted, true);
    const headAudioAfterDelete = await s3Provider.headObject(initAudio.objectKey);
    assert.equal(headAudioAfterDelete, null, 'HEAD on remote deleted audio object confirmed 404');

    console.log(`REAL_NEBIUS_TEST=PASSED`);
  } catch (err) {
    console.log(`REAL_NEBIUS_TEST=FAILED`);
    console.error('[Nebius S3 Test Error]', err);
    throw err;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
