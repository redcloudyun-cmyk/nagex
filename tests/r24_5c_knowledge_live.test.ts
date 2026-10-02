// R24.5C — real Knowledge ingestion/search/invalidation certification.
// Exercises the actual route handler (handleKnowledgeRoutes) and real
// KnowledgeEngine/VaultStore instances over a real temp directory — no
// mocks, no synthetic demo fixture substituted for product behavior.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { KnowledgeEngine } from '../src/context/knowledge.engine.js';
import { VaultStore } from '../src/workspace/vault.store.js';
import { handleKnowledgeRoutes } from '../src/http/routes/knowledge.routes.js';

const CANARY = 'NAgexKnowledgeCanary7429';
const TENANT_A = 'ten_test_a';
const USER_A = 'usr_test_a';

function createTmpDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `nagex-knowledge-${label}-`));
}

function headersFor(tenant: string, user: string) {
  return { 'x-nagex-tenant': tenant, 'x-principal-id': user };
}

describe('R24.5C — Knowledge is a real, live, user-operable capability', () => {
  it('persists a real source, indexes real content, and returns it from a real search query', () => {
    const tmpDir = createTmpDir('core');
    try {
      const knowledgeEngine = new KnowledgeEngine(path.join(tmpDir, 'knowledge'));
      const vaultStore = new VaultStore(path.join(tmpDir, 'vault'));
      const deps = { knowledgeEngine, vaultStore };

      const postResult = handleKnowledgeRoutes(
        'POST',
        '/api/v1/knowledge',
        { title: 'Canary Doc', content: `This document contains ${CANARY} in its body.`, mimeType: 'text/plain' },
        headersFor(TENANT_A, USER_A),
        {},
        deps
      );
      assert.equal(postResult?.status, 201);
      const posted = postResult!.data as any;
      assert.equal(posted.status, 'INDEXED');
      assert.ok(posted.indexed_at, 'indexed_at must be a real persisted timestamp, not absent');
      assert.equal(posted.chunk_count, 1);
      assert.ok(posted.source_vault_item_id, 'must link back to a real Vault source record');

      // The source itself is a real, independently-readable VaultItem.
      const vaultItem = vaultStore.getItem(posted.source_vault_item_id, TENANT_A, USER_A);
      assert.ok(vaultItem, 'KnowledgeEngine POST must have created a real durable Vault source record');
      assert.equal(vaultItem!.title, 'Canary Doc');

      const searchResult = handleKnowledgeRoutes(
        'GET',
        '/api/v1/knowledge',
        null,
        headersFor(TENANT_A, USER_A),
        { q: CANARY },
        deps
      );
      assert.equal(searchResult?.status, 200);
      const searchData = searchResult!.data as any;
      assert.equal(searchData.documents.length, 1, 'exact known source must be the one real result');
      assert.equal(searchData.documents[0].id, posted.id);
      assert.equal(searchData.documents[0].status, 'INDEXED');

      // Source traceability: GET /:id returns the real content and real source.
      const detailResult = handleKnowledgeRoutes(
        'GET',
        `/api/v1/knowledge/${posted.id}`,
        null,
        headersFor(TENANT_A, USER_A),
        {},
        deps
      );
      assert.equal(detailResult?.status, 200);
      const detail = detailResult!.data as any;
      assert.ok(detail.content.includes(CANARY));
      assert.equal(detail.source.vaultItemId, posted.source_vault_item_id);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('empty query returns the full authorized list; a non-matching query returns NO_RESULT', () => {
    const tmpDir = createTmpDir('query');
    try {
      const knowledgeEngine = new KnowledgeEngine(path.join(tmpDir, 'knowledge'));
      const vaultStore = new VaultStore(path.join(tmpDir, 'vault'));
      const deps = { knowledgeEngine, vaultStore };

      handleKnowledgeRoutes('POST', '/api/v1/knowledge', { title: 'Doc A', content: `${CANARY} alpha` }, headersFor(TENANT_A, USER_A), {}, deps);

      const emptyQuery = handleKnowledgeRoutes('GET', '/api/v1/knowledge', null, headersFor(TENANT_A, USER_A), {}, deps);
      assert.equal((emptyQuery!.data as any).documents.length, 1, 'no q param must list the authorized document');

      const noResult = handleKnowledgeRoutes('GET', '/api/v1/knowledge', null, headersFor(TENANT_A, USER_A), { q: 'NoSuchTermXYZ' }, deps);
      assert.equal((noResult!.data as any).documents.length, 0, 'a non-matching query must return zero results, not fall back to the full list');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('tenant isolation: a document created under one tenant is invisible to another tenant', () => {
    const tmpDir = createTmpDir('tenant-iso');
    try {
      const knowledgeEngine = new KnowledgeEngine(path.join(tmpDir, 'knowledge'));
      const vaultStore = new VaultStore(path.join(tmpDir, 'vault'));
      const deps = { knowledgeEngine, vaultStore };

      handleKnowledgeRoutes('POST', '/api/v1/knowledge', { title: 'Tenant A Doc', content: CANARY }, headersFor(TENANT_A, USER_A), {}, deps);

      const otherTenantSearch = handleKnowledgeRoutes('GET', '/api/v1/knowledge', null, headersFor('ten_other', USER_A), { q: CANARY }, deps);
      assert.equal((otherTenantSearch!.data as any).documents.length, 0, 'CROSS_TENANT_LEAK=0');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('user isolation: a document created by one user is invisible to another user in the same tenant', () => {
    const tmpDir = createTmpDir('user-iso');
    try {
      const knowledgeEngine = new KnowledgeEngine(path.join(tmpDir, 'knowledge'));
      const vaultStore = new VaultStore(path.join(tmpDir, 'vault'));
      const deps = { knowledgeEngine, vaultStore };

      handleKnowledgeRoutes('POST', '/api/v1/knowledge', { title: 'User A Doc', content: CANARY }, headersFor(TENANT_A, USER_A), {}, deps);

      const otherUserSearch = handleKnowledgeRoutes('GET', '/api/v1/knowledge', null, headersFor(TENANT_A, 'usr_other'), { q: CANARY }, deps);
      assert.equal((otherUserSearch!.data as any).documents.length, 0, 'CROSS_SESSION_LEAK=0 / cross-user leak=0');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('restart persistence: a fresh engine/store instance over the same directory still finds the real document', () => {
    const tmpDir = createTmpDir('restart');
    try {
      const knowledgeDir = path.join(tmpDir, 'knowledge');
      const vaultDir = path.join(tmpDir, 'vault');

      const engine1 = new KnowledgeEngine(knowledgeDir);
      const vault1 = new VaultStore(vaultDir);
      const posted = handleKnowledgeRoutes('POST', '/api/v1/knowledge', { title: 'Restart Doc', content: CANARY }, headersFor(TENANT_A, USER_A), {}, { knowledgeEngine: engine1, vaultStore: vault1 });
      assert.equal(posted?.status, 201);

      // Simulate a server restart: brand-new instances, same real directories.
      const engine2 = new KnowledgeEngine(knowledgeDir);
      const vault2 = new VaultStore(vaultDir);
      const afterRestart = handleKnowledgeRoutes('GET', '/api/v1/knowledge', null, headersFor(TENANT_A, USER_A), { q: CANARY }, { knowledgeEngine: engine2, vaultStore: vault2 });
      assert.equal((afterRestart!.data as any).documents.length, 1, 'real file-backed persistence must survive a process restart');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('empty/whitespace-only content fails ingestion truthfully rather than faking a success', () => {
    const tmpDir = createTmpDir('failed-index');
    try {
      const knowledgeEngine = new KnowledgeEngine(path.join(tmpDir, 'knowledge'));
      const vaultStore = new VaultStore(path.join(tmpDir, 'vault'));
      const deps = { knowledgeEngine, vaultStore };

      const result = handleKnowledgeRoutes('POST', '/api/v1/knowledge', { title: 'Empty Doc', content: '   ' }, headersFor(TENANT_A, USER_A), {}, deps);
      assert.equal(result?.status, 400, 'FAKE_SUCCESS_PATHS=0 — empty extractable content must not be accepted as a 201');
      assert.equal((result!.data as any).error, 'EMPTY_CONTENT');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('a missing/invalid document id returns a real 404, not a fabricated result', () => {
    const tmpDir = createTmpDir('missing-doc');
    try {
      const knowledgeEngine = new KnowledgeEngine(path.join(tmpDir, 'knowledge'));
      const vaultStore = new VaultStore(path.join(tmpDir, 'vault'));
      const deps = { knowledgeEngine, vaultStore };

      const result = handleKnowledgeRoutes('GET', '/api/v1/knowledge/knc_does_not_exist', null, headersFor(TENANT_A, USER_A), {}, deps);
      assert.equal(result?.status, 404);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('STALE_KNOWLEDGE_INDEX=0 — deleting the backing Vault source makes the derived Knowledge entry unavailable', () => {
    const tmpDir = createTmpDir('invalidation');
    try {
      const knowledgeEngine = new KnowledgeEngine(path.join(tmpDir, 'knowledge'));
      const vaultStore = new VaultStore(path.join(tmpDir, 'vault'));
      const deps = { knowledgeEngine, vaultStore };

      const posted = handleKnowledgeRoutes('POST', '/api/v1/knowledge', { title: 'Invalidation Doc', content: CANARY }, headersFor(TENANT_A, USER_A), {}, deps);
      const vaultItemId = (posted!.data as any).source_vault_item_id as string;

      const beforeDelete = handleKnowledgeRoutes('GET', '/api/v1/knowledge', null, headersFor(TENANT_A, USER_A), { q: CANARY }, deps);
      assert.equal((beforeDelete!.data as any).documents.length, 1);

      const deleted = vaultStore.deleteItem(vaultItemId, TENANT_A, USER_A);
      assert.equal(deleted, true);

      const afterDelete = handleKnowledgeRoutes('GET', '/api/v1/knowledge', null, headersFor(TENANT_A, USER_A), { q: CANARY }, deps);
      assert.equal((afterDelete!.data as any).documents.length, 0, 'search must not return a document whose real source was deleted');

      const detailAfterDelete = handleKnowledgeRoutes('GET', `/api/v1/knowledge/${(posted!.data as any).id}`, null, headersFor(TENANT_A, USER_A), {}, deps);
      assert.equal(detailAfterDelete?.status, 404, 'direct detail lookup must also be invalidated, not just list/search');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('index metadata is real, not fabricated: status/indexedAt/chunkCount come from actual computation', () => {
    const tmpDir = createTmpDir('real-metadata');
    try {
      const knowledgeEngine = new KnowledgeEngine(path.join(tmpDir, 'knowledge'));
      const vaultStore = new VaultStore(path.join(tmpDir, 'vault'));
      const deps = { knowledgeEngine, vaultStore };

      const longContent = 'x'.repeat(1250); // 500-char chunks -> 3 real chunks
      const posted = handleKnowledgeRoutes('POST', '/api/v1/knowledge', { title: 'Chunked Doc', content: longContent }, headersFor(TENANT_A, USER_A), {}, deps);
      const data = posted!.data as any;
      assert.equal(data.chunk_count, 3, 'chunk_count must reflect a real split of the real content length, not a hardcoded 1');
      assert.ok(data.content_hash && data.content_hash.length === 64, 'content_hash must be a real sha256 hex digest');

      // Two separate GETs must return the SAME indexed_at — proves it is a
      // persisted value, not `new Date().toISOString()` at request time.
      const get1 = handleKnowledgeRoutes('GET', '/api/v1/knowledge', null, headersFor(TENANT_A, USER_A), {}, deps);
      const get2 = handleKnowledgeRoutes('GET', '/api/v1/knowledge', null, headersFor(TENANT_A, USER_A), {}, deps);
      const indexedAt1 = (get1!.data as any).documents[0].indexed_at;
      const indexedAt2 = (get2!.data as any).documents[0].indexed_at;
      assert.equal(indexedAt1, indexedAt2, 'indexed_at must be stable across requests, not recomputed per-request');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
