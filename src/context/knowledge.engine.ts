import crypto from 'node:crypto';
import { generateResourceId } from '../common/utils.js';
import { NagexError } from '../common/errors.js';
import { FileRecordStore, resolveNagexDataDir } from '../governance/file-record.store.js';

// R24.5C — real, deterministic chunk split (character-window, no overlap).
// Not a retrieval-quality chunker; it exists so chunkCount reflects an
// actual computation over the real content rather than a hardcoded literal.
const CHUNK_SIZE = 500;
export function computeChunks(content: string): string[] {
  const trimmed = content.trim();
  if (!trimmed) return [];
  const chunks: string[] = [];
  for (let i = 0; i < trimmed.length; i += CHUNK_SIZE) {
    chunks.push(trimmed.slice(i, i + CHUNK_SIZE));
  }
  return chunks;
}

export type KnowledgeClassification = 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED';

// R24.5C — real index lifecycle. STORED: source recorded, extraction not
// yet attempted/confirmed. PROCESSING: extraction in flight (transient,
// never persisted as a resting state in the current synchronous ingestion
// path). INDEXED: content was actually extracted and is searchable. FAILED:
// extraction produced no usable content. Replaces the prior route-layer
// fabrication (status: 'INDEXED' unconditionally).
export type KnowledgeIndexStatus = 'STORED' | 'PROCESSING' | 'INDEXED' | 'FAILED';

export interface KnowledgeDocument {
  document_id: string;
  source_id: string;
  title: string;
  classification: KnowledgeClassification;
  content: string;
  // Phase 1 STEP 7 — traceability back to the canonical Candidate/Capture a
  // document was created from (item F): never set for documents added
  // through any other path, and never fabricated when absent.
  candidateId?: string;
  contentHash?: string;
  sourceRefs?: string[];
  tenantId?: string;
  ownerId?: string;
  // R24.5C — real, persisted lifecycle/index metadata (see
  // KnowledgeIndexStatus above). indexedAt is set once, at the moment
  // indexing actually succeeds — never recomputed per-request. chunkCount
  // is the real length of the chunk split computed at indexing time.
  indexStatus?: KnowledgeIndexStatus;
  indexedAt?: string;
  chunkCount?: number;
  createdAt?: string;
}

export interface KnowledgeCandidate {
  document_id: string;
  title: string;
  snippet: string;
  classification: KnowledgeClassification;
}

export class KnowledgeEngine {
  private readonly store: FileRecordStore<KnowledgeDocument>;

  constructor(dataDir?: string) {
    const dir = dataDir ?? resolveNagexDataDir('knowledge', 'NAGEX_KNOWLEDGE_DIR');
    this.store = new FileRecordStore<KnowledgeDocument>(dir, (val: unknown): val is KnowledgeDocument => {
      const v = val as any;
      return typeof v === 'object' && v !== null && typeof v.document_id === 'string' && typeof v.source_id === 'string' && typeof v.content === 'string';
    });
  }

  public addDocument(doc: Omit<KnowledgeDocument, 'document_id'>): KnowledgeDocument {
    const document_id = generateResourceId('knc');
    const now = new Date().toISOString();
    const chunks = computeChunks(doc.content);
    const indexed = chunks.length > 0;
    const document: KnowledgeDocument = {
      ...doc,
      document_id,
      createdAt: doc.createdAt ?? now,
      contentHash: doc.contentHash ?? (doc.content ? crypto.createHash('sha256').update(doc.content).digest('hex') : undefined),
      indexStatus: indexed ? 'INDEXED' : 'FAILED',
      indexedAt: indexed ? now : undefined,
      chunkCount: chunks.length,
    };
    this.store.write(document_id, document);
    return document;
  }

  public getDocument(documentId: string, ownerId?: string, tenantId?: string): KnowledgeDocument | undefined {
    const doc = this.store.read(documentId);
    if (!doc) return undefined;
    if (ownerId && doc.ownerId !== ownerId) return undefined;
    if (tenantId && doc.tenantId !== tenantId) return undefined;
    return doc;
  }

  public listDocuments(ownerId?: string, tenantId?: string): KnowledgeDocument[] {
    return this.store.readAll().filter(d => (!ownerId || d.ownerId === ownerId) && (!tenantId || d.tenantId === tenantId));
  }

  // R24.5C — real, live search. tenantId/ownerId are mandatory (unlike
  // listDocuments above, kept for existing non-HTTP callers) so an empty
  // query never leaks a cross-tenant read path. Scope-then-filter, same
  // order as VaultStore.searchItems. SUBSTRING match over title+content,
  // case-insensitive — not semantic, not full-text-indexed.
  public searchDocuments(tenantId: string, ownerId: string, query?: string): KnowledgeDocument[] {
    const scoped = this.store.readAll()
      .filter(d => d.tenantId === tenantId && d.ownerId === ownerId)
      .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
    const q = (query || '').toLowerCase().trim();
    if (!q) return scoped;
    return scoped.filter(d => d.title.toLowerCase().includes(q) || d.content.toLowerCase().includes(q));
  }

  public deleteDocument(documentId: string, ownerId?: string, tenantId?: string): void {
    const doc = this.getDocument(documentId, ownerId, tenantId);
    if (doc) this.store.remove(documentId);
  }

  // Phase 1 STEP 9 — reconciliation lookup, mirrors TaskStore.findByCandidateId.
  public findByCandidateId(candidateId: string, ownerId?: string, tenantId?: string): KnowledgeDocument | undefined {
    for (const document of this.store.readAll()) {
      if (document.candidateId === candidateId && (!ownerId || document.ownerId === ownerId) && (!tenantId || document.tenantId === tenantId)) return document;
    }
    return undefined;
  }

  public retrieveCandidates(
    query: string,
    allowedClassifications: KnowledgeClassification[],
    ownerId?: string,
    tenantId?: string
  ): KnowledgeCandidate[] {
    const results: KnowledgeCandidate[] = [];

    for (const doc of this.store.readAll()) {
      if (ownerId && doc.ownerId !== ownerId) continue;
      if (tenantId && doc.tenantId !== tenantId) continue;

      // 1. ACL Filter BEFORE Candidate Generation (Rule 86 from S-05/S-03)
      if (!allowedClassifications.includes(doc.classification)) {
        continue;
      }

      // 2. Simple keyword matching
      if (doc.title.toLowerCase().includes(query.toLowerCase()) || doc.content.toLowerCase().includes(query.toLowerCase())) {
        results.push({
          document_id: doc.document_id,
          title: doc.title,
          snippet: doc.content.substring(0, 100),
          classification: doc.classification,
        });
      }
    }

    return results;
  }
}

export interface GroundedCitationCheck {
  grounded: boolean;
  candidates_considered: number;
  cited_document_ids: string[];
}

export function verifyGroundedCitations(
  candidates: KnowledgeCandidate[],
  citedDocumentIds: string[]
): GroundedCitationCheck {
  const candidateIds = new Set(candidates.map(c => c.document_id));

  for (const citedId of citedDocumentIds) {
    if (!candidateIds.has(citedId)) {
      throw new NagexError({
        code: 'UNGROUNDED_CITATION',
        category: 'VALIDATION',
        message: `Cited document_id ${citedId} was not among the retrieved candidates for this query.`,
        request_id: 'knc_req',
      });
    }
  }

  return {
    grounded: citedDocumentIds.length > 0,
    candidates_considered: candidates.length,
    cited_document_ids: citedDocumentIds,
  };
}
