// R26-D — Artifact Version Workspace: "지난번 보고서 수정 전 버전과 지금 버전을 비교해줘."
// What is pinned here: the differences between two versions are computed by NAgex (line diff for a document, slide-by-slide diff for a deck - no model); every version of a document or deck stays
// retrievable and unchanged; bringing an older version back creates a NEW version (the older one and the newest one are never overwritten) and refuses to add a second identical version; everything is
// the owner's alone (another person, another tenant, a malformed id and an unknown id are all the same "not found"); the audit trail carries ids and titles, not text. Real stores and routes, no model.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { diffDecks, diffText } from '../src/creation/version-diff.js';
import { ArtifactVersionService } from '../src/creation/artifact-version.service.js';
import { DocumentStore } from '../src/creation/document.store.js';
import { PresentationStore, type PresentationRecord } from '../src/creation/presentation.store.js';
import { DocumentExecutor } from '../src/creation/executors/document-executor.js';
import { PresentationExecutor } from '../src/creation/executors/presentation-executor.js';
import { CreationProviderRouter } from '../src/creation/providers/creation-provider-router.js';
import { CreationRuntime } from '../src/creation/creation-runtime.js';
import { ArtifactStore } from '../src/artifacts/artifact.store.js';
import { AuditLogger } from '../src/governance/audit.logger.js';
import { buildPptx } from '../src/creation/pptx/pptx-writer.js';
import type { AiService } from '../src/model-gateway/ai-service.js';
import type { DocumentRecord } from '../src/creation/creation-runtime.types.js';
import type { PresentationOutlineSlide } from '../src/model-gateway/presentation-outline.js';
import { handleDocumentCreationRoutes } from '../src/http/routes/document-creation.routes.js';
import { handlePresentationCreationRoutes } from '../src/http/routes/presentation-creation.routes.js';
import { decideRouting } from '../src/workspace/input-router.js';
import { authAs } from './_s1_session_auth.js';

const T = 'ten_ver';
const U = 'usr_ver';

describe('the difference between two texts (pure)', () => {
  it('a paragraph added in the middle is ONE addition - not "everything after it changed"', () => {
    const before = ['# 보고서', '', '1. 시장', '시장은 커진다.', '', '2. 위험', '규제가 변수다.'].join('\n');
    const after = ['# 보고서', '', '1. 시장', '시장은 커진다.', '', '1-2. 경쟁', '경쟁이 심해진다.', '', '2. 위험', '규제가 변수다.'].join('\n');
    const d = diffText(before, after);
    assert.deepEqual(d.stats, { added: 3, removed: 0, unchanged: 7 });
    assert.equal(d.identical, false);
    assert.deepEqual(d.lines.filter((l) => l.kind === 'added').map((l) => (l as { text: string }).text), ['1-2. 경쟁', '경쟁이 심해진다.', '']);
  });

  it('a changed line is one removal and one addition; trailing spaces and Windows line endings are not changes', () => {
    const d = diffText('가\r\n나  \r\n다', '가\n나\n라');
    assert.deepEqual(d.stats, { added: 1, removed: 1, unchanged: 2 });
    assert.deepEqual(d.lines.filter((l) => l.kind !== 'same').map((l) => [l.kind, (l as { text: string }).text]), [['removed', '다'], ['added', '라']]);
    assert.equal(diffText('가\r\n나  ', '가\n나').identical, true);
  });

  it('a long unchanged stretch is folded, with a little context kept around each change', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `줄 ${i + 1}`);
    const after = [...lines];
    after[20] = '바뀐 줄';
    const d = diffText(lines.join('\n'), after.join('\n'));
    const folds = d.lines.filter((l) => l.kind === 'fold') as Array<{ kind: 'fold'; hidden: number }>;
    assert.equal(folds.length, 2);
    assert.equal(folds.reduce((n, f) => n + f.hidden, 0) + d.lines.filter((l) => l.kind === 'same').length, 39, 'every unchanged line is either shown (context) or counted in a fold');
    assert.equal(d.lines.filter((l) => l.kind === 'same').length, 4, 'two lines of context on each side');
  });

  it('removed text is shown as removed, identical text reports identical, and text too large to compare says so instead of being cut', () => {
    assert.deepEqual(diffText('a\nb', 'a').stats, { added: 0, removed: 1, unchanged: 1 });
    assert.equal(diffText('같다', '같다').identical, true);
    const huge = Array.from({ length: 2500 }, (_, i) => `줄 ${i}`).join('\n');
    const other = Array.from({ length: 2500 }, (_, i) => `다른 ${i}`).join('\n');
    const d = diffText(huge, other);
    assert.equal(d.tooLarge, true);
    assert.deepEqual(d.lines, []);
    assert.equal(d.stats.added, 2500);
  });
});

describe('the difference between two decks (pure)', () => {
  const slide = (title: string, ...bullets: string[]): PresentationOutlineSlide => ({ title, bullets });
  it('a slide inserted in the middle is one added slide; the others stay unchanged', () => {
    const d = diffDecks({ title: '계획', slides: [slide('목표', '출시'), slide('위험', '규제')] }, { title: '계획', slides: [slide('목표', '출시'), slide('핵심 결론', '데이터'), slide('위험', '규제')] });
    assert.deepEqual(d.slides.map((s) => s.change), ['unchanged', 'added', 'unchanged']);
    assert.deepEqual(d.stats, { added: 1, removed: 0, changed: 0, unchanged: 2 });
    assert.equal(d.identical, false);
    assert.equal(d.slides[1].toIndex, 2);
  });

  it('a changed bullet marks the slide as changed and shows what left and what came in; a removed slide is removed', () => {
    const d = diffDecks({ title: 'A', slides: [slide('목표', '출시', '비용 절감'), slide('다음 단계', '채용')] }, { title: 'A', slides: [slide('목표', '출시', '비용 20% 절감')] });
    assert.deepEqual(d.slides.map((s) => s.change), ['changed', 'removed']);
    assert.deepEqual(d.slides[0].bullets.map((b) => [b.kind, b.text]), [['same', '출시'], ['removed', '비용 절감'], ['added', '비용 20% 절감']]);
    assert.deepEqual(d.stats, { added: 0, removed: 1, changed: 1, unchanged: 0 });
  });

  it('the same deck is identical, and a new title is reported', () => {
    const slides = [slide('목표', '출시')];
    assert.equal(diffDecks({ title: 'A', slides }, { title: 'A', slides }).identical, true);
    const d = diffDecks({ title: 'A', slides }, { title: 'B', slides });
    assert.deepEqual([d.identical, d.titleChanged], [false, { from: 'A', to: 'B' }]);
  });
});

// ---- the stores and the service, real ----

const docId = (n: number) => `doc_${n.toString(16).padStart(24, '0')}`;
const deckId = (n: number) => `pres_${n.toString(16).padStart(24, '0')}`;

function rig() {
  const dir = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), `nagex_ver_${p}_`));
  const documentStore = new DocumentStore({ dir: dir('docs') });
  const presentationStore = new PresentationStore({ metaDir: dir('meta'), bytesDir: dir('bytes') });
  const artifactStore = new ArtifactStore({ dir: dir('art') });
  const auditLogger = new AuditLogger();
  const documentExecutor = new DocumentExecutor({ aiService: {} as AiService, documentStore, artifactStore, auditLogger });
  const presentationExecutor = new PresentationExecutor({ aiService: {} as AiService, presentationStore, providerRouter: new CreationProviderRouter(), artifactStore, documentStore, auditLogger });
  const versionService = new ArtifactVersionService({ documentStore, presentationStore });
  const creationRuntime = new CreationRuntime([documentExecutor, presentationExecutor]);
  let clock = Date.parse('2026-10-01T09:00:00Z');
  const tick = () => new Date((clock += 60_000)).toISOString();

  const seedDocument = (n: number, content: string, extra: Partial<DocumentRecord> = {}, owner = U, tenant = T): DocumentRecord => {
    const at = tick();
    const record: DocumentRecord = {
      documentId: docId(n), tenantId: tenant, ownerId: owner, title: '분기 보고서', summary: `요약 ${n}`, content, documentKind: 'REPORT', locale: 'ko', format: 'MARKDOWN',
      sourceRefs: [], revisionIndex: 1, createdAt: at, updatedAt: at, ...extra,
    };
    const artifact = artifactStore.saveCompleted({ tenantId: tenant, ownerId: owner, type: 'DOCUMENT', title: record.title, preview: record.summary, sourceType: 'CAPTURE', sourceId: record.documentId, openTarget: `/api/v1/creations/documents/${record.documentId}` });
    return documentStore.save({ ...record, artifactId: artifact.artifactId });
  };

  const seedDeck = (n: number, title: string, slides: PresentationOutlineSlide[], extra: Partial<PresentationRecord> = {}, owner = U, tenant = T): PresentationRecord => {
    const at = tick();
    const bytes = buildPptx({ title, subtitle: '', locale: 'ko', slides }, new Date(at));
    const presentationId = deckId(n);
    const record: PresentationRecord = {
      presentationId, tenantId: tenant, ownerId: owner, title, subtitle: '', summary: `${title} (${slides.length})`, locale: 'ko', slides, mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      byteLength: bytes.length, binaryStoragePath: presentationStore.saveBinary(presentationId, bytes), sourceRefs: [], providerExecutionMetadata: { providerId: 'local-pptx', createdAt: at }, revisionIndex: 1, createdAt: at, updatedAt: at, ...extra,
    };
    return presentationStore.save(record);
  };
  return { documentStore, presentationStore, artifactStore, auditLogger, documentExecutor, presentationExecutor, versionService, creationRuntime, seedDocument, seedDeck };
}

/** v1 (first), v2 (a paragraph added), v3 (a line changed): the report from the incident, revised twice. */
function threeDocumentVersions(r: ReturnType<typeof rig>) {
  const v1 = r.seedDocument(1, '# 분기 보고서\n\n## 시장\n시장은 커진다.\n\n## 위험\n규제가 변수다.');
  const v2 = r.seedDocument(2, '# 분기 보고서\n\n## 시장\n시장은 커진다.\n\n## 경쟁\n경쟁이 심해진다.\n\n## 위험\n규제가 변수다.', { parentDocumentId: v1.documentId, revisionIndex: 2 });
  const v3 = r.seedDocument(3, '# 분기 보고서\n\n## 시장\n시장은 크게 커진다.\n\n## 경쟁\n경쟁이 심해진다.\n\n## 위험\n규제가 변수다.', { parentDocumentId: v1.documentId, revisionIndex: 3 });
  return { v1, v2, v3 };
}

describe('the versions of a document', () => {
  it('lists every version newest first, marks the newest as current, from any member of the family', () => {
    const r = rig();
    const { v1, v2, v3 } = threeDocumentVersions(r);
    for (const from of [v1, v2, v3]) {
      const family = r.versionService.listDocumentVersions(from.documentId, T, U)!;
      assert.equal(family.rootId, v1.documentId);
      assert.deepEqual(family.versions.map((v) => v.id), [v3.documentId, v2.documentId, v1.documentId]);
      assert.deepEqual(family.versions.map((v) => v.current), [true, false, false]);
      assert.deepEqual(family.versions.map((v) => v.revisionIndex), [3, 2, 1]);
      assert.ok(family.versions.every((v) => v.artifactId), 'each version keeps its artifact reference');
    }
  });

  it('compares an older version with the newest by default, and any two versions of the family when asked', () => {
    const r = rig();
    const { v1, v2, v3 } = threeDocumentVersions(r);
    const toNewest = r.versionService.compareDocuments(v1.documentId, undefined, T, U);
    assert.ok(typeof toNewest === 'object');
    if (typeof toNewest !== 'object' || toNewest.kind !== 'DOCUMENT') throw new Error('unreachable');
    assert.equal(toNewest.from.id, v1.documentId);
    assert.equal(toNewest.to.id, v3.documentId);
    assert.equal(toNewest.to.current, true);
    assert.deepEqual(toNewest.diff.stats, { added: 4, removed: 1, unchanged: 6 });

    const middle = r.versionService.compareDocuments(v1.documentId, v2.documentId, T, U);
    assert.ok(typeof middle === 'object' && middle.kind === 'DOCUMENT');
    if (typeof middle === 'object' && middle.kind === 'DOCUMENT') assert.deepEqual(middle.diff.stats, { added: 3, removed: 0, unchanged: 7 });
  });

  it('comparing with something that is not a version of the same document is refused; foreign and unknown ids are "not found"', () => {
    const r = rig();
    const { v1 } = threeDocumentVersions(r);
    const other = r.seedDocument(9, '# 다른 문서');
    assert.equal(r.versionService.compareDocuments(v1.documentId, other.documentId, T, U), 'VERSIONS_NOT_RELATED');
    assert.equal(r.versionService.compareDocuments(v1.documentId, docId(404), T, U), 'NOT_FOUND');
    assert.equal(r.versionService.compareDocuments(docId(404), undefined, T, U), 'NOT_FOUND');
    // the other person's version of anything is not reachable, even by a real id
    assert.equal(r.versionService.compareDocuments(v1.documentId, undefined, T, 'usr_other'), 'NOT_FOUND');
    assert.equal(r.versionService.compareDocuments(v1.documentId, undefined, 'ten_other', U), 'NOT_FOUND');
    assert.equal(r.versionService.listDocumentVersions(v1.documentId, T, 'usr_other'), null);
    assert.equal(r.versionService.listDocumentVersions(v1.documentId, 'ten_other', U), null);
  });

  it('a version that belongs to someone else cannot be smuggled into the comparison', () => {
    const r = rig();
    const { v1 } = threeDocumentVersions(r);
    const theirs = r.seedDocument(20, '# 남의 문서', { parentDocumentId: v1.documentId, revisionIndex: 4 }, 'usr_other');
    assert.equal(r.versionService.compareDocuments(v1.documentId, theirs.documentId, T, U), 'NOT_FOUND');
    assert.deepEqual(r.versionService.listDocumentVersions(v1.documentId, T, U)!.versions.map((v) => v.id).includes(theirs.documentId), false);
  });

  it('the newest report that has an earlier version is what "지난번 보고서" means; a single-version document is not', () => {
    const r = rig();
    assert.equal(r.versionService.latestFamily('DOCUMENT', T, U), null);
    r.seedDocument(1, '# 하나뿐');
    assert.equal(r.versionService.latestFamily('DOCUMENT', T, U), null, 'one version: nothing to compare');
    const { v1 } = threeDocumentVersions(r);
    const latest = r.versionService.latestFamily('DOCUMENT', T, U)!;
    assert.equal(latest.rootId, docId(1), 'the family of the root');
    assert.equal(latest.versions.length >= 1, true);
    assert.equal(r.versionService.latestFamily('DOCUMENT', T, 'usr_other'), null);
    void v1;
  });
});

describe('bringing an older document version back', () => {
  const restore = (r: ReturnType<typeof rig>, id: string, who = U, tenant = T) => r.documentExecutor.restoreVersion({ sourceDocumentId: id, tenantId: tenant, ownerId: who, requestId: 'req_restore' });

  it('creates a NEW version with the older text; every existing version is byte-for-byte what it was; the new one keeps its own artifact, root and pointer back', () => {
    const r = rig();
    const { v1, v2, v3 } = threeDocumentVersions(r);
    const snapshot = () => [v1, v2, v3].map((v) => JSON.stringify(r.documentStore.get(v.documentId, T, U)));
    const before = snapshot();
    const artifactCountBefore = r.artifactStore.list(T, U).length;

    const result = restore(r, v1.documentId);
    assert.equal(result.status, 'SUCCESS');
    assert.deepEqual(snapshot(), before, 'no version was overwritten, deleted or re-labelled');
    assert.notEqual(result.creationId, v1.documentId);
    assert.notEqual(result.creationId, v3.documentId);

    const created = r.documentStore.get(result.creationId, T, U)!;
    assert.equal(created.content, v1.content);
    assert.equal(created.title, v1.title);
    assert.equal(created.parentDocumentId, v1.documentId);
    assert.equal(created.restoredFromDocumentId, v1.documentId);
    assert.equal(created.revisionIndex, 4, 'the next revision of the family');
    assert.ok(created.artifactId && created.artifactId !== v1.artifactId, 'its own artifact');
    assert.equal(r.artifactStore.list(T, U).length, artifactCountBefore + 1);
    const artifact = r.artifactStore.get(created.artifactId!, T, U)!;
    assert.equal(artifact.sourceId, created.documentId);
    assert.equal(r.artifactStore.get(created.artifactId!, T, 'usr_other'), null, 'the new artifact is the owner\'s alone');

    const family = r.versionService.listDocumentVersions(v1.documentId, T, U)!;
    assert.deepEqual(family.versions.map((v) => v.id), [created.documentId, v3.documentId, v2.documentId, v1.documentId]);
    assert.equal(family.versions[0].current, true);
    assert.equal(family.versions[0].restoredFromId, v1.documentId);
    assert.equal(family.versions[1].current, false);
  });

  it('restoring from any member of the family continues the SAME family, and is audited by id and title - never by text', () => {
    const r = rig();
    const { v1, v2 } = threeDocumentVersions(r);
    const result = restore(r, v2.documentId);
    assert.equal(result.status, 'SUCCESS');
    const created = r.documentStore.get(result.creationId, T, U)!;
    assert.equal(created.parentDocumentId, v1.documentId, 'the root of the family, not the version it was restored from');
    assert.equal(created.restoredFromDocumentId, v2.documentId);
    const event = r.auditLogger.getAuditLogs(T, 20).find((e) => e.action === 'document.restored')!;
    assert.ok(event, 'a restore is audited');
    assert.equal(event.resource.id, created.documentId);
    assert.equal(event.result, 'SUCCESS');
    assert.equal(JSON.stringify(event).includes('경쟁이 심해진다'), false, 'the audit trail never carries the text of the document');
  });

  it('restoring the newest version, or text that already is the newest, adds nothing (no second identical version from a double click)', () => {
    const r = rig();
    const { v1, v3 } = threeDocumentVersions(r);
    const newest = restore(r, v3.documentId);
    assert.deepEqual([newest.status, newest.errorCode], ['FAILED', 'VERSION_ALREADY_CURRENT']);
    const first = restore(r, v1.documentId);
    assert.equal(first.status, 'SUCCESS');
    const again = restore(r, v1.documentId);
    assert.deepEqual([again.status, again.errorCode], ['FAILED', 'VERSION_ALREADY_CURRENT'], 'the newest version already has v1\'s text');
    assert.equal(r.versionService.listDocumentVersions(v1.documentId, T, U)!.versions.length, 4);
    // restoring a different older version afterwards is a new, deliberate version
    const v2 = r.documentStore.get(docId(2), T, U)!;
    assert.equal(restore(r, v2.documentId).status, 'SUCCESS');
    assert.equal(r.versionService.listDocumentVersions(v1.documentId, T, U)!.versions.length, 5);
  });

  it('another person\'s version, another tenant\'s version and an unknown version are all "not found" - nothing is created', () => {
    const r = rig();
    const { v1 } = threeDocumentVersions(r);
    const count = () => r.documentStore.list(T, U, 100).length + r.documentStore.list(T, 'usr_other', 100).length;
    const before = count();
    for (const [id, who, tenant] of [[v1.documentId, 'usr_other', T], [v1.documentId, U, 'ten_other'], [docId(404), U, T]] as const) {
      const result = restore(r, id, who, tenant);
      assert.deepEqual([result.status, result.errorCode], ['FAILED', 'DOCUMENT_NOT_FOUND']);
    }
    assert.equal(count(), before);
    assert.equal(r.auditLogger.getAuditLogs(T, 50).some((e) => e.action === 'document.restored'), false);
  });
});

describe('the versions of a deck', () => {
  const slide = (title: string, ...bullets: string[]): PresentationOutlineSlide => ({ title, bullets });
  function threeDecks(r: ReturnType<typeof rig>) {
    const d1 = r.seedDeck(1, '도입 제안', [slide('목표', '출시'), slide('위험', '규제')]);
    const d2 = r.seedDeck(2, '도입 제안', [slide('목표', '출시'), slide('핵심 결론', '데이터가 경쟁력'), slide('위험', '규제')], { parentPresentationId: d1.presentationId, revisedFromPresentationId: d1.presentationId, revisionIndex: 2 });
    const d3 = r.seedDeck(3, '도입 제안 (최종)', [slide('목표', '출시', '비용 절감'), slide('핵심 결론', '데이터가 경쟁력')], { parentPresentationId: d1.presentationId, revisedFromPresentationId: d2.presentationId, revisionIndex: 3 });
    return { d1, d2, d3 };
  }

  it('lists the deck versions newest first and compares them slide by slide', () => {
    const r = rig();
    const { d1, d2, d3 } = threeDecks(r);
    const family = r.versionService.listPresentationVersions(d2.presentationId, T, U)!;
    assert.deepEqual(family.versions.map((v) => [v.id, v.current]), [[d3.presentationId, true], [d2.presentationId, false], [d1.presentationId, false]]);
    const comparison = r.versionService.comparePresentations(d1.presentationId, undefined, T, U);
    assert.ok(typeof comparison === 'object' && comparison.kind === 'PRESENTATION');
    if (typeof comparison === 'object' && comparison.kind === 'PRESENTATION') {
      assert.deepEqual(comparison.to.id, d3.presentationId);
      assert.deepEqual(comparison.diff.slides.map((s) => s.change), ['changed', 'removed', 'added']);
      assert.deepEqual(comparison.diff.titleChanged, { from: '도입 제안', to: '도입 제안 (최종)' });
    }
  });

  it('foreign, unrelated and unknown decks are refused the same way as documents', () => {
    const r = rig();
    const { d1 } = threeDecks(r);
    const other = r.seedDeck(9, '다른 발표', [slide('x', 'y')]);
    assert.equal(r.versionService.comparePresentations(d1.presentationId, other.presentationId, T, U), 'VERSIONS_NOT_RELATED');
    assert.equal(r.versionService.comparePresentations(d1.presentationId, undefined, T, 'usr_other'), 'NOT_FOUND');
    assert.equal(r.versionService.comparePresentations(d1.presentationId, deckId(404), T, U), 'NOT_FOUND');
    assert.equal(r.versionService.listPresentationVersions(d1.presentationId, 'ten_other', U), null);
  });

  it('restoring an older deck creates a NEW deck with the older slides and its own copy of the file; the older decks and their files are untouched', () => {
    const r = rig();
    const { d1, d2, d3 } = threeDecks(r);
    const snapshot = () => [d1, d2, d3].map((d) => {
      const record = r.presentationStore.get(d.presentationId, T, U)!;
      return JSON.stringify(record) + r.presentationStore.getBinary(record.binaryStoragePath)!.toString('base64');
    });
    const before = snapshot();
    const result = r.presentationExecutor.restoreVersion({ sourcePresentationId: d1.presentationId, tenantId: T, ownerId: U, requestId: 'req_r' });
    assert.equal(result.status, 'SUCCESS');
    assert.deepEqual(snapshot(), before);

    const created = r.presentationStore.get(result.creationId, T, U)!;
    assert.deepEqual(created.slides, d1.slides);
    assert.equal(created.title, d1.title);
    assert.equal(created.parentPresentationId, d1.presentationId);
    assert.equal(created.revisedFromPresentationId, d3.presentationId, 'follows the newest deck');
    assert.equal(created.restoredFromPresentationId, d1.presentationId);
    assert.equal(created.revisionIndex, 4);
    assert.notEqual(created.binaryStoragePath, d1.binaryStoragePath, 'its own file');
    assert.deepEqual(r.presentationStore.getBinary(created.binaryStoragePath), r.presentationStore.getBinary(d1.binaryStoragePath), 'the same bytes as the deck it brings back');
    assert.ok(created.artifactId && r.artifactStore.get(created.artifactId, T, U), 'its own artifact');
    assert.equal(r.artifactStore.get(created.artifactId!, T, 'usr_other'), null);
    const family = r.versionService.listPresentationVersions(d3.presentationId, T, U)!;
    assert.deepEqual([family.versions[0].id, family.versions[0].current, family.versions[0].restoredFromId], [created.presentationId, true, d1.presentationId]);
    assert.ok(r.auditLogger.getAuditLogs(T, 20).some((e) => e.action === 'presentation.restored' && e.resource.id === created.presentationId));
  });

  it('restoring the newest deck, someone else\'s deck, an unknown deck or a deck whose file is gone fails with the real reason and creates nothing', () => {
    const r = rig();
    const { d1, d3 } = threeDecks(r);
    const ask = (id: string, who = U, tenant = T) => r.presentationExecutor.restoreVersion({ sourcePresentationId: id, tenantId: tenant, ownerId: who, requestId: 'req' });
    assert.equal(ask(d3.presentationId).errorCode, 'VERSION_ALREADY_CURRENT');
    assert.equal(ask(d1.presentationId, 'usr_other').errorCode, 'PRESENTATION_NOT_FOUND');
    assert.equal(ask(d1.presentationId, U, 'ten_other').errorCode, 'PRESENTATION_NOT_FOUND');
    assert.equal(ask(deckId(404)).errorCode, 'PRESENTATION_NOT_FOUND');
    fs.rmSync(d1.binaryStoragePath);
    assert.equal(ask(d1.presentationId).errorCode, 'PRESENTATION_FILE_MISSING');
    assert.equal(r.versionService.listPresentationVersions(d3.presentationId, T, U)!.versions.length, 3, 'nothing was created by any of the refusals');
  });
});

describe('the version routes', () => {
  type R = ReturnType<typeof rig>;
  const docCall = (r: R, method: string, pathname: string, query: Record<string, string> = {}, who: { t: string; u: string } = { t: T, u: U }, withService = true) =>
    handleDocumentCreationRoutes(method as 'GET', pathname, null as never, authAs(who.t, who.u), query, {
      creationRuntime: r.creationRuntime, documentExecutor: r.documentExecutor, documentStore: r.documentStore, ...(withService ? { versionService: r.versionService } : {}),
    }) as Promise<{ status: number; data: any }>;
  const deckCall = (r: R, method: string, pathname: string, query: Record<string, string> = {}, who: { t: string; u: string } = { t: T, u: U }, withService = true) =>
    handlePresentationCreationRoutes(method as 'GET', pathname, null as never, authAs(who.t, who.u), query, {
      creationRuntime: r.creationRuntime, presentationStore: r.presentationStore, presentationExecutor: r.presentationExecutor, ...(withService ? { versionService: r.versionService } : {}),
    }) as Promise<{ status: number; data: any }>;
  const base = '/api/v1/creations/documents';

  it('documents: list (200), compare (200), restore (201) - then restoring again is 409 and the family has the new version', async () => {
    const r = rig();
    const { v1, v3 } = threeDocumentVersions(r);
    const list = await docCall(r, 'GET', `${base}/${v1.documentId}/versions`);
    assert.equal(list.status, 200);
    assert.deepEqual(list.data.versions.map((v: { id: string }) => v.id), [v3.documentId, docId(2), v1.documentId]);

    const compare = await docCall(r, 'GET', `${base}/${v1.documentId}/compare`);
    assert.equal(compare.status, 200);
    assert.equal(compare.data.comparison.to.id, v3.documentId);
    assert.deepEqual(compare.data.comparison.diff.stats, { added: 4, removed: 1, unchanged: 6 });
    const explicit = await docCall(r, 'GET', `${base}/${v1.documentId}/compare`, { to: docId(2) });
    assert.equal(explicit.data.comparison.to.id, docId(2));

    const restored = await docCall(r, 'POST', `${base}/${v1.documentId}/restore`);
    assert.equal(restored.status, 201);
    assert.equal(restored.data.status, 'SUCCESS');
    assert.equal(restored.data.metadata.restoredFrom, v1.documentId);
    const again = await docCall(r, 'POST', `${base}/${v1.documentId}/restore`);
    assert.equal(again.status, 409);
    assert.equal(again.data.error, 'VERSION_ALREADY_CURRENT');
    const family = await docCall(r, 'GET', `${base}/${v3.documentId}/versions`);
    assert.equal(family.data.versions.length, 4);
    assert.equal(family.data.versions[0].restoredFromId, v1.documentId);
  });

  it('documents: someone else, another tenant, an unknown id and a malformed id are all 404 with the same body shape; unrelated documents are 400', async () => {
    const r = rig();
    const { v1 } = threeDocumentVersions(r);
    const other = r.seedDocument(9, '# 다른 문서');
    const responses = [
      await docCall(r, 'GET', `${base}/${v1.documentId}/versions`, {}, { t: T, u: 'usr_other' }),
      await docCall(r, 'GET', `${base}/${v1.documentId}/compare`, {}, { t: 'ten_other', u: U }),
      await docCall(r, 'POST', `${base}/${v1.documentId}/restore`, {}, { t: T, u: 'usr_other' }),
      await docCall(r, 'GET', `${base}/${docId(404)}/versions`),
      await docCall(r, 'GET', `${base}/${v1.documentId}/compare`, { to: docId(404) }),
      await docCall(r, 'GET', `${base}/${v1.documentId}/compare`, { to: '../../etc/passwd' }),
      await docCall(r, 'GET', `${base}/doc_ZZZ/versions`),
    ];
    for (const res of responses) assert.equal(res.status, 404, JSON.stringify(res.data));
    assert.deepEqual([...new Set(responses.map((res) => res.data.error))], ['DOCUMENT_NOT_FOUND']);
    const unrelated = await docCall(r, 'GET', `${base}/${v1.documentId}/compare`, { to: other.documentId });
    assert.deepEqual([unrelated.status, unrelated.data.error], [400, 'VERSIONS_NOT_RELATED']);
    assert.equal(r.documentStore.list(T, U, 100).length, 4, 'a refusal creates nothing');
  });

  it('documents: the newest report with earlier versions is found for "지난번 보고서"; none yet is 404 NO_VERSIONS; without the service it is 503', async () => {
    const r = rig();
    const none = await docCall(r, 'GET', '/api/v1/creations/versions/latest');
    assert.deepEqual([none.status, none.data.error], [404, 'NO_VERSIONS']);
    threeDocumentVersions(r);
    const found = await docCall(r, 'GET', '/api/v1/creations/versions/latest');
    assert.equal(found.status, 200);
    assert.equal(found.data.kind, 'DOCUMENT');
    assert.ok(found.data.versions.length >= 3);
    const foreign = await docCall(r, 'GET', '/api/v1/creations/versions/latest', {}, { t: T, u: 'usr_other' });
    assert.equal(foreign.status, 404);
    const unavailable = await docCall(r, 'GET', '/api/v1/creations/versions/latest', {}, { t: T, u: U }, false);
    assert.deepEqual([unavailable.status, unavailable.data.error], [503, 'VERSIONS_UNAVAILABLE']);
  });

  const deckBase = '/api/v1/creations/presentations';
  it('decks: list, compare and restore work; the refusals are the documents\' refusals', async () => {
    const r = rig();
    const slide = (title: string, ...bullets: string[]): PresentationOutlineSlide => ({ title, bullets });
    const d1 = r.seedDeck(1, '제안', [slide('목표', '출시')]);
    const d2 = r.seedDeck(2, '제안', [slide('목표', '출시'), slide('결론', '데이터')], { parentPresentationId: d1.presentationId, revisedFromPresentationId: d1.presentationId, revisionIndex: 2 });

    const list = await deckCall(r, 'GET', `${deckBase}/${d1.presentationId}/versions`);
    assert.deepEqual([list.status, list.data.versions.map((v: { id: string }) => v.id)], [200, [d2.presentationId, d1.presentationId]]);
    const compare = await deckCall(r, 'GET', `${deckBase}/${d1.presentationId}/compare`);
    assert.equal(compare.status, 200);
    assert.deepEqual(compare.data.comparison.diff.stats, { added: 1, removed: 0, changed: 0, unchanged: 1 });

    const restored = await deckCall(r, 'POST', `${deckBase}/${d1.presentationId}/restore`);
    assert.equal(restored.status, 201);
    assert.equal(restored.data.metadata.restoredFrom, d1.presentationId);
    assert.equal((await deckCall(r, 'POST', `${deckBase}/${d1.presentationId}/restore`)).status, 409);

    for (const res of [
      await deckCall(r, 'GET', `${deckBase}/${d1.presentationId}/versions`, {}, { t: T, u: 'usr_other' }),
      await deckCall(r, 'GET', `${deckBase}/${d1.presentationId}/compare`, {}, { t: 'ten_other', u: U }),
      await deckCall(r, 'POST', `${deckBase}/${d1.presentationId}/restore`, {}, { t: T, u: 'usr_other' }),
      await deckCall(r, 'GET', `${deckBase}/${deckId(404)}/versions`),
      await deckCall(r, 'GET', `${deckBase}/not-a-deck/versions`),
      await deckCall(r, 'GET', `${deckBase}/${d1.presentationId}/compare`, { to: '../x' }),
    ]) {
      assert.equal(res.status, 404);
      assert.equal(res.data.error, 'PRESENTATION_NOT_FOUND');
    }
    const unavailable = await deckCall(r, 'GET', `${deckBase}/${d1.presentationId}/versions`, {}, { t: T, u: U }, false);
    assert.equal(unavailable.status, 503);
    assert.equal(r.presentationStore.list(T, U, 100).length, 3, 'only the one restore created a deck');
  });
});

describe('routing: the words "compare the versions"', () => {
  const route = (text: string, options: Parameters<typeof decideRouting>[1] = {}) => decideRouting(text, options);

  it('the mission sentence is a request to look at the versions of a report - nothing is created, nothing is sent', () => {
    const d = route('지난번 보고서 수정 전 버전과 지금 버전을 비교해줘.');
    assert.deepEqual([d.kind, d.targetArtifactType, d.reasonCodes.includes('COMPARE_VERSIONS'), d.permissionRisk, d.destructive], ['CONVERSATION', 'DOCUMENT', true, 'NONE', false]);
    const deck = route('발표자료 수정 전 버전과 지금 버전 차이를 보여줘');
    assert.deepEqual([deck.targetArtifactType, deck.reasonCodes.includes('COMPARE_VERSIONS')], ['PRESENTATION', true]);
    const english = route('Compare the earlier version of the report with the current version');
    assert.deepEqual([english.targetArtifactType, english.reasonCodes.includes('COMPARE_VERSIONS')], ['DOCUMENT', true]);
    assert.equal(route('what changed between the versions of my presentation?').reasonCodes.includes('COMPARE_VERSIONS'), true);
    assert.equal(route('보고서에서 뭐가 달라졌어?').reasonCodes.includes('COMPARE_VERSIONS'), true);
  });

  it('with a report open, the same words need no noun; with nothing in play, "compare versions" is not about the person\'s files', () => {
    const open = route('수정 전 버전과 비교해줘', { activeArtifact: 'DOCUMENT' });
    assert.equal(open.reasonCodes.includes('COMPARE_VERSIONS'), true);
    assert.equal(route('수정 전 버전과 비교해줘').reasonCodes.includes('COMPARE_VERSIONS'), false);
    assert.equal(route('Compare Python 2 and Python 3 versions').reasonCodes.includes('COMPARE_VERSIONS'), false);
    assert.equal(route('두 제품 버전의 차이를 비교해줘').reasonCodes.includes('COMPARE_VERSIONS'), false);
  });

  it('"restore the previous version" is the restore path (the Versions view), and a request to MAKE something is never taken for a version request', () => {
    const restore = route('보고서를 이전 버전으로 되돌려줘');
    assert.deepEqual([restore.kind, restore.targetArtifactType, restore.reasonCodes.includes('RESTORE_VERSION')], ['CONVERSATION', 'DOCUMENT', true]);
    assert.equal(route('Restore the original version of the deck').reasonCodes.includes('RESTORE_VERSION'), true);
    assert.equal(route('두 버전을 비교하는 보고서를 만들어줘').reasonCodes.includes('COMPARE_VERSIONS'), false);
    assert.equal(route('write a report comparing the versions of the product').reasonCodes.includes('COMPARE_VERSIONS'), false);
    // an ordinary document or deck request is untouched
    assert.equal(route('AI 산업 보고서 만들어줘').kind, 'CREATE_ARTIFACT');
  });
});
