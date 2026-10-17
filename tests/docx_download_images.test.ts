// A picture in a document is the PERSON'S OWN stored image or nothing: GET /api/v1/creations/documents/:id/download resolves ![alt](/api/v1/creations/images/<id>) through the owner-checked image
// store. Someone else's image id, an unknown id and a malformed address all show the same "unavailable" line - the file is still built, and nothing about the other image leaks.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { handleAsyncApiRequest } from '../src/server_web.js';
import { DocumentStore } from '../src/creation/document.store.js';
import { ImageStore } from '../src/creation/image.store.js';
import { readZip } from '../src/creation/pptx/zip-writer.js';
import { authAs } from './_s1_session_auth.js';
import { makeBarsPng } from './_png.js';

describe('pictures in a downloaded document', () => {
  const documents = new DocumentStore();
  const images = new ImageStore();
  const png = makeBarsPng(600, 300, [0.5, 0.9, 0.7]);

  const seedImage = (tenantId: string, ownerId: string, hex: string, bytes: Buffer): string => {
    const imageId = `img_${hex}`;
    const now = new Date().toISOString();
    images.save({
      imageId, tenantId, ownerId, title: '막대그래프', prompt: '막대그래프', aspectRatio: '2:1', mimeType: 'image/png', width: 600, height: 300,
      binaryStoragePath: images.saveBinary(imageId, bytes, 'image/png'), revisionIndex: 1, sourceRefs: [],
      providerExecutionMetadata: { providerId: 'test-fixture', engineOrModel: 'fixture', createdAt: now } as never, createdAt: now, updatedAt: now,
    });
    return imageId;
  };
  const seedDocument = (tenantId: string, ownerId: string, hex: string, content: string): string => {
    const documentId = `doc_${hex}`;
    const now = new Date().toISOString();
    documents.save({ documentId, tenantId, ownerId, title: '그림이 있는 보고서', summary: '요약', content, documentKind: 'REPORT', locale: 'ko', format: 'MARKDOWN', sourceRefs: [], createdAt: now, updatedAt: now } as never);
    return documentId;
  };
  const download = async (documentId: string, who: ReturnType<typeof authAs>) => {
    const res = await handleAsyncApiRequest('GET', `/api/v1/creations/documents/${documentId}/download`, null, who);
    assert.equal(res.status, 200);
    const entries = readZip(Buffer.from((res as any).data));
    return { entries, document: entries.find((e) => e.name === 'word/document.xml')!.data.toString('utf8') };
  };

  it('the owner\'s image is embedded; another person\'s image id, an unknown id and a malformed address are each shown as "unavailable"', async () => {
    const owner = authAs('ten_dimg', 'usr_dimg_a');
    const other = authAs('ten_dimg', 'usr_dimg_b');
    const mine = seedImage('ten_dimg', 'usr_dimg_a', 'a1b2c3d4e5f60718293a4b5c', png);
    const theirs = seedImage('ten_dimg', 'usr_dimg_b', 'b1b2c3d4e5f60718293a4b5c', makeBarsPng(100, 100, [1]));
    const content = `# 그림이 있는 보고서\n\n![내 그림](/api/v1/creations/images/${mine} "그림 1. 내 그림")\n\n![남의 그림](/api/v1/creations/images/${theirs})\n\n![없는 그림](/api/v1/creations/images/img_000000000000000000000000)\n\n![주소가 이상함](/api/v1/creations/images/../../etc/passwd)`;
    const id = seedDocument('ten_dimg', 'usr_dimg_a', 'd1d2d3d4d5d6d7d8d9dadbdc', content);

    const { entries, document } = await download(id, owner);
    const media = entries.filter((e) => e.name.startsWith('word/media/'));
    assert.equal(media.length, 1, 'exactly one picture: the owner\'s');
    assert.equal(media[0].data.equals(png), true);
    assert.match(document, /descr="내 그림"/);
    assert.match(document, /그림 1\. 내 그림/);
    for (const alt of ['남의 그림', '없는 그림', '주소가 이상함']) assert.match(document, new RegExp(`그림을 표시할 수 없습니다: ${alt}`), alt);
    // the other person's image is not in the file in any form
    assert.equal(entries.some((e) => e.data.equals(makeBarsPng(100, 100, [1]))), false);

    // the SAME address in another person's own document does not reach the first person's image
    const otherDoc = seedDocument('ten_dimg', 'usr_dimg_b', 'e1e2e3e4e5e6e7e8e9eaebec', `# 남의 보고서\n\n![훔친 그림](/api/v1/creations/images/${mine})`);
    const stolen = await download(otherDoc, other);
    assert.equal(stolen.entries.some((e) => e.name.startsWith('word/media/')), false);
    assert.match(stolen.document, /그림을 표시할 수 없습니다: 훔친 그림/);
  });

  it('an image of another tenant is not reachable either, and a document without pictures is unchanged', async () => {
    const tenantA = authAs('ten_dimg_t1', 'usr_dimg_t1');
    const tenantB = authAs('ten_dimg_t2', 'usr_dimg_t2');
    const foreign = seedImage('ten_dimg_t1', 'usr_dimg_t1', 'c1c2c3c4c5c6c7c8c9cacbcc', png);
    const doc = seedDocument('ten_dimg_t2', 'usr_dimg_t2', 'f1f2f3f4f5f6f7f8f9fafbfc', `# 보고서\n\n![남의 테넌트](/api/v1/creations/images/${foreign})`);
    const res = await download(doc, tenantB);
    assert.equal(res.entries.some((e) => e.name.startsWith('word/media/')), false);
    assert.match(res.document, /그림을 표시할 수 없습니다/);
    const plain = seedDocument('ten_dimg_t1', 'usr_dimg_t1', '0102030405060708090a0b0c', '# 글만\n\n본문');
    const plainFile = await download(plain, tenantA);
    assert.equal(plainFile.entries.some((e) => e.name.startsWith('word/media/')), false);
    assert.match(plainFile.document, /본문/);
  });
});
