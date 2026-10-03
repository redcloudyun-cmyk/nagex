// R24.7B — Artifact Context Resolver.
//
// The one server-side place that turns an artifactId into the grounded text a
// Canvas Ask model call may see. It never trusts the client for any of it:
//
//   artifactId
//     -> ArtifactStore.get(artifactId, tenantId, ownerId)   (ownership gate)
//     -> artifact.type + artifact.sourceId
//     -> the canonical domain store (DocumentStore / CaptureStore)
//     -> grounded text, deterministic size limit, content hash
//
// It owns no state: no second artifact store, no Canvas store. Ownership is a
// tenant AND owner equality check inside the stores themselves, so a wrong
// owner, a wrong tenant and an unknown id are indistinguishable (NOT_FOUND).
import crypto from 'node:crypto';
import type { ArtifactStore } from './artifact.store.js';
import { getArtifactAskSupport, type ArtifactAskBasis, type ArtifactAskUnsupportedReason, type ArtifactType } from './artifact.types.js';
import type { DocumentStore } from '../creation/document.store.js';
import type { CaptureStore } from '../workspace/capture.store.js';

// Deterministic context limit, in UTF-16 code units of the grounded text.
export const ARTIFACT_ASK_CONTEXT_LIMIT_CHARS = 24_000;

export interface ArtifactAskContext {
  artifactId: string;
  artifactType: ArtifactType;
  sourceId: string;
  title: string;
  // The (possibly truncated) text the model is allowed to see.
  content: string;
  // DocumentRecord.revisionIndex for DOCUMENT; null where no revision concept exists.
  revision: number | null;
  // sha256 of the FULL canonical text (before truncation).
  contentHash: string;
  truncated: boolean;
  contentChars: number;
  contextChars: number;
  contextLimit: number;
  groundingBasis: ArtifactAskBasis;
  // Source references already persisted on the document (ids only, never paths).
  sourceRefs: Array<{ type: string; id: string }>;
  tags: string[];
}

export type ArtifactContextResult =
  | { status: 'OK'; context: ArtifactAskContext }
  // Not owned / unknown id / wrong tenant: deliberately one outcome.
  | { status: 'NOT_FOUND' }
  | { status: 'UNSUPPORTED'; artifactType: ArtifactType; reason: ArtifactAskUnsupportedReason }
  // The caller owns the artifact but its canonical content is not retrievable.
  | { status: 'CONTEXT_UNAVAILABLE'; artifactType: ArtifactType };

export function truncateContext(text: string, limit: number = ARTIFACT_ASK_CONTEXT_LIMIT_CHARS): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  let end = limit;
  // Never split a surrogate pair.
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  let cut = text.slice(0, end);
  // Prefer a paragraph/line boundary when one exists in the last 10% of the window.
  const boundary = cut.lastIndexOf('\n');
  if (boundary >= Math.floor(end * 0.9)) cut = cut.slice(0, boundary);
  return { text: cut, truncated: true };
}

export class ArtifactContextResolver {
  constructor(private readonly deps: { artifactStore: ArtifactStore; documentStore: DocumentStore; captureStore: Pick<CaptureStore, 'getCapture'> }) {}

  public resolve(artifactId: string, tenantId: string, ownerId: string): ArtifactContextResult {
    const record = this.deps.artifactStore.get(artifactId, tenantId, ownerId);
    if (!record) return { status: 'NOT_FOUND' };

    const support = getArtifactAskSupport(record.type);
    if (!support.supported) return { status: 'UNSUPPORTED', artifactType: record.type, reason: support.reason };

    let title = record.title;
    let full = '';
    let revision: number | null = null;
    let sourceRefs: Array<{ type: string; id: string }> = [];
    let tags: string[] = [];

    if (record.type === 'DOCUMENT') {
      const doc = this.deps.documentStore.get(record.sourceId, tenantId, ownerId);
      if (!doc || !doc.content.trim()) return { status: 'CONTEXT_UNAVAILABLE', artifactType: record.type };
      title = doc.title || title;
      full = doc.content;
      revision = doc.revisionIndex;
      sourceRefs = (doc.sourceRefs || []).map((ref) => ({ type: ref.type, id: ref.id }));
    } else {
      // ANALYSIS: the persisted extractedSummary only. The original file is
      // never read here and no raw object path leaves this method.
      const item = this.deps.captureStore.getCapture(record.sourceId, tenantId, ownerId);
      const summary = item?.metadata?.extractedSummary;
      if (!item || item.metadata?.errorCode || typeof summary !== 'string' || !summary.trim()) {
        return { status: 'CONTEXT_UNAVAILABLE', artifactType: record.type };
      }
      title = item.metadata.extractedTitle || title;
      full = summary;
      tags = Array.isArray(item.metadata.extractedTags) ? item.metadata.extractedTags.filter((t): t is string => typeof t === 'string').slice(0, 20) : [];
    }

    const { text, truncated } = truncateContext(full);
    return {
      status: 'OK',
      context: {
        artifactId: record.artifactId,
        artifactType: record.type,
        sourceId: record.sourceId,
        title,
        content: text,
        revision,
        contentHash: crypto.createHash('sha256').update(full).digest('hex'),
        truncated,
        contentChars: full.length,
        contextChars: text.length,
        contextLimit: ARTIFACT_ASK_CONTEXT_LIMIT_CHARS,
        groundingBasis: support.basis,
        sourceRefs,
        tags,
      },
    };
  }
}
