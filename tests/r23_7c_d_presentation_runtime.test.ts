// R23.7C-D — Presentation / Slides runtime: the .pptx package, the outline contract, the executor (truthful failures, ownership), the routes
// (authorization, tenant/owner isolation, download headers) and the real composition root. No model is called: the AiService is a deterministic
// fake; the file writer, stores, router and routes are the real code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPptx, PPTX_MIME, xmlText } from '../src/creation/pptx/pptx-writer.js';
import { buildZip, readZip, crc32 } from '../src/creation/pptx/zip-writer.js';
import { normalizePresentationOutline, outlineToMarkdown, OUTLINE_LIMITS } from '../src/model-gateway/presentation-outline.js';
import { AiService } from '../src/model-gateway/ai-service.js';
import { PresentationExecutor } from '../src/creation/executors/presentation-executor.js';
import { PresentationStore, PRESENTATION_ID_PATTERN } from '../src/creation/presentation.store.js';
import { CreationProviderRouter } from '../src/creation/providers/creation-provider-router.js';
import { LocalPptxPresentationAdapter } from '../src/creation/providers/adapters/local-pptx-adapter.js';
import { CreationRuntime } from '../src/creation/creation-runtime.js';
import { ArtifactStore } from '../src/artifacts/artifact.store.js';
import { DocumentStore } from '../src/creation/document.store.js';
import { AuditLogger } from '../src/governance/audit.logger.js';
import { NagexError } from '../src/common/errors.js';
import { handlePresentationCreationRoutes, downloadFileName } from '../src/http/routes/presentation-creation.routes.js';
import { authAs } from './_s1_session_auth.js';

const tempDir = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), name));

// ── a deliberately small, strict XML well-formedness check (no parser dependency) ──
function assertWellFormed(xml: string, where: string): void {
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'), `${where}: XML declaration`);
  assert.equal(/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(xml), false, `${where}: stray ampersand`);
  // eslint-disable-next-line no-control-regex
  assert.equal(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(xml), false, `${where}: control character`);
  const stack: string[] = [];
  const tagPattern = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>|<\?[^>]*\?>/g;
  let consumed = 0; let match: RegExpExecArray | null;
  const body = xml.replace(/^<\?xml[^>]*\?>\n?/, '');
  const re = new RegExp(tagPattern.source, 'g');
  while ((match = re.exec(body))) {
    const between = body.slice(consumed, match.index);
    assert.equal(between.includes('<'), false, `${where}: malformed markup near ${JSON.stringify(between.slice(0, 40))}`);
    consumed = re.lastIndex;
    if (match[0].startsWith('<?')) continue;
    const [, closing, name, , selfClosing] = match;
    if (closing) { assert.equal(stack.pop(), name, `${where}: mismatched </${name}>`); } else if (!selfClosing) stack.push(name);
  }
  assert.equal(body.slice(consumed).trim(), '', `${where}: trailing content`);
  assert.deepEqual(stack, [], `${where}: unclosed elements`);
}

function relsTargets(xml: string): string[] {
  return [...xml.matchAll(/Target="([^"]+)"/g)].map((m) => m[1]);
}
const resolve = (from: string, target: string) => path.posix.normalize(path.posix.join(path.posix.dirname(from), target));

const DECK_EN = { title: 'Q3 <Plan> & "Review"', subtitle: 'Prepared for the team', locale: 'en' as const, slides: [{ title: 'Goals', bullets: ['Ship the beta', 'Cut costs & risk'] }, { title: 'Next steps', bullets: ['Hire', 'Plan\u0001 launch'] }] };
const DECK_KO = { title: '3분기 계획', subtitle: '', locale: 'ko' as const, slides: [{ title: '목표', bullets: ['베타 출시', '비용 절감'] }, { title: '다음 단계', bullets: ['채용'] }] };

test('A. the .pptx package is a structurally valid PresentationML package (zip integrity, well-formed XML, content types, relationship targets)', () => {
  for (const deck of [DECK_EN, DECK_KO]) {
    const buffer = buildPptx(deck, new Date('2026-10-13T00:00:00Z'));
    assert.equal(buffer.subarray(0, 2).toString('latin1'), 'PK');
    const entries = readZip(buffer); // also verifies every CRC-32
    const names = entries.map((e) => e.name);
    assert.equal(names[0], '[Content_Types].xml', 'content types is the first entry');
    assert.equal(new Set(names).size, names.length, 'no duplicate part names');
    const slideCount = 1 + deck.slides.length;
    for (let i = 1; i <= slideCount; i += 1) assert.ok(names.includes(`ppt/slides/slide${i}.xml`), `slide ${i}`);
    for (const required of ['_rels/.rels', 'ppt/presentation.xml', 'ppt/_rels/presentation.xml.rels', 'ppt/slideMasters/slideMaster1.xml', 'ppt/slideLayouts/slideLayout1.xml', 'ppt/slideLayouts/slideLayout2.xml', 'ppt/theme/theme1.xml', 'docProps/core.xml', 'docProps/app.xml']) assert.ok(names.includes(required), required);

    const byName = new Map(entries.map((e) => [e.name, e.data.toString('utf8')]));
    for (const [name, xml] of byName) assertWellFormed(xml, name);

    // every part has a content type (default for rels/xml, override for the typed parts)
    const types = byName.get('[Content_Types].xml')!;
    for (const name of names) {
      if (name === '[Content_Types].xml' || name.endsWith('.rels')) continue;
      assert.ok(types.includes(`PartName="/${name}"`), `content type override for ${name}`);
    }
    // every relationship points at a part that exists
    for (const name of names.filter((n) => n.endsWith('.rels'))) {
      const owner = name === '_rels/.rels' ? '' : name.replace('_rels/', '').replace(/\.rels$/, '');
      for (const target of relsTargets(byName.get(name)!)) {
        const resolved = owner ? resolve(owner, target) : path.posix.normalize(target);
        assert.ok(names.includes(resolved), `${name}: target ${target} -> ${resolved} exists`);
      }
    }
    // slide ids and rIds line up with the parts
    const presentation = byName.get('ppt/presentation.xml')!;
    assert.equal((presentation.match(/<p:sldId /g) || []).length, slideCount);
    assert.ok(presentation.includes('<p:sldSz cx="12192000" cy="6858000"/>'), '16:9');
    assert.equal(byName.get('docProps/app.xml')!.includes(`<Slides>${slideCount}</Slides>`), true);

    // text is present, escaped, and free of control characters
    const slide1 = byName.get('ppt/slides/slide1.xml')!;
    assert.ok(slide1.includes(`<a:t>${xmlText(deck.title)}</a:t>`));
    const joined = names.filter((n) => n.startsWith('ppt/slides/slide')).map((n) => byName.get(n)).join('');
    for (const slide of deck.slides) { assert.ok(joined.includes(xmlText(slide.title))); for (const bullet of slide.bullets) assert.ok(joined.includes(xmlText(bullet))); }
    assert.equal(joined.includes('\u0001'), false);
    assert.ok(deck.locale === 'ko' ? joined.includes('lang="ko-KR"') : joined.includes('lang="en-US"'));
  }
});

test('A2. zip writer: CRC-32 matches the reference value, unsafe names are refused, tampering is detected', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.throws(() => buildZip([{ name: '../evil.xml', data: Buffer.from('x') }]));
  assert.throws(() => buildZip([{ name: '/abs.xml', data: Buffer.from('x') }]));
  const zip = buildZip([{ name: 'a.txt', data: Buffer.from('hello hello hello hello') }]);
  assert.equal(readZip(zip)[0].data.toString(), 'hello hello hello hello');
  const tampered = Buffer.from(zip); tampered[35] ^= 0xff;
  assert.throws(() => readZip(tampered));
});

test('B. the outline contract: bounds, control characters, dropped empty slides, no invented padding', () => {
  const ok = normalizePresentationOutline({ title: ' Deck\u0000 ', subtitle: 'x'.repeat(500), slides: [{ title: 'One', bullets: ['a', ' ', 'b'] }, { title: 'Two', bullets: Array.from({ length: 12 }, (_, i) => `b${i}`) }, { title: '', bullets: ['orphan'] }, { title: 'No bullets', bullets: [] }, 'junk'] }, 'r1');
  assert.equal(ok.title, 'Deck');
  assert.ok(ok.subtitle.length <= OUTLINE_LIMITS.maxSubtitleChars);
  assert.equal(ok.slides.length, 2, 'empty and titleless slides are dropped');
  assert.deepEqual(ok.slides[0].bullets, ['a', 'b']);
  assert.equal(ok.slides[1].bullets.length, OUTLINE_LIMITS.maxBulletsPerSlide);
  const many = normalizePresentationOutline({ title: 'T', slides: Array.from({ length: 40 }, (_, i) => ({ title: `S${i}`, bullets: ['x'] })) }, 'r2');
  assert.equal(many.slides.length, OUTLINE_LIMITS.maxContentSlides);
  assert.throws(() => normalizePresentationOutline({ title: 'T', slides: [{ title: 'Only', bullets: ['x'] }] }, 'r3'), (e: any) => e instanceof NagexError && e.code === 'EMPTY_GENERATION');
  assert.throws(() => normalizePresentationOutline({ slides: [] }, 'r4'), (e: any) => e.code === 'INVALID_MODEL_RESPONSE');
  assert.match(outlineToMarkdown(ok), /^# Deck\n/);
});

test('B2. AiService.presentationOutline routes the PRESENTATION_SYNTHESIS task, grounds on source context, speaks the locale and validates the answer', async () => {
  const seen: any[] = [];
  const answer = JSON.stringify({ title: '런칭 계획', subtitle: '', slides: [{ title: '목표', bullets: ['출시'] }, { title: '일정', bullets: ['10월'] }] });
  const router: any = { generate: async (req: any) => { seen.push(req); req.validate?.(answer); return { text: answer, provider: 'fake', model: 'm', latencyMs: 3, requestId: req.requestId }; } };
  const result = await new AiService(router).presentationOutline({ prompt: '런칭 발표', locale: 'ko', sourceContext: 'SOURCE-NOTES-123', requestId: 'req_x' });
  assert.equal(seen[0].routingContext.taskKind, 'PRESENTATION_SYNTHESIS');
  assert.equal(seen[0].jsonMode, true);
  assert.match(seen[0].messages[0].content, /SOURCE-NOTES-123/);
  assert.match(seen[0].messages[0].content, /한국어/);
  assert.equal(result.data.slides.length, 2);
  const bad: any = { generate: async (req: any) => { req.validate?.('{"title":"x","slides":[]}'); return { text: '{}', provider: 'fake', model: 'm', latencyMs: 1, requestId: 'r' }; } };
  await assert.rejects(() => new AiService(bad).presentationOutline({ prompt: 'x' }), (e: any) => e.code === 'EMPTY_GENERATION');
});

// ── executor ──
function makeRuntime(aiService: any, opts: { withProvider?: boolean } = {}) {
  const presentationStore = new PresentationStore({ metaDir: tempDir('pres-meta-'), bytesDir: tempDir('pres-bytes-') });
  const artifactStore = new ArtifactStore({ dir: tempDir('pres-art-') });
  const documentStore = new DocumentStore({ dir: tempDir('pres-doc-') });
  const providerRouter = new CreationProviderRouter();
  if (opts.withProvider !== false) providerRouter.registerPresentationProvider(new LocalPptxPresentationAdapter());
  const events: any[] = [];
  const auditLogger = new AuditLogger();
  (auditLogger as any).logEvent = (e: any) => { events.push(e); };
  const executor = new PresentationExecutor({ aiService, presentationStore, providerRouter, artifactStore, documentStore, auditLogger });
  const creationRuntime = new CreationRuntime([executor]);
  return { executor, creationRuntime, presentationStore, artifactStore, documentStore, providerRouter, events };
}
const OUTLINE = { title: 'Launch plan', subtitle: 'Autumn', slides: [{ title: 'Goals', bullets: ['Ship', 'Learn'] }, { title: 'Risks', bullets: ['Time'] }] };
const okAi = (calls: any[] = []) => ({ presentationOutline: async (input: any) => { calls.push(input); return { data: OUTLINE, provider: 'fake-provider', model: 'fake-model', latencyMs: 5, requestId: input.requestId }; } });
const base = { creationKind: 'PRESENTATION' as const, tenantId: 'ten_a', ownerId: 'usr_a', requestId: 'req_1' };

test('C. a successful deck: NAgex-owned id, a real .pptx, an artifact projection, an audit event, and no provider identity in the result', async () => {
  const rt = makeRuntime(okAi());
  const result = await rt.creationRuntime.create({ ...base, prompt: 'Plan the launch', options: { locale: 'en' } });
  assert.equal(result.status, 'SUCCESS');
  assert.match(result.creationId, PRESENTATION_ID_PATTERN);
  assert.equal(result.openTarget, `/api/v1/creations/presentations/${result.creationId}`);
  assert.equal(result.mimeType, PPTX_MIME);
  assert.match(result.content, /^# Launch plan/);
  assert.deepEqual(Object.keys(result.metadata || {}).sort(), ['byteLength', 'downloadTarget', 'slideCount']);
  assert.equal(JSON.stringify(result).toLowerCase().includes('fake-provider'), false, 'no provider identity in what the product shows');
  assert.equal(JSON.stringify(result).includes('nagex-local-pptx'), false);

  const record = rt.presentationStore.get(result.creationId, 'ten_a', 'usr_a')!;
  assert.equal(record.providerExecutionMetadata.providerId, 'nagex-local-pptx', 'the renderer identity is kept in the stored record (audit surface)');
  const bytes = rt.presentationStore.getBinary(record.binaryStoragePath)!;
  assert.equal(bytes.length, record.byteLength);
  assert.equal(readZip(bytes).some((e) => e.name === 'ppt/slides/slide3.xml'), true, 'title slide + 2 content slides');

  const artifact = rt.artifactStore.get(result.artifactId!, 'ten_a', 'usr_a')!;
  assert.equal(artifact.type, 'PRESENTATION');
  assert.equal(artifact.openTarget, result.openTarget);
  assert.equal(rt.events.some((e) => e.action === 'presentation.created' && e.result === 'SUCCESS'), true);
});

test('D. truthful failures: no model, unusable plan, no renderer, failed render and bad input all fail without creating anything', async () => {
  const none = async (rt: ReturnType<typeof makeRuntime>) => { assert.deepEqual(rt.presentationStore.list('ten_a', 'usr_a'), []); assert.deepEqual(rt.artifactStore.list('ten_a', 'usr_a', 10), []); };

  let rt = makeRuntime({ presentationOutline: async () => { throw new NagexError({ code: 'NO_MODEL_PROVIDER_CONFIGURED', category: 'PROVIDER', message: 'No model provider is configured.', request_id: 'r' }); } });
  let result = await rt.creationRuntime.create({ ...base, prompt: 'x deck' });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.errorCode, 'NO_MODEL_PROVIDER_CONFIGURED');
  await none(rt);

  rt = makeRuntime({ presentationOutline: async () => { throw new NagexError({ code: 'EMPTY_GENERATION', category: 'PROVIDER', message: 'not enough slides', request_id: 'r' }); } });
  result = await rt.creationRuntime.create({ ...base, prompt: 'x deck' });
  assert.equal(result.errorCode, 'EMPTY_GENERATION');
  await none(rt);

  rt = makeRuntime(okAi(), { withProvider: false });
  result = await rt.creationRuntime.create({ ...base, prompt: 'x deck' });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.errorCode, 'NO_CREATION_PROVIDER_AVAILABLE');
  await none(rt);

  rt = makeRuntime(okAi());
  (rt.providerRouter as any).presentationProviders.set('nagex-local-pptx', { providerId: 'nagex-local-pptx', getStatus: () => 'AVAILABLE', getCapabilities: () => ({}), generatePresentation: async () => ({ status: 'FAILED', errorCode: 'RENDER_BROKEN', errorMessage: 'boom', metadata: { providerId: 'x', createdAt: 'now' } }) });
  result = await rt.creationRuntime.create({ ...base, prompt: 'x deck' });
  assert.equal(result.errorCode, 'RENDER_BROKEN');
  await none(rt);
  (rt.providerRouter as any).presentationProviders.set('nagex-local-pptx', { providerId: 'nagex-local-pptx', getStatus: () => 'AVAILABLE', getCapabilities: () => ({}), generatePresentation: async () => ({ status: 'COMPLETED', output: { presentationUrl: 'https://provider.example/deck.pptx', mimeType: PPTX_MIME }, metadata: { providerId: 'x', createdAt: 'now' } }) });
  result = await rt.creationRuntime.create({ ...base, prompt: 'x deck' });
  assert.equal(result.status, 'FAILED', 'a provider URL is not a presentation: without bytes there is no success');
  await none(rt);

  rt = makeRuntime(okAi());
  assert.equal((await rt.creationRuntime.create({ ...base, prompt: '   ' })).errorCode, 'INVALID_PROMPT');
  await none(rt);
});

test('E. source documents: only the caller\'s own documents ground a deck; a foreign or unknown reference is refused', async () => {
  const calls: any[] = [];
  const rt = makeRuntime(okAi(calls));
  const now = new Date().toISOString();
  rt.documentStore.save({ documentId: 'doc_1', tenantId: 'ten_a', ownerId: 'usr_a', title: 'Roadmap notes', summary: 's', content: 'NOTES-ABOUT-OCTOBER', documentKind: 'REPORT', locale: 'en', format: 'MARKDOWN', sourceRefs: [], revisionIndex: 1, createdAt: now, updatedAt: now });
  const art = rt.artifactStore.saveCompleted({ tenantId: 'ten_a', ownerId: 'usr_a', type: 'DOCUMENT', title: 'Roadmap notes', preview: 's', sourceType: 'CAPTURE', sourceId: 'doc_1', openTarget: '/api/v1/creations/documents/doc_1' });
  const ok = await rt.creationRuntime.create({ ...base, prompt: 'Deck from my notes', sourceRefs: [{ type: 'ARTIFACT', id: art.artifactId }] });
  assert.equal(ok.status, 'SUCCESS');
  assert.match(calls[0].sourceContext, /NOTES-ABOUT-OCTOBER/);
  const foreign = await rt.creationRuntime.create({ ...base, ownerId: 'usr_other', tenantId: 'ten_other', prompt: 'Deck', sourceRefs: [{ type: 'ARTIFACT', id: art.artifactId }] });
  assert.equal(foreign.status, 'FAILED');
  assert.equal(foreign.errorCode, 'UNAUTHORIZED_REFERENCE');
  assert.equal(calls.length, 1, 'the model was never asked about a document the caller does not own');
});

// ── routes ──
test('F. routes: create, viewer JSON, download headers and bytes; ownership isolation; malformed ids; error mapping', async () => {
  const rt = makeRuntime(okAi());
  const deps = { creationRuntime: rt.creationRuntime, presentationStore: rt.presentationStore };
  const headersA = authAs('ten_a', 'usr_a');
  const created = await handlePresentationCreationRoutes('POST', '/api/v1/creations/presentations', { prompt: 'Plan the launch', locale: 'en' }, headersA, {}, deps);
  assert.equal(created!.status, 201);
  const id = (created!.data as any).creationId as string;

  const viewer = await handlePresentationCreationRoutes('GET', `/api/v1/creations/presentations/${id}`, null, headersA, {}, deps);
  assert.equal(viewer!.status, 200);
  const json = JSON.stringify(viewer!.data);
  assert.equal((viewer!.data as any).presentation.slides.length, 2);
  assert.equal(/nagex-local-pptx|fake-provider|binaryStoragePath|\.pptx"|providerExecution/i.test(json), false, 'no provider identity or storage path in the viewer JSON');
  assert.equal((viewer!.data as any).presentation.downloadTarget, `/api/v1/creations/presentations/${id}/download`);

  const download = await handlePresentationCreationRoutes('GET', `/api/v1/creations/presentations/${id}/download`, null, headersA, {}, deps);
  assert.equal(download!.status, 200);
  assert.equal(download!.isBinary, true);
  assert.equal((download as any).contentType, PPTX_MIME);
  assert.match(download!.headers!['Content-Disposition'], /^attachment; filename="presentation\.pptx"; filename\*=UTF-8''Launch%20plan\.pptx$/);
  assert.equal(download!.headers!['X-Content-Type-Options'], 'nosniff');
  assert.equal(download!.headers!['Cache-Control'], 'private, no-store');
  assert.equal(readZip((download as any).data).length > 10, true);

  // another owner in the same tenant, another tenant, an unknown id, a malformed id and a traversal attempt all look identical: 404
  for (const headers of [authAs('ten_a', 'usr_b'), authAs('ten_b', 'usr_a')]) {
    for (const suffix of ['', '/download']) {
      const r = await handlePresentationCreationRoutes('GET', `/api/v1/creations/presentations/${id}${suffix}`, null, headers, {}, deps);
      assert.equal(r!.status, 404);
      assert.equal((r!.data as any).error, 'PRESENTATION_NOT_FOUND');
    }
  }
  for (const bad of ['pres_000000000000000000000000', 'nope', '..%2f..%2fetc', 'pres_ZZZZZZZZZZZZZZZZZZZZZZZZ']) {
    assert.equal((await handlePresentationCreationRoutes('GET', `/api/v1/creations/presentations/${bad}`, null, headersA, {}, deps))!.status, 404);
  }
  // unrelated paths and methods are not handled here; an anonymous (un-canonicalized) caller gets nothing from this registrar
  assert.equal(await handlePresentationCreationRoutes('DELETE', `/api/v1/creations/presentations/${id}`, null, headersA, {}, deps), undefined);
  assert.equal(await handlePresentationCreationRoutes('GET', '/api/v1/creations/documents/x', null, headersA, {}, deps), undefined);
  assert.equal(await handlePresentationCreationRoutes('GET', `/api/v1/creations/presentations/${id}`, null, { cookie: 'nagex_session=forged' }, {}, deps), undefined);

  // error mapping
  assert.equal((await handlePresentationCreationRoutes('POST', '/api/v1/creations/presentations', { prompt: ' ' }, headersA, {}, deps))!.status, 400);
  const noModel = makeRuntime({ presentationOutline: async () => { throw new NagexError({ code: 'NO_MODEL_PROVIDER_CONFIGURED', category: 'PROVIDER', message: 'No model provider is configured.', request_id: 'r' }); } });
  const failed = await handlePresentationCreationRoutes('POST', '/api/v1/creations/presentations', { prompt: 'x' }, headersA, {}, { creationRuntime: noModel.creationRuntime, presentationStore: noModel.presentationStore });
  assert.equal(failed!.status, 503);
  assert.deepEqual({ error: (failed!.data as any).error, message: (failed!.data as any).message }, { error: 'NO_MODEL_PROVIDER_CONFIGURED', message: 'No model provider is configured.' });
});

test('F2. download names are header-safe and readable', () => {
  assert.equal(downloadFileName('Q3 Plan'), 'Q3 Plan.pptx');
  assert.equal(downloadFileName('a/b\\c:d*e?"f<g>|h\r\ni'), 'a b c d e f g h i.pptx');
  assert.equal(downloadFileName('   '), 'presentation.pptx');
  assert.equal(downloadFileName('3분기 계획'), '3분기 계획.pptx');
  assert.ok(downloadFileName('x'.repeat(300)).length <= 85);
});

// Found by opening a generated deck in Microsoft PowerPoint 16 and exporting its slides (docs/evidence/pptx-render-20261013): the cover subtitle showed a bullet, and a
// long title wrapped to three lines over its bullets. PowerPoint only applies <a:normAutofit/> when text is edited, so the writer chooses the size itself.
test('G. rendering: no bullet on the cover subtitle; long titles and bullets get a smaller size that fits; short text keeps the master size', () => {
  const part = (zip: Buffer, name: string): string => readZip(zip).find((entry) => entry.name === name)!.data.toString('utf8');
  const short = buildPptx({ title: 'Quarterly review', subtitle: 'Strategy', locale: 'en', slides: [{ title: 'Summary', bullets: ['One', 'Two', 'Three'] }] });
  assert.equal(/ sz="/.test(part(short, 'ppt/slides/slide1.xml')), false, 'a short cover keeps the master sizes');
  assert.equal(/ sz="/.test(part(short, 'ppt/slides/slide2.xml')), false, 'a short slide keeps the master sizes');
  assert.match(part(short, 'ppt/slideLayouts/slideLayout1.xml'), /<a:lvl1pPr marL="0" indent="0" algn="l"><a:buNone\/>/, 'the subtitle placeholder of the cover layout has no bullet');

  const longKo = '긴 제목 테스트: 이 제목은 두 줄 이상으로 길어질 수 있도록 일부러 아주 길게 작성했습니다 (long title wrapping check)';
  const longBullet = '아주 긴 글머리표 문장도 슬라이드 안에서 줄바꿈되어야 하며 영역 밖으로 넘치면 안 됩니다. A very long bullet sentence must wrap inside the slide and must not overflow outside the content area.';
  const long = buildPptx({ title: 'Cover', locale: 'ko', slides: [{ title: longKo, bullets: [longBullet, '짧은 항목', 'Special chars: & < >'] }, { title: 'Dense', bullets: Array.from({ length: 12 }, () => longBullet) }] });
  const titleSize = Number(/<p:ph type="title"\/>[\s\S]*?<a:rPr[^>]* sz="(\d+)"/.exec(part(long, 'ppt/slides/slide2.xml'))![1]);
  assert.ok(titleSize < 4000 && titleSize >= 2000, `a long title is shrunk (sz ${titleSize})`);
  const bodySize = Number(/<p:ph idx="1"\/>[\s\S]*?<a:rPr[^>]* sz="(\d+)"/.exec(part(long, 'ppt/slides/slide3.xml'))![1]);
  assert.ok(bodySize < 2400 && bodySize >= 1400, `a dense slide is shrunk (sz ${bodySize})`);
  for (const n of [1, 2, 3]) assertWellFormed(part(long, `ppt/slides/slide${n}.xml`), `slide${n}`);
  // an extreme input is bounded, never infinite or below the floor
  const extreme = buildPptx({ title: 'x'.repeat(5000), locale: 'en', slides: [{ title: 'y'.repeat(5000), bullets: ['z'.repeat(20000)] }] });
  assert.match(part(extreme, 'ppt/slides/slide2.xml'), / sz="2000"/);
  assert.match(part(extreme, 'ppt/slides/slide2.xml'), / sz="1400"/);
});
