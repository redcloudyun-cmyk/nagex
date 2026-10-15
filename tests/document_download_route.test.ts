// GET /api/v1/creations/documents/:id/download - the person's own document as a real .docx; nobody else's. POST with a PDF/HTML format is refused instead of silently producing Markdown.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { handleAsyncApiRequest } from '../src/server_web.js';
import { DocumentStore } from '../src/creation/document.store.js';
import { authAs } from './_s1_session_auth.js';

describe('document download route', () => {
  const store = new DocumentStore();
  const seed = (tenantId: string, ownerId: string, suffix: string) => {
    const documentId = `doc_${suffix.padStart(24, '0')}`;
    const now = new Date().toISOString();
    store.save({ documentId, tenantId, ownerId, title: '3쪽 보고서', summary: '요약', content: '# 3쪽 보고서\n\n## 1. 서론\n본문입니다.\n\n- 항목', documentKind: 'REPORT', locale: 'ko', format: 'MARKDOWN', sourceRefs: [], revisionIndex: 1, createdAt: now, updatedAt: now } as any);
    return documentId;
  };

  it('the owner gets a .docx; another user, another tenant, an anonymous caller and a malformed id get nothing', async () => {
    const a = authAs('ten_dl_a', 'usr_dl_a');
    const b = authAs('ten_dl_b', 'usr_dl_b');
    const sameTenantOther = authAs('ten_dl_a', 'usr_dl_a2');
    const id = seed('ten_dl_a', 'usr_dl_a', 'abc0123456789def01234');
    const ok = await handleAsyncApiRequest('GET', `/api/v1/creations/documents/${id}/download`, null, a);
    assert.equal(ok.status, 200);
    assert.equal((ok as any).isBinary, true);
    assert.equal((ok as any).contentType, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    assert.equal(Buffer.from((ok as any).data).subarray(0, 2).toString(), 'PK');
    assert.match(String((ok as any).headers['Content-Disposition']), /^attachment; filename="document\.docx"; filename\*=UTF-8''/);
    assert.match(String((ok as any).headers['Cache-Control']), /no-store/);
    for (const [who, headers] of [['other tenant', b], ['same tenant, other owner', sameTenantOther]] as const) {
      const denied = await handleAsyncApiRequest('GET', `/api/v1/creations/documents/${id}/download`, null, headers);
      assert.equal(denied.status, 404, who);
      assert.equal((denied as any).isBinary, undefined, who);
    }
    assert.equal((await handleAsyncApiRequest('GET', `/api/v1/creations/documents/${id}/download`, null, {})).status, 401);
    assert.equal((await handleAsyncApiRequest('GET', '/api/v1/creations/documents/not-an-id/download', null, a)).status, 404);
    assert.equal((await handleAsyncApiRequest('GET', `/api/v1/creations/documents/${id}`, null, a)).status, 200, 'the JSON read of the document is unchanged');
  });

  it('a PDF or HTML document is refused with a clear reason; Markdown and DOCX are the honest formats', async () => {
    const a = authAs('ten_dl_fmt', 'usr_dl_fmt');
    for (const format of ['PDF', 'HTML', 'ODT']) {
      const res = await handleAsyncApiRequest('POST', '/api/v1/creations/documents', { prompt: '보고서를 써줘', format }, a);
      assert.equal(res.status, 400, format);
      assert.equal((res.data as any).error, 'FORMAT_UNSUPPORTED');
      assert.match((res.data as any).message, /Markdown/);
    }
  });
});
