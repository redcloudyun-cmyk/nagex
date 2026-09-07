import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { InputRouter } from '../src/workspace/input-router.js';
import { LocalStorageProvider } from '../src/storage/local-storage.provider.js';
import { S3StorageProvider, readS3ConfigFromEnv } from '../src/storage/s3-storage.provider.js';
import { CaptureStore } from '../src/workspace/capture.store.js';
import { QuickCaptureService } from '../src/workspace/quick-capture.service.js';
import { handleAsyncApiRequest } from '../src/server_web.js';

test('InputRouter: classifies input intents correctly into a single primary path', () => {
  // 1. ASK
  const ask1 = InputRouter.classify({ text: 'What is the latest NVIDIA Nemotron model?' });
  assert.equal(ask1.primaryIntent, 'ASK');

  const ask2 = InputRouter.classify({ text: 'How do I optimize Nebius Token Factory?' });
  assert.equal(ask2.primaryIntent, 'ASK');

  // 2. COMMAND
  const cmd = InputRouter.classify({ text: 'Schedule a meeting tomorrow at 3 PM.' });
  assert.equal(cmd.primaryIntent, 'COMMAND');

  // 3. CAPTURE
  const cap = InputRouter.classify({ text: 'Remember this architecture idea for later.' });
  assert.equal(cap.primaryIntent, 'CAPTURE');

  // 4. LINK_CAPTURE
  const link = InputRouter.classify({ text: 'https://nebius.com/docs/storage' });
  assert.equal(link.primaryIntent, 'LINK_CAPTURE');
  assert.equal(link.normalizedPayload.url, 'https://nebius.com/docs/storage');

  // 5. UPLOAD
  const upload = InputRouter.classify({ text: 'document.pdf', hasFile: true, mimeType: 'application/pdf' });
  assert.equal(upload.primaryIntent, 'UPLOAD');

  // 6. AUDIO_CAPTURE
  const audio = InputRouter.classify({ text: 'recording.webm', hasAudio: true, mimeType: 'audio/webm' });
  assert.equal(audio.primaryIntent, 'AUDIO_CAPTURE');
});

test('LocalStorageProvider: handles putObject, getObject, headObject, and deleteObject with SHA-256 checksum', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-storage-test-'));
  const provider = new LocalStorageProvider(tmpDir);

  try {
    const key = 'test/document.txt';
    const content = Buffer.from('Hello NAgex Personal Cloud Vault!');
    const meta = await provider.putObject(key, content, 'text/plain');

    assert.equal(meta.objectKey, key);
    assert.equal(meta.sizeBytes, content.length);
    assert.ok(meta.checksum.length === 64); // SHA-256 hex string

    const fetched = await provider.getObject(key);
    assert.ok(fetched);
    assert.equal(fetched.data.toString(), 'Hello NAgex Personal Cloud Vault!');
    assert.equal(fetched.metadata.checksum, meta.checksum);

    const head = await provider.headObject(key);
    assert.ok(head);
    assert.equal(head.sizeBytes, content.length);

    const deleted = await provider.deleteObject(key);
    assert.equal(deleted, true);

    const afterDelete = await provider.getObject(key);
    assert.equal(afterDelete, null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('S3StorageProvider: handles S3 configuration and object lifecycle contract', async () => {
  const provider = new S3StorageProvider({
    endpoint: 'https://storage.nebius.cloud',
    region: 'eu-north1',
    bucket: 'nagex-vault-bucket',
    accessKeyId: 'test_access_key',
    secretAccessKey: 'test_secret_key',
  });

  assert.equal(provider.getProviderName(), 's3');

  const meta = await provider.putObject('vault/usr_01/files/report.pdf', Buffer.from('S3 PDF content'), 'application/pdf');
  assert.equal(meta.mimeType, 'application/pdf');

  const signedUrl = await provider.getSignedUrl('vault/usr_01/files/report.pdf');
  assert.ok(signedUrl.startsWith('https://storage.nebius.cloud/nagex-vault-bucket/'));

  const obj = await provider.getObject('vault/usr_01/files/report.pdf');
  assert.ok(obj);
  assert.equal(obj.data.toString(), 'S3 PDF content');
});

test('QuickCaptureService: rejects zero-byte audio payloads and requires real bytes', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-capture-test-'));
  const store = new CaptureStore(tmpDir);
  const storage = new LocalStorageProvider(path.join(tmpDir, 'storage'));
  const service = new QuickCaptureService(store, storage);

  try {
    // 1. Zero-byte audio payload throws ZERO_BYTE_PAYLOAD error
    await assert.rejects(
      async () => {
        await service.uploadBinaryObject({
          ownerId: 'usr_01',
          tenantId: 'ten_01',
          type: 'AUDIO',
          filename: 'empty.webm',
          mimeType: 'audio/webm',
          data: Buffer.alloc(0),
        });
      },
      /ZERO_BYTE_PAYLOAD/
    );

    // 2. Real audio bytes payload succeeds
    const realAudioData = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]); // WebM header bytes
    const item = await service.uploadBinaryObject({
      ownerId: 'usr_01',
      tenantId: 'ten_01',
      type: 'AUDIO',
      filename: 'real_recording.webm',
      mimeType: 'audio/webm',
      data: realAudioData,
    });

    assert.equal(item.type, 'AUDIO');
    assert.equal(item.status, 'READY');
    assert.equal(item.metadata.originalName, 'real_recording.webm');
    assert.ok(item.metadata.checksum);
    assert.equal(item.metadata.storageProvider, 'local');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('REST API: /api/v1/workspace/route-input and /api/v1/workspace/upload validation', async () => {
  const headers = { 'x-nagex-tenant': 'ten_production_01', 'x-principal-id': 'usr_truthfulness_test' };

  // 1. Route input ASK
  const routedAsk = await handleAsyncApiRequest(
    'POST',
    '/api/v1/workspace/route-input',
    { text: 'What is Nebius Token Factory?' },
    headers
  );
  assert.equal(routedAsk.status, 200);
  assert.equal((routedAsk.data as any).primaryIntent, 'ASK');

  // 2. Upload binary document via /api/v1/workspace/upload
  const fileContentBase64 = Buffer.from('Binary PDF content bytes for Personal Cloud Vault').toString('base64');
  const uploadRes = await handleAsyncApiRequest(
    'POST',
    '/api/v1/workspace/upload',
    {
      type: 'FILE',
      filename: 'nebius_guide.pdf',
      mimeType: 'application/pdf',
      base64: fileContentBase64,
      source: 'WEB',
    },
    headers
  );

  assert.equal(uploadRes.status, 201);
  const uploadData = uploadRes.data as any;
  assert.equal(uploadData.type, 'FILE');
  assert.equal(uploadData.status, 'READY');
  assert.ok(uploadData.metadata.checksum);
  assert.equal(uploadData.metadata.originalName, 'nebius_guide.pdf');

  // 3. Vault summary reports storage info truthfully
  const vaultRes = await handleAsyncApiRequest('GET', '/api/v1/workspace/vault', null, headers);
  assert.equal(vaultRes.status, 200);
  const vaultData = vaultRes.data as any;
  assert.ok(vaultData.storageInfo);
  assert.ok(vaultData.storageInfo.label);
});
