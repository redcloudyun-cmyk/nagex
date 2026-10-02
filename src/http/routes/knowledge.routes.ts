import crypto from 'node:crypto';
import { DEFAULT_GOOGLE_TENANT_ID } from '../../integrations/google/token.store.js';
import type { KnowledgeEngine, KnowledgeDocument } from '../../context/knowledge.engine.js';
import type { VaultStore } from '../../workspace/vault.store.js';
import type { ApiResult, SyncRouteRegistrar } from '../http-types.js';

function getHeaderValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export interface KnowledgeRouteDeps {
  knowledgeEngine: KnowledgeEngine;
  vaultStore: VaultStore;
}

// R24.5C — one document maps to one real frontend-facing shape. status/
// indexedAt/chunkCount are read straight off the real persisted document;
// nothing here is computed at request time or hardcoded.
function formatDocument(doc: KnowledgeDocument, sourceVaultItemId: string | undefined): Record<string, unknown> {
  return {
    id: doc.document_id,
    name: doc.title,
    classification: doc.classification,
    size_bytes: doc.content.length,
    status: doc.indexStatus || 'STORED',
    indexed_at: doc.indexedAt || null,
    chunk_count: typeof doc.chunkCount === 'number' ? doc.chunkCount : 0,
    created_at: doc.createdAt || null,
    content_hash: doc.contentHash || null,
    snippet: doc.content.slice(0, 200),
    source_vault_item_id: sourceVaultItemId || null,
  };
}

export const handleKnowledgeRoutes: SyncRouteRegistrar<KnowledgeRouteDeps> = (method, pathname, body, headers, query, deps): ApiResult | undefined => {
  const { knowledgeEngine, vaultStore } = deps;
  const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
  const userId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';

  // R24.5C — primary sourceRef (vault item id) resolution + invalidation.
  // A document whose backing Vault source was deleted is excluded from
  // list/search results (STALE_KNOWLEDGE_INDEX=0) rather than left visible
  // with a dangling reference.
  function resolveSourceVaultItemId(doc: KnowledgeDocument): string | undefined {
    const refs = doc.sourceRefs || [];
    return refs.find((ref) => typeof ref === 'string' && ref.startsWith('vlt_'));
  }
  function isLive(doc: KnowledgeDocument): boolean {
    const vaultItemId = resolveSourceVaultItemId(doc);
    if (!vaultItemId) return true; // no vault-backed source (e.g. legacy candidate-pipeline doc) — not subject to vault invalidation
    return Boolean(vaultStore.getItem(vaultItemId, doc.tenantId || tenantId, doc.ownerId || userId));
  }

  if (pathname === '/api/v1/knowledge' && method === 'GET') {
    const q = typeof query?.q === 'string' ? query.q : undefined;
    const documents = knowledgeEngine.searchDocuments(tenantId, userId, q).filter(isLive);
    const formatted = documents.map((doc) => formatDocument(doc, resolveSourceVaultItemId(doc)));
    return { status: 200, data: { documents: formatted, total: formatted.length, query: q || null } };
  }

  if (pathname === '/api/v1/knowledge' && method === 'POST') {
    const title = typeof body?.title === 'string' ? body.title.trim() : '';
    const content = typeof body?.content === 'string' ? body.content : '';
    const mimeType = typeof body?.mimeType === 'string' ? body.mimeType : 'text/plain';

    if (!title) {
      return { status: 400, data: { error: 'MISSING_TITLE', message: 'A title is required to add a knowledge document.' } };
    }
    if (!content || !content.trim()) {
      return { status: 400, data: { error: 'EMPTY_CONTENT', message: 'No extractable text content was provided.' } };
    }

    // Canonical durable source record — VaultStore remains the one source
    // store (DUPLICATE_KNOWLEDGE_SOURCE=0). storageRef/contentHash let a
    // future real-file-storage backend swap in without a schema change.
    const contentHash = crypto.createHash('sha256').update(content).digest('hex');
    const vaultItem = vaultStore.saveItem({
      tenantId,
      userId,
      type: 'DOCUMENT',
      title,
      mimeType,
      storageRef: `knowledge:${contentHash}`,
      source: 'KNOWLEDGE_UPLOAD',
      metadata: { contentHash, sizeBytes: content.length },
    });

    // Real text extraction: for the text/plain and text/markdown formats
    // this route accepts, the uploaded text IS the extracted content (same
    // "rawText = item.content" idiom src/workspace/capture-processor.ts
    // already uses for TEXT captures) — not a synthetic/demo substitute.
    const doc = knowledgeEngine.addDocument({
      source_id: vaultItem.vaultItemId,
      title,
      classification: 'INTERNAL',
      content,
      contentHash,
      sourceRefs: [vaultItem.vaultItemId],
      ownerId: userId,
      tenantId,
    });

    return { status: 201, data: formatDocument(doc, vaultItem.vaultItemId) };
  }

  if (pathname.startsWith('/api/v1/knowledge/') && method === 'GET') {
    const documentId = pathname.slice('/api/v1/knowledge/'.length);
    const doc = knowledgeEngine.getDocument(documentId, userId, tenantId);
    if (!doc || !isLive(doc)) {
      return { status: 404, data: { error: 'KNOWLEDGE_DOCUMENT_NOT_FOUND', message: `Knowledge document ${documentId} not found.` } };
    }
    const vaultItemId = resolveSourceVaultItemId(doc);
    const sourceItem = vaultItemId ? vaultStore.getItem(vaultItemId, tenantId, userId) : undefined;
    return {
      status: 200,
      data: {
        ...formatDocument(doc, vaultItemId),
        content: doc.content,
        source: sourceItem
          ? { vaultItemId: sourceItem.vaultItemId, title: sourceItem.title, mimeType: sourceItem.mimeType, createdAt: sourceItem.createdAt, type: sourceItem.type }
          : null,
      },
    };
  }

  return undefined;
};
