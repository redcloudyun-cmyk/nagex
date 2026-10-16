// R26-D in REAL Chromium against the PRODUCTION server: "지난번 보고서 수정 전 버전과 지금 버전을 비교해줘." The report and the deck each have several versions (made by revisions); the person asks in plain words and
// sees what changed between the version before and the current one, can list every version, bring an older one back as a NEW version (nothing is overwritten - the stored files of the older versions are
// byte-for-byte what they were), and another signed-in person gets nothing. No model is involved: the versions are stored text, the comparison is computed by NAgex.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { Page } from 'playwright';
import { startCanvasAskHarness, type CanvasAskHarness, type DisposableUser } from './_canvas_ask_harness.js';
import { ArtifactStore } from '../src/artifacts/artifact.store.js';
import { PresentationStore } from '../src/creation/presentation.store.js';
import { buildPptx } from '../src/creation/pptx/pptx-writer.js';
import type { PresentationOutlineSlide } from '../src/model-gateway/presentation-outline.js';

declare const document: any;

let h: CanvasAskHarness;
before(async () => { h = await startCanvasAskHarness({ scrubProviders: true }); });
after(async () => { await h?.close(); });

const hex = (n: number) => crypto.randomBytes(n / 2).toString('hex');
const iso = (minutes: number) => new Date(Date.parse('2026-10-01T09:00:00Z') + minutes * 60_000).toISOString();

interface Seeded { documentId: string; artifactId: string }

function seedVersion(owner: DisposableUser, title: string, content: string, revisionIndex: number, minutes: number, parent?: string): Seeded {
  const documentId = `doc_${hex(24)}`;
  const at = iso(minutes);
  h.documentStore.save({
    documentId, tenantId: owner.tenantId, ownerId: owner.userId, title, summary: `${title} ${revisionIndex}`, content, documentKind: 'REPORT', locale: 'ko', format: 'MARKDOWN', sourceRefs: [],
    revisionIndex, ...(parent ? { parentDocumentId: parent } : {}), createdAt: at, updatedAt: at,
  });
  const artifact = new ArtifactStore({ dir: process.env.NAGEX_ARTIFACTS_DIR, now: () => at }).saveCompleted({
    tenantId: owner.tenantId, ownerId: owner.userId, type: 'DOCUMENT', title, preview: `${title} ${revisionIndex}`, sourceType: 'CAPTURE', sourceId: documentId, openTarget: `/api/v1/creations/documents/${documentId}`,
  });
  const record = h.documentStore.get(documentId, owner.tenantId, owner.userId)!;
  h.documentStore.save({ ...record, artifactId: artifact.artifactId });
  return { documentId, artifactId: artifact.artifactId };
}

const V1 = '# 분기 보고서\n\n## 시장\n시장은 커진다.\n\n## 위험\n규제가 변수다.';
const V2 = '# 분기 보고서\n\n## 시장\n시장은 커진다.\n\n## 경쟁\n경쟁이 심해진다.\n\n## 위험\n규제가 변수다.';
const V3 = '# 분기 보고서\n\n## 시장\n시장은 크게 커진다.\n\n## 경쟁\n경쟁이 심해진다.\n\n## 위험\n규제가 변수다.';

function seedReport(owner: DisposableUser, title = '분기 보고서') {
  const v1 = seedVersion(owner, title, V1, 1, 0);
  const v2 = seedVersion(owner, title, V2, 2, 10, v1.documentId);
  const v3 = seedVersion(owner, title, V3, 3, 20, v1.documentId);
  return { v1, v2, v3 };
}

function seedDeck(owner: DisposableUser, id: string, title: string, slides: PresentationOutlineSlide[], revisionIndex: number, minutes: number, parent?: string, revisedFrom?: string) {
  const store = new PresentationStore();
  const at = iso(minutes);
  const bytes = buildPptx({ title, subtitle: '', locale: 'ko', slides }, new Date(at));
  const presentationId = `pres_${id}`;
  const artifact = new ArtifactStore({ dir: process.env.NAGEX_ARTIFACTS_DIR, now: () => at }).saveCompleted({
    tenantId: owner.tenantId, ownerId: owner.userId, type: 'PRESENTATION', title, preview: `${title} ${revisionIndex}`, sourceType: 'CAPTURE', sourceId: presentationId, openTarget: `/api/v1/creations/presentations/${presentationId}`,
  });
  store.save({
    presentationId, tenantId: owner.tenantId, ownerId: owner.userId, title, subtitle: '', summary: `${title} ${revisionIndex}`, locale: 'ko', slides, mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    byteLength: bytes.length, binaryStoragePath: store.saveBinary(presentationId, bytes), sourceRefs: [], providerExecutionMetadata: { providerId: 'local-pptx', createdAt: at }, artifactId: artifact.artifactId,
    revisionIndex, ...(parent ? { parentPresentationId: parent, revisedFromPresentationId: revisedFrom } : {}), createdAt: at, updatedAt: at,
  });
  return { presentationId, artifactId: artifact.artifactId };
}

async function openMain(user: DisposableUser, locale: 'en' | 'ko'): Promise<Page> {
  const ctx = await h.newContext('desktop', user, locale);
  const page = await ctx.newPage();
  await page.goto(`${h.origin}/#home`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#main-surface-input', { timeout: 20000 });
  return page;
}

const ask = async (page: Page, text: string) => { await page.fill('#main-surface-input', text); await page.click('#main-send'); };
type Reply = { status: number; data: any };
const get = (page: Page, path: string): Promise<Reply> => page.evaluate(async (p: string) => { const res = await fetch(p); return { status: res.status, data: await res.json().catch(() => null) }; }, path);
const post = (page: Page, path: string): Promise<Reply> => page.evaluate(async (p: string) => { const res = await fetch(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); return { status: res.status, data: await res.json().catch(() => null) }; }, path);

describe('Versions of a report, in the browser', () => {
  it('ko: the mission sentence shows what changed between the version before and the current one; every version is listed; an older one comes back as a NEW version; originals are untouched; a stranger gets nothing', async () => {
    const user = h.user('versions_ko');
    h.setLocale(user, 'ko');
    const { v1, v2, v3 } = seedReport(user);
    const hashes = () => [v1, v2, v3].map((v) => h.documentFileHash(v.documentId));
    const before = hashes();
    const page = await openMain(user, 'ko');

    // 1. the sentence, with nothing open: "지난번 보고서" is the newest report that has earlier versions
    await ask(page, '지난번 보고서 수정 전 버전과 지금 버전을 비교해줘.');
    await page.waitForSelector('#main-result-panel:not([hidden]) .main-diff', { timeout: 20000 });
    const head = await page.locator('.main-diff-head').innerText();
    assert.match(head, /버전 2/);
    assert.match(head, /버전 3/);
    assert.match(head, /현재/);
    assert.equal(await page.locator('.main-diff-line.added .main-diff-text', { hasText: '시장은 크게 커진다.' }).count(), 1, 'the new wording is shown as added');
    assert.equal(await page.locator('.main-diff-line.removed .main-diff-text', { hasText: '시장은 커진다.' }).count(), 1, 'the old wording is shown as removed');
    assert.match(await page.locator('.main-diff-stats').innerText(), /추가 1줄, 삭제 1줄/);
    assert.match(await page.locator('.main-turn').last().innerText(), /버전을 비교했어요/);
    assert.equal(await page.locator('#main-result-versions').isEnabled(), true);

    // 2. all versions, newest first, the current one marked; the older ones can be compared, viewed and brought back
    await page.click('.main-version-back');
    await page.waitForSelector('.main-versions-list');
    assert.equal(await page.locator('.main-version-item').count(), 3);
    assert.match(await page.locator('.main-version-item').first().innerText(), /버전 3[\s\S]*현재/);
    assert.equal(await page.locator('.main-version-item.current .main-version-restore').count(), 0, 'the current version has nothing to bring back');
    assert.equal(await page.locator('.main-version-item .main-version-restore').count(), 2);

    // 3. bring version 1 back: a NEW version 4 with version 1's text; versions 1-3 are exactly what they were
    await page.locator(`.main-version-item[data-version-id="${v1.documentId}"] .main-version-restore`).click();
    await page.waitForSelector('.main-version-item:nth-child(4)', { timeout: 15000 });
    assert.equal(await page.locator('.main-version-item').count(), 4);
    assert.match(await page.locator('.main-versions-notice').innerText(), /버전 1을\(를\) 버전 4\(으\)로 되살렸어요/);
    const newest = page.locator('.main-version-item').first();
    assert.match(await newest.innerText(), /버전 4[\s\S]*현재/);
    assert.match(await newest.innerText(), /버전 1을\(를\) 되살린 버전/);
    assert.deepEqual(hashes(), before, 'the stored files of versions 1-3 are byte-for-byte what they were');

    // the preview now shows version 1's text as the current report
    await page.click('#main-result-preview-tab');
    await page.waitForFunction(() => /규제가 변수다/.test(document.querySelector('#main-result-preview')?.textContent || '') && !/경쟁이 심해진다/.test(document.querySelector('#main-result-preview')?.textContent || ''), undefined, { timeout: 10000 });

    // bringing back the same text again is refused with the reason, and adds nothing
    await page.click('#main-result-versions');
    await page.waitForSelector('.main-versions-list');
    await page.locator(`.main-version-item[data-version-id="${v1.documentId}"] .main-version-restore`).click();
    await page.waitForSelector('.main-versions-notice');
    assert.match(await page.locator('.main-versions-notice').innerText(), /이미 현재 버전/);
    assert.equal(await page.locator('.main-version-item').count(), 4);

    // 4. comparing an older version with the current one from the list
    await page.locator(`.main-version-item[data-version-id="${v2.documentId}"] .main-version-compare`).click();
    await page.waitForSelector('.main-diff');
    assert.equal(await page.locator('.main-diff-line.removed .main-diff-text', { hasText: '경쟁이 심해진다.' }).count(), 1);
    assert.doesNotMatch(await page.locator('body').innerText(), /mainVersions\.|doc_[0-9a-f]{24}/, 'no raw i18n keys, no internal ids');

    // 5. another signed-in person: none of it is reachable, and the same sentence finds nothing of the other person's
    const stranger = h.user('versions_ko_stranger');
    h.setLocale(stranger, 'ko');
    const other = await openMain(stranger, 'ko');
    for (const path of [`/versions`, `/compare`]) assert.equal((await get(other, `/api/v1/creations/documents/${v1.documentId}${path}`)).status, 404);
    assert.equal((await post(other, `/api/v1/creations/documents/${v1.documentId}/restore`)).status, 404);
    await ask(other, '지난번 보고서 수정 전 버전과 지금 버전을 비교해줘.');
    await other.waitForFunction(() => /이전 버전이 없어요/.test(document.querySelector('.main-turn:last-child')?.textContent || ''), undefined, { timeout: 15000 });
    assert.equal(await other.locator('.main-diff').count(), 0);
    assert.deepEqual(hashes().slice(0, 3), before, 'still untouched after the stranger\'s attempts');
  });

  it('en: the same request in English, and "restore the previous version" opens the list instead of acting on words alone', async () => {
    const user = h.user('versions_en');
    const { v2, v3 } = seedReport(user, 'Quarterly report');
    const page = await openMain(user, 'en');
    await ask(page, 'Compare the earlier version of the report with the current version');
    await page.waitForSelector('#main-result-panel:not([hidden]) .main-diff', { timeout: 20000 });
    assert.match(await page.locator('.main-diff-head').innerText(), /Version 2[\s\S]*Version 3[\s\S]*Current/);
    assert.match(await page.locator('.main-diff-stats').innerText(), /1 lines added, 1 removed/);
    assert.match(await page.locator('.main-turn').last().innerText(), /Comparing the versions/);

    await ask(page, 'Restore the previous version of the report');
    await page.waitForSelector('.main-versions-list', { timeout: 15000 });
    assert.equal(await page.locator('.main-version-item').count(), 3, 'nothing was restored by the words alone');
    assert.match(await page.locator('.main-turn').last().innerText(), /Pick the version to bring back/);
    assert.equal((await get(page, `/api/v1/creations/documents/${v3.documentId}/versions`)).data.versions.length, 3);
    void v2;
  });

  it('a report without any earlier version says so plainly instead of inventing a comparison', async () => {
    const user = h.user('versions_none');
    seedVersion(user, 'Only one', V1, 1, 0);
    const page = await openMain(user, 'en');
    await ask(page, 'Compare the earlier version of the report with the current version');
    await page.waitForFunction(() => /no report with an earlier version/i.test(document.querySelector('.main-turn:last-child')?.textContent || ''), undefined, { timeout: 15000 });
    assert.equal(await page.locator('.main-diff').count(), 0);
  });
});

describe('Versions of a deck, in the browser', () => {
  it('ko: the slides that were added, removed and changed are shown; the older deck comes back as a new deck with the same slides', async () => {
    const user = h.user('versions_deck');
    h.setLocale(user, 'ko');
    const slide = (title: string, ...bullets: string[]): PresentationOutlineSlide => ({ title, bullets });
    const root = hex(24);
    const d1 = seedDeck(user, root, '도입 제안', [slide('목표', '출시'), slide('위험', '규제')], 1, 0);
    const d2 = seedDeck(user, hex(24), '도입 제안', [slide('목표', '출시', '비용 절감'), slide('핵심 결론', '데이터가 경쟁력')], 2, 10, d1.presentationId, d1.presentationId);
    const page = await openMain(user, 'ko');
    await ask(page, '발표자료 수정 전 버전과 지금 버전 차이를 보여줘');
    await page.waitForSelector('#main-result-panel:not([hidden]) .main-diff-slide', { timeout: 20000 });
    const slides = await page.locator('.main-diff-slide').evaluateAll((nodes: any[]) => nodes.map((n) => n.className.replace('main-diff-slide ', '')));
    assert.deepEqual(slides, ['changed', 'removed', 'added']);
    assert.match(await page.locator('.main-diff-stats').innerText(), /슬라이드 추가 1장, 삭제 1장, 수정 1장, 그대로 0장/);
    assert.equal(await page.locator('.main-diff-slide.removed .main-diff-line.removed .main-diff-text', { hasText: '규제' }).count(), 1);

    await page.click('.main-version-back');
    await page.waitForSelector('.main-versions-list');
    assert.equal(await page.locator('.main-version-item').count(), 2);
    await page.locator(`.main-version-item[data-version-id="${d1.presentationId}"] .main-version-restore`).click();
    await page.waitForSelector('.main-version-item:nth-child(3)', { timeout: 15000 });
    assert.match(await page.locator('.main-versions-notice').innerText(), /되살렸어요/);
    const family = await get(page, `/api/v1/creations/presentations/${d1.presentationId}/versions`);
    assert.equal(family.data.versions.length, 3);
    assert.equal(family.data.versions[0].restoredFromId, d1.presentationId);
    const viewer = await get(page, `/api/v1/creations/presentations/${family.data.versions[0].id}`);
    assert.deepEqual(viewer.data.presentation.slides, [slide('목표', '출시'), slide('위험', '규제')]);
    const original = await get(page, `/api/v1/creations/presentations/${d2.presentationId}`);
    assert.equal(original.data.presentation.slides.length, 2, 'the deck that was current before is untouched');
  });
});
