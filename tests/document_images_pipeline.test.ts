// Outcome Quality (C1/C3) - a document that carries the person's own picture, from the request to the .docx:
//   * the writer is OFFERED the person's pictures by reference only (never a store id or an address) and may place one on a line of its own;
//   * NAgex binds a placed reference to that picture's canonical address and REMOVES every other picture-like thing (an address the model made up, an external URL a viewer might fetch, a picture
//     inside a sentence), so the stored document holds the person's own picture or no picture;
//   * the .docx download resolves the canonical address through the owner-checked store and embeds the picture.
// The model is a deterministic stand-in; the stores, executor and writer are the real code.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { bindDocumentImages } from '../src/creation/document-images.js';
import { buildDocx } from '../src/creation/docx/docx-writer.js';
import { DocumentExecutor } from '../src/creation/executors/document-executor.js';
import { DocumentStore } from '../src/creation/document.store.js';
import { ImageStore } from '../src/creation/image.store.js';
import { ArtifactStore } from '../src/artifacts/artifact.store.js';
import { readZip } from '../src/creation/pptx/zip-writer.js';
import { makeBarsPng } from './_png.js';

const tempDir = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), name));
const T = 'ten_dimgp'; const U = 'usr_dimgp';
const OFFERED = [{ ref: 'image_1', title: '막대그래프', address: '/api/v1/creations/images/img_aaaaaaaaaaaaaaaaaaaaaaaa' }];

describe('binding the pictures of a written document', () => {
  it('an offered reference becomes its canonical address, with alt text and caption; the text around it is untouched', () => {
    const out = bindDocumentImages('# 제목\n\n본문입니다.\n\n![분기별 변화](image_1 "그림 1. 분기별 변화")\n\n마무리.', OFFERED);
    assert.equal(out.markdown, '# 제목\n\n본문입니다.\n\n![분기별 변화](/api/v1/creations/images/img_aaaaaaaaaaaaaaaaaaaaaaaa "그림 1. 분기별 변화")\n\n마무리.');
    assert.deepEqual([out.placed, out.removed], [1, 0]);
  });
  it('anything that is not the person\'s offered picture is REMOVED: an unknown reference, an external URL, a made-up address, a data URI', () => {
    const md = ['![a](image_9)', '![b](https://tracker.example/pixel.png)', '![c](/api/v1/creations/images/img_bbbbbbbbbbbbbbbbbbbbbbbb)', '![d](data:image/png;base64,AAAA)', '유지되는 줄'].join('\n');
    const out = bindDocumentImages(md, OFFERED);
    assert.equal(out.markdown, '유지되는 줄');
    assert.deepEqual([out.placed, out.removed], [0, 4]);
  });
  it('a picture inside a sentence cannot be placed: only its description stays', () => {
    const out = bindDocumentImages('앞 ![그래프 설명](image_1) 뒤 ![다른](https://x.example/y.png) 끝', OFFERED);
    assert.equal(out.markdown, '앞 그래프 설명 뒤 다른 끝');
    assert.deepEqual([out.placed, out.removed], [0, 2]);
  });
  it('alt text falls back to the picture\'s title; brackets in alt text cannot break the syntax; CRLF is handled; nothing offered means nothing placed', () => {
    assert.equal(bindDocumentImages('![](image_1)', OFFERED).markdown, `![막대그래프](${OFFERED[0].address})`);
    assert.equal(bindDocumentImages('![a[b]c](image_1)\r\n다음', OFFERED).markdown, `![abc](${OFFERED[0].address})\n다음`);
    assert.equal(bindDocumentImages('![a](image_1)\n본문', []).markdown, '본문');
    assert.equal(bindDocumentImages('', OFFERED).markdown, '');
  });
});

function rig(write: (input: any) => string, opts: { withImageStore?: boolean } = {}) {
  const seen: any[] = [];
  const aiService: any = { documentSynthesis: async (input: any) => { seen.push(input); return { data: { title: '보고서', summary: '요약', content: write(input) }, provider: 'stand-in', model: 'm', latencyMs: 1, requestId: input.requestId }; } };
  const documentStore = new DocumentStore({ dir: tempDir('dip-doc-') });
  const artifactStore = new ArtifactStore({ dir: tempDir('dip-art-') });
  const imageStore = new ImageStore({ metaDir: tempDir('dip-img-meta-'), bytesDir: tempDir('dip-img-bytes-') });
  const executor = new DocumentExecutor({ aiService, documentStore, artifactStore, ...(opts.withImageStore === false ? {} : { imageStore }) });
  return { seen, executor, documentStore, artifactStore, imageStore };
}
const png = makeBarsPng(900, 450, [0.5, 0.9, 0.7]);
function seedImage(rt: ReturnType<typeof rig>, owner: string, bytes: Buffer, hex: string, mime = 'image/png') {
  const imageId = `img_${hex}`;
  const now = new Date().toISOString();
  rt.imageStore.save({ imageId, tenantId: T, ownerId: owner, title: '막대그래프', prompt: 'p', aspectRatio: '2:1', mimeType: mime, width: 900, height: 450, binaryStoragePath: rt.imageStore.saveBinary(imageId, bytes, mime), revisionIndex: 1, sourceRefs: [], providerExecutionMetadata: { providerId: 'fixture', createdAt: now } as never, createdAt: now, updatedAt: now });
  return { imageId, artifact: rt.artifactStore.saveCompleted({ tenantId: T, ownerId: owner, type: 'IMAGE', title: '막대그래프', preview: 'p', sourceType: 'CAPTURE', sourceId: imageId, openTarget: `/api/v1/creations/images/${imageId}` }) };
}
const request = { creationKind: 'DOCUMENT' as const, tenantId: T, ownerId: U, requestId: 'req_dimgp', prompt: '그래프가 들어간 보고서를 써줘', options: { locale: 'ko' as const } };

describe('the document executor', () => {
  it('offers the person\'s own picture by reference, stores the canonical address, reports what was placed - and the .docx made from it embeds the picture', async () => {
    const rt = rig(() => '# 보고서\n\n본문\n\n![막대 그래프](image_1 "그림 1")\n\n![외부](https://tracker.example/p.png)\n\n끝');
    const { imageId, artifact } = seedImage(rt, U, png, 'a1b2c3d4e5f60718293a4b5c');
    const result = await rt.executor.execute({ ...request, sourceRefs: [{ type: 'ARTIFACT', id: artifact.artifactId }] });
    assert.equal(result.status, 'SUCCESS');
    assert.deepEqual(rt.seen[0].images, [{ ref: 'image_1', title: '막대그래프' }]);
    assert.equal(JSON.stringify(rt.seen[0].images).includes('img_'), false, 'the writer never sees a store id');
    assert.equal(result.content.includes(`![막대 그래프](/api/v1/creations/images/${imageId} "그림 1")`), true);
    assert.equal(result.content.includes('tracker.example'), false, 'an external picture is gone');
    assert.deepEqual((result.metadata as any).pictures, { offered: 1, placed: 1, removed: 1 });
    const stored = rt.documentStore.get(result.creationId, T, U)!;
    assert.equal(stored.content, result.content);

    const docx = buildDocx({ title: stored.title, markdown: stored.content, locale: 'ko', resolveImage: (ref) => {
      const match = /^\/api\/v1\/creations\/images\/(img_[0-9a-f]{24})$/.exec(ref);
      const record = match ? rt.imageStore.get(match[1], T, U) : null;
      const bytes = record ? rt.imageStore.getBinary(record.binaryStoragePath) : null;
      return bytes ? { bytes } : null;
    } });
    const media = readZip(docx).filter((e) => /^word\/media\/image\d+\.png$/.test(e.name));
    assert.equal(media.length, 1);
    assert.equal(media[0].data.equals(png), true);
  });

  it('without a picture of the person\'s, nothing is offered and any picture the writer invents is removed - the old result keys are unchanged when nothing happened', async () => {
    const rt = rig(() => '# 보고서\n\n본문\n\n![있지도 않은](image_1)');
    const result = await rt.executor.execute(request);
    assert.equal('images' in rt.seen[0], false);
    assert.equal(result.content.includes('!['), false);
    assert.deepEqual((result.metadata as any).pictures, { offered: 0, placed: 0, removed: 1 });
    const plain = await rig(() => '# 보고서\n\n본문').executor.execute(request);
    assert.deepEqual(Object.keys(plain.metadata!).sort(), ['documentKind', 'latencyMs', 'model', 'provider']);
  });

  it('another person\'s picture, a picture that is not a PNG/JPEG and a missing image store offer nothing', async () => {
    const rt = rig(() => '본문\n\n![x](image_1)');
    const theirs = seedImage(rt, 'usr_other', png, 'c1c2c3c4c5c6c7c8c9cacbcc');
    const gif = seedImage(rt, U, Buffer.from('GIF89a-this-is-not-a-png-or-a-jpeg'), 'd1d2d3d4d5d6d7d8d9dadbdc', 'image/gif');
    const result = await rt.executor.execute({ ...request, sourceRefs: [{ type: 'ARTIFACT', id: theirs.artifact.artifactId }, { type: 'ARTIFACT', id: gif.artifact.artifactId }] });
    assert.equal(result.status, 'SUCCESS');
    assert.equal('images' in rt.seen[0], false, 'nothing usable was offered');
    assert.equal(result.content.includes('!['), false);
    const bare = rig(() => '본문\n\n![x](image_1)', { withImageStore: false });
    const mine = seedImage(rig(() => ''), U, png, 'e1e2e3e4e5e6e7e8e9eaebec');
    const none = await bare.executor.execute({ ...request, sourceRefs: [{ type: 'ARTIFACT', id: mine.artifact.artifactId }] });
    assert.equal(none.status, 'SUCCESS');
    assert.equal('images' in bare.seen[0], false);
  });
});
