// The versions of a document or a deck - built from the relationships NAgex already stores (a revision points at its family's first version) - and what the person can do with them: list them, compare two of
// them (computed by NAgex, see version-diff.ts) and bring an older one back. Bringing one back is a NEW version; no version is ever overwritten, deleted or re-labelled.
// Everything is the owner's alone: a wrong tenant, a wrong owner, a malformed and an unknown id are indistinguishable (null -> 404 at the route).
import type { DocumentStore } from './document.store.js';
import type { PresentationRecord, PresentationStore } from './presentation.store.js';
import type { DocumentRecord } from './creation-runtime.types.js';
import { diffDecks, diffText, type DeckDiff, type DocumentDiff } from './version-diff.js';

export type ArtifactKind = 'DOCUMENT' | 'PRESENTATION';

export interface VersionSummary {
  id: string;
  kind: ArtifactKind;
  /** 1 = the first version of the family */
  revisionIndex: number;
  title: string;
  summary: string;
  createdAt: string;
  artifactId?: string;
  /** the newest version of the family: what "now" is */
  current: boolean;
  /** when this version was made by bringing an older one back */
  restoredFromId?: string;
  /** a deck: the number of content slides; a document: the number of characters */
  size: number;
}

export interface VersionFamily {
  kind: ArtifactKind;
  /** the id of the family's first version */
  rootId: string;
  /** newest first */
  versions: VersionSummary[];
}

export interface DocumentComparison {
  kind: 'DOCUMENT';
  from: VersionSummary;
  to: VersionSummary;
  titleChanged: { from: string; to: string } | null;
  diff: DocumentDiff;
}

export interface DeckComparison {
  kind: 'PRESENTATION';
  from: VersionSummary;
  to: VersionSummary;
  diff: DeckDiff;
}

export type VersionError = 'NOT_FOUND' | 'VERSIONS_NOT_RELATED';

const docSummary = (d: DocumentRecord, current: boolean): VersionSummary => ({
  id: d.documentId, kind: 'DOCUMENT', revisionIndex: d.revisionIndex, title: d.title, summary: d.summary, createdAt: d.createdAt, ...(d.artifactId ? { artifactId: d.artifactId } : {}),
  current, ...(d.restoredFromDocumentId ? { restoredFromId: d.restoredFromDocumentId } : {}), size: d.content.length,
});

const deckSummary = (p: PresentationRecord, current: boolean): VersionSummary => ({
  id: p.presentationId, kind: 'PRESENTATION', revisionIndex: p.revisionIndex ?? 1, title: p.title, summary: p.summary, createdAt: p.createdAt, ...(p.artifactId ? { artifactId: p.artifactId } : {}),
  current, ...(p.restoredFromPresentationId ? { restoredFromId: p.restoredFromPresentationId } : {}), size: p.slides.length,
});

const byAge = <T extends { revisionIndex: number; createdAt: string }>(a: T, b: T) => a.revisionIndex - b.revisionIndex || Date.parse(a.createdAt) - Date.parse(b.createdAt);

export class ArtifactVersionService {
  constructor(private readonly deps: { documentStore: DocumentStore; presentationStore: PresentationStore }) {}

  private documentFamily(id: string, tenantId: string, ownerId: string): DocumentRecord[] | null {
    const record = this.deps.documentStore.get(id, tenantId, ownerId);
    if (!record) return null;
    const root = record.parentDocumentId || record.documentId;
    const family = this.deps.documentStore.getRevisions(root, tenantId, ownerId);
    return (family.length > 0 ? family : [record]).sort(byAge);
  }

  private deckFamily(id: string, tenantId: string, ownerId: string): PresentationRecord[] | null {
    const record = this.deps.presentationStore.get(id, tenantId, ownerId);
    if (!record) return null;
    const root = record.parentPresentationId || record.presentationId;
    const family = this.deps.presentationStore.list(tenantId, ownerId, 10_000).filter((p) => p.presentationId === root || p.parentPresentationId === root);
    return (family.length > 0 ? family : [record]).sort((a, b) => (a.revisionIndex ?? 1) - (b.revisionIndex ?? 1) || Date.parse(a.createdAt) - Date.parse(b.createdAt));
  }

  public listDocumentVersions(id: string, tenantId: string, ownerId: string): VersionFamily | null {
    const family = this.documentFamily(id, tenantId, ownerId);
    if (!family) return null;
    const newest = family[family.length - 1];
    return { kind: 'DOCUMENT', rootId: family[0].documentId, versions: family.map((d) => docSummary(d, d.documentId === newest.documentId)).reverse() };
  }

  public listPresentationVersions(id: string, tenantId: string, ownerId: string): VersionFamily | null {
    const family = this.deckFamily(id, tenantId, ownerId);
    if (!family) return null;
    const newest = family[family.length - 1];
    return { kind: 'PRESENTATION', rootId: family[0].presentationId, versions: family.map((p) => deckSummary(p, p.presentationId === newest.presentationId)).reverse() };
  }

  /** `toId` defaults to the newest version of the family. */
  public compareDocuments(fromId: string, toId: string | undefined, tenantId: string, ownerId: string): DocumentComparison | VersionError {
    const family = this.documentFamily(fromId, tenantId, ownerId);
    if (!family) return 'NOT_FOUND';
    const from = family.find((d) => d.documentId === fromId)!;
    const to = toId ? family.find((d) => d.documentId === toId) : family[family.length - 1];
    if (!to) return this.deps.documentStore.get(toId as string, tenantId, ownerId) ? 'VERSIONS_NOT_RELATED' : 'NOT_FOUND';
    const newest = family[family.length - 1].documentId;
    return {
      kind: 'DOCUMENT',
      from: docSummary(from, from.documentId === newest),
      to: docSummary(to, to.documentId === newest),
      titleChanged: from.title.trim() !== to.title.trim() ? { from: from.title, to: to.title } : null,
      diff: diffText(from.content, to.content),
    };
  }

  public comparePresentations(fromId: string, toId: string | undefined, tenantId: string, ownerId: string): DeckComparison | VersionError {
    const family = this.deckFamily(fromId, tenantId, ownerId);
    if (!family) return 'NOT_FOUND';
    const from = family.find((p) => p.presentationId === fromId)!;
    const to = toId ? family.find((p) => p.presentationId === toId) : family[family.length - 1];
    if (!to) return this.deps.presentationStore.get(toId as string, tenantId, ownerId) ? 'VERSIONS_NOT_RELATED' : 'NOT_FOUND';
    const newest = family[family.length - 1].presentationId;
    return { kind: 'PRESENTATION', from: deckSummary(from, from.presentationId === newest), to: deckSummary(to, to.presentationId === newest), diff: diffDecks({ title: from.title, slides: from.slides }, { title: to.title, slides: to.slides }) };
  }

  /** The newest family of this kind that has more than one version ("지난번 보고서"), or null. */
  public latestFamily(kind: ArtifactKind, tenantId: string, ownerId: string): VersionFamily | null {
    if (kind === 'DOCUMENT') {
      const seen = new Set<string>();
      for (const doc of this.deps.documentStore.list(tenantId, ownerId, 10_000)) {
        const root = doc.parentDocumentId || doc.documentId;
        if (seen.has(root)) continue;
        seen.add(root);
        const family = this.listDocumentVersions(doc.documentId, tenantId, ownerId);
        if (family && family.versions.length > 1) return family;
      }
      return null;
    }
    const seen = new Set<string>();
    for (const deck of this.deps.presentationStore.list(tenantId, ownerId, 10_000)) {
      const root = deck.parentPresentationId || deck.presentationId;
      if (seen.has(root)) continue;
      seen.add(root);
      const family = this.listPresentationVersions(deck.presentationId, tenantId, ownerId);
      if (family && family.versions.length > 1) return family;
    }
    return null;
  }
}
