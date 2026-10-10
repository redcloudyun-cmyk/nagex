import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VaultStore } from '../src/workspace/vault.store.js';
import { handleVaultRoutes } from '../src/http/routes/vault.routes.js';
import { DocumentStore } from '../src/creation/document.store.js';
import { DocumentExecutor } from '../src/creation/executors/document-executor.js';
import { authAs } from './_s1_session_auth.js';

function tmp(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `nagex-phase2-${label}-`));
}

describe('NAgex product surfaces Phase 2 real state contracts', () => {
  it('Vault reports only real persisted sizes and exposes stored text through preview/download routes', async () => {
    const dir = tmp('vault');
    try {
      const vaultStore = new VaultStore(dir);
      const deps = { vaultStore };
      const headers = authAs('ten_phase2', 'usr_phase2');

      const created = await handleVaultRoutes(
        'POST',
        '/api/v1/workspace/vault',
        {
          title: 'Phase 2 source note',
          type: 'DOCUMENT',
          mimeType: 'text/plain',
          storageRef: 'phase2-note',
          contentText: 'Phase 2 deterministic Vault content.',
        },
        headers,
        {},
        deps
      );

      assert.equal(created?.status, 201);
      const item = created!.data as any;
      assert.equal(item.metadata.sizeBytes, Buffer.byteLength('Phase 2 deterministic Vault content.', 'utf8'));

      const list = await handleVaultRoutes('GET', '/api/v1/workspace/vault', null, headers, {}, deps);
      assert.equal(list?.status, 200);
      const listed = list!.data as any;
      assert.equal(listed.storageUsageAvailable, true);
      assert.equal(listed.usedSizeBytes, item.metadata.sizeBytes);
      assert.equal(listed.quotaSizeBytes, null);

      const preview = await handleVaultRoutes('GET', `/api/v1/workspace/vault/${item.vaultItemId}/preview`, null, headers, {}, deps);
      assert.equal(preview?.status, 200);
      assert.equal((preview!.data as any).contentText, 'Phase 2 deterministic Vault content.');
      assert.equal((preview!.data as any).disposition, 'inline');

      const download = await handleVaultRoutes('GET', `/api/v1/workspace/vault/${item.vaultItemId}/download`, null, headers, {}, deps);
      assert.equal(download?.status, 200);
      assert.equal((download!.data as any).contentText, 'Phase 2 deterministic Vault content.');
      assert.equal((download!.data as any).disposition, 'attachment');

      const otherUserPreview = await handleVaultRoutes(
        'GET',
        `/api/v1/workspace/vault/${item.vaultItemId}/preview`,
        null,
        authAs('ten_phase2', 'usr_other'),
        {},
        deps
      );
      assert.equal(otherUserPreview?.status, 404);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Vault marks storage usage unavailable instead of inventing bytes for legacy items without size metadata', async () => {
    const dir = tmp('vault-legacy');
    try {
      const vaultStore = new VaultStore(dir);
      const headers = authAs('ten_phase2_legacy', 'usr_phase2_legacy');
      vaultStore.saveItem({
        tenantId: 'ten_phase2_legacy',
        userId: 'usr_phase2_legacy',
        type: 'LINK',
        title: 'Legacy link',
        storageRef: 'legacy-link',
        metadata: {},
      });

      const list = await handleVaultRoutes('GET', '/api/v1/workspace/vault', null, headers, {}, { vaultStore });
      assert.equal(list?.status, 200);
      const data = list!.data as any;
      assert.equal(data.storageUsageAvailable, false);
      assert.equal(data.usedSizeBytes, null);
      assert.equal(data.quotaSizeBytes, null);
      assert.match(data.storageUsageLabel, /unavailable/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Canvas document revision lineage reloads from the root after multiple revisions', async () => {
    const dir = tmp('documents');
    try {
      let count = 0;
      const aiService: any = {
        documentSynthesis: async () => {
          count += 1;
          return {
            data: {
              title: `Phase 2 doc v${count}`,
              summary: `summary v${count}`,
              content: `# Phase 2 doc\n\nversion ${count}`,
            },
            provider: 'test',
            model: 'deterministic',
            latencyMs: 1,
          };
        },
      };
      const documentStore = new DocumentStore({ dir });
      const executor = new DocumentExecutor({ aiService, documentStore });

      const v1 = await executor.execute({
        creationKind: 'DOCUMENT',
        prompt: 'Create phase 2 document',
        tenantId: 'ten_canvas_phase2',
        ownerId: 'usr_canvas_phase2',
        requestId: 'phase2-doc-1',
      });
      assert.equal(v1.status, 'SUCCESS');

      const v2 = await executor.executeRevision({
        parentDocumentId: v1.creationId,
        instruction: 'Revise once',
        tenantId: 'ten_canvas_phase2',
        ownerId: 'usr_canvas_phase2',
        requestId: 'phase2-doc-2',
      });
      assert.equal(v2.status, 'SUCCESS');

      const v3 = await executor.executeRevision({
        parentDocumentId: v2.creationId,
        instruction: 'Revise twice',
        tenantId: 'ten_canvas_phase2',
        ownerId: 'usr_canvas_phase2',
        requestId: 'phase2-doc-3',
      });
      assert.equal(v3.status, 'SUCCESS');

      const reloadedV3 = documentStore.get(v3.creationId, 'ten_canvas_phase2', 'usr_canvas_phase2');
      assert.ok(reloadedV3);
      assert.equal(reloadedV3!.parentDocumentId, v1.creationId);

      const versions = documentStore.getRevisions(reloadedV3!.parentDocumentId || reloadedV3!.documentId, 'ten_canvas_phase2', 'usr_canvas_phase2');
      assert.deepEqual(versions.map((v) => v.revisionIndex), [1, 2, 3]);
      assert.deepEqual(versions.map((v) => v.documentId), [v1.creationId, v2.creationId, v3.creationId]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
