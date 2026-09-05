import { generateResourceId } from '../common/utils.js';
import { AgexError } from '../common/errors.js';

export type KnowledgeClassification = 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED';

export interface KnowledgeDocument {
  document_id: string;
  source_id: string;
  title: string;
  classification: KnowledgeClassification;
  content: string;
}

export interface KnowledgeCandidate {
  document_id: string;
  title: string;
  snippet: string;
  classification: KnowledgeClassification;
}

export class KnowledgeEngine {
  private documents: Map<string, KnowledgeDocument> = new Map();

  public addDocument(doc: Omit<KnowledgeDocument, 'document_id'>): KnowledgeDocument {
    const document_id = generateResourceId('knc');
    const document: KnowledgeDocument = {
      ...doc,
      document_id,
    };
    this.documents.set(document_id, document);
    return document;
  }

  public retrieveCandidates(
    query: string,
    allowedClassifications: KnowledgeClassification[]
  ): KnowledgeCandidate[] {
    const results: KnowledgeCandidate[] = [];

    for (const doc of this.documents.values()) {
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

// specs/schemas/context/grounded-response.schema.json
//
// TODO(spec-gap): no LEVEL 3 domain specification for the Knowledge Engine
// exists yet (docs/INDEX.md lists it under "미작성"). This function is the
// smallest checkable piece of MASTER.md principle #7 (Model Output은 권한이
// 아니다) and #14 (Schema Validation on all AI Actions) available today,
// ahead of real Model Gateway generation being wired up: an AI-generated
// answer may only cite document_ids that were actually returned as
// candidates for its query. A citation to anything else is a fabricated
// (hallucinated) reference and is rejected here, before it can reach a
// caller. This does not judge answer correctness or require a citation on
// every answer -- `grounded: false` is an informational signal, not a
// rejection.
export function verifyGroundedCitations(
  candidates: KnowledgeCandidate[],
  citedDocumentIds: string[]
): GroundedCitationCheck {
  const candidateIds = new Set(candidates.map(c => c.document_id));

  for (const citedId of citedDocumentIds) {
    if (!candidateIds.has(citedId)) {
      throw new AgexError({
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
