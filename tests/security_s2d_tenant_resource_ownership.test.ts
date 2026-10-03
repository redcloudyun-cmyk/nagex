// Security Gate S2D — tenant resource ownership (execution history, uploaded objects).
//
// Before S2D any signed-in caller could (1) list every tenant's execution history and (2) complete an upload against ANY object key —
// which bound another tenant's object to its own capture, let it overwrite that object (`data`) and, by deleting its own capture,
// delete it. These tests drive the real route/service entry points and count every storage read, write, delete and signed-URL
// issue, to prove: the history is scoped to the caller's tenant AND principal; an upload can only be completed by the caller that
// initiated it, on the object key the SERVER derived for it; ownership is decided BEFORE any storage access; a record that points
// at an object it does not own (legacy data) never reaches storage; and the normal upload/delete round trip still works.
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleApiRequest, handleAsyncApiRequest, withTestServer } from '../src/server_web.js';
import * as server from '../src/server_web.js';
import { authAs } from './_s1_session_auth.js';
import { canonicalObjectKeyPrefix, isCanonicalObjectKeyFor } from '../src/workspace/vault-security.js';
import { CaptureStore } from '../src/workspace/capture.store.js';
import { executionHistory } from '../src/http/routes/governance.routes.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EXECUTIONS = '/api/v1/executions';
const INIT = '/api/v1/workspace/uploads/init';
const COMPLETE = '/api/v1/workspace/uploads/complete';
const A = { tenantId: 'ten_s2d_a', principalId: 'usr_s2d_a' };
const B = { tenantId: 'ten_s2d_b', principalId: 'usr_s2d_b' };
type Who = typeof A;
const as = (w: Who) => authAs(w.tenantId, w.principalId);
const code = (res: { data: unknown }): string | undefined => (res.data as any)?.error?.code ?? (res.data as any)?.error;

// ── storage tripwires on the shared application storage provider ──
const storage = server.storageProvider as any;
const ops = { get: 0, put: 0, del: 0, url: 0, head: 0 };
const originals: Record<string, any> = {};
const resetOps = (): void => { ops.get = ops.put = ops.del = ops.url = ops.head = 0; };
const total = (): number => ops.get + ops.put + ops.del + ops.url + ops.head;
beforeEach(() => {
  resetOps();
  for (const [name, key] of [['getObject', 'get'], ['putObject', 'put'], ['deleteObject', 'del'], ['getSignedUrl', 'url'], ['getSignedUploadUrl', 'url'], ['headObject', 'head']] as const) {
    if (typeof storage[name] !== 'function') continue;
    originals[name] = storage[name];
    storage[name] = (...a: unknown[]) => { ops[key]++; return originals[name].apply(storage, a); };
  }
});
afterEach(() => { for (const name of Object.keys(originals)) storage[name] = originals[name]; });

const call = (method: string, url: string, body: Record<string, unknown> | null, who: Who | null, extra: Record<string, string> = {}) =>
  handleAsyncApiRequest(method, url, body, who ? as(who) : extra);
const readObject = async (key: string): Promise<string | null> => { const o = await originals.getObject.call(storage, key); return o ? o.data.toString('utf8') : null; };

interface Init { captureId: string; objectKey: string }
async function initUpload(who: Who, filename = 'doc.txt'): Promise<Init> {
  const res = await call('POST', INIT, { filename, mimeType: 'text/plain', sizeBytes: 64 }, who);
  assert.equal(res.status, 201);
  return res.data as Init;
}
async function completeUpload(who: Who, init: Init, content: string, extra: Record<string, unknown> = {}) {
  return call('POST', COMPLETE, { captureId: init.captureId, objectKey: init.objectKey, mimeType: 'text/plain', originalFilename: 'doc.txt', sizeBytes: content.length, data: Array.from(Buffer.from(content)), ...extra }, who);
}
const store = (): CaptureStore => (server.quickCaptureService as any).store as CaptureStore;
const capturesOf = (who: Who) => store().listCaptures(who.tenantId, who.principalId);

describe('S2D — execution history is scoped to the caller\'s tenant AND principal', () => {
  const post = (who: Who, objective: string) => handleApiRequest('POST', EXECUTIONS, { objective }, as(who));
  const list = (who: Who): Array<Record<string, any>> => ((handleApiRequest('GET', EXECUTIONS, null, as(who)).data as any).executions as Array<Record<string, any>>);

  it('a caller lists only its own executions; another tenant, another principal in the same tenant, and the legacy demo seed are never listed', () => {
    const SHARED_1 = { tenantId: 'ten_s2d_shared', principalId: 'usr_s2d_s1' };
    const SHARED_2 = { tenantId: 'ten_s2d_shared', principalId: 'usr_s2d_s2' };
    const SAME_PRINCIPAL_OTHER_TENANT = { tenantId: 'ten_s2d_elsewhere', principalId: A.principalId };
    assert.equal(post(A, 'S2D-SECRET-OBJECTIVE-A').status, 201);
    assert.equal(post(B, 'S2D-SECRET-OBJECTIVE-B').status, 201);
    assert.equal(post(SHARED_1, 'S2D-SECRET-OBJECTIVE-S1').status, 201);
    const a = JSON.stringify(list(A)), b = JSON.stringify(list(B));
    assert.equal(a.includes('S2D-SECRET-OBJECTIVE-A'), true);
    assert.equal(a.includes('S2D-SECRET-OBJECTIVE-B') || a.includes('S2D-SECRET-OBJECTIVE-S1'), false, 'tenant A never sees another tenant\'s history');
    assert.equal(b.includes('S2D-SECRET-OBJECTIVE-B') && !b.includes('S2D-SECRET-OBJECTIVE-A'), true);
    assert.deepEqual(list(SHARED_2), [], 'another principal in the SAME tenant sees nothing of it');
    assert.deepEqual(list(SAME_PRINCIPAL_OTHER_TENANT), [], 'the same principal id in another tenant sees nothing');
    assert.equal(list(SHARED_1).length, 1);
    // the shared in-memory array does hold everyone's records: the filter is the boundary
    assert.equal(executionHistory.some((e) => e.tenant_id === A.tenantId) && executionHistory.some((e) => e.tenant_id === B.tenantId), true);
    for (const who of [A, B, SHARED_1, SHARED_2, { tenantId: 'ten_production_01', principalId: 'usr_admin_001' }]) {
      const rows = list(who);
      assert.equal(rows.every((r) => r.tenant_id === who.tenantId && r.principal_id === who.principalId), true);
      assert.equal(rows.some((r) => r.execution_id === 'exec_meeting_prep_001'), false, 'the legacy demo seed belongs to nobody');
    }
  });

  it('the list response keeps its shape (total matches), POST still creates and charges, by-id read/mutate routes still do not exist', () => {
    const created = post(A, 'S2D-SHAPE');
    assert.equal(created.status, 201);
    assert.equal((created.data as any).principal_id, A.principalId);
    assert.equal((created.data as any).tenant_id, A.tenantId);
    const res = handleApiRequest('GET', EXECUTIONS, null, as(A));
    assert.equal(res.status, 200);
    assert.equal((res.data as any).total, (res.data as any).executions.length);
    const usage = handleApiRequest('GET', '/api/v1/billing/usage', null, as(A));
    assert.ok((usage.data as any).used_credits > 0);
    for (const method of ['GET', 'PATCH', 'DELETE']) assert.equal(handleApiRequest(method, `${EXECUTIONS}/exec_x`, method === 'PATCH' ? {} : null, as(A)).status, 404);
  });

  it('S1: anonymous and header-forged callers cannot list executions', () => {
    assert.equal(handleApiRequest('GET', EXECUTIONS, null, {}).status, 401);
    assert.equal(handleApiRequest('GET', EXECUTIONS, null, { 'x-principal-id': A.principalId, 'x-nagex-tenant': A.tenantId }).status, 401);
  });
});

describe('S2D — an upload is completed only by its initiator, on the key the server derived', () => {
  it('positive control: init → complete round trip, the object lands under the caller\'s own prefix, and a second complete is refused', async () => {
    const init = await initUpload(A);
    assert.equal(init.objectKey.startsWith(canonicalObjectKeyPrefix(A.tenantId, A.principalId)), true);
    assert.equal(isCanonicalObjectKeyFor(init.objectKey, A.tenantId, A.principalId), true);
    assert.equal(init.objectKey.includes(init.captureId), true, 'the record id is the id the key was derived from');
    resetOps();
    const done = await completeUpload(A, init, 'S2D-OBJECT-A-v1');
    assert.equal(done.status, 200);
    assert.equal((done.data as any).metadata.objectKey, init.objectKey);
    assert.equal(await readObject(init.objectKey), 'S2D-OBJECT-A-v1');
    // the key is optional: the server already knows it
    const init2 = await initUpload(A, 'second.txt');
    const done2 = await call('POST', COMPLETE, { captureId: init2.captureId, mimeType: 'text/plain', originalFilename: 'second.txt', data: Array.from(Buffer.from('S2D-OBJECT-A-v2')) }, A);
    assert.equal(done2.status, 200);
    assert.equal(await readObject(init2.objectKey), 'S2D-OBJECT-A-v2');
    // replay: completing the same upload again never rewrites the object
    resetOps();
    const replay = await completeUpload(A, init, 'S2D-REPLAY-OVERWRITE');
    assert.equal(replay.status, 409);
    assert.equal(code(replay), 'UPLOAD_NOT_PENDING');
    assert.equal(total(), 0, 'the replay touched no storage');
    assert.equal(await readObject(init.objectKey), 'S2D-OBJECT-A-v1');
  });

  it('the original attack — another tenant\'s object key with a fabricated capture id — is refused before storage and creates no capture', async () => {
    const init = await initUpload(A);
    await completeUpload(A, init, 'S2D-SECRET-OF-A');
    const bBefore = capturesOf(B).length;
    resetOps();
    for (const extra of [{}, { data: Array.from(Buffer.from('S2D-OVERWRITE-BY-B')) }]) {
      const res = await call('POST', COMPLETE, { captureId: 'cap_b_fabricated_1', objectKey: init.objectKey, mimeType: 'text/plain', originalFilename: 'b.txt', ...extra }, B);
      assert.equal(res.status, 404);
      assert.equal(code(res), 'UPLOAD_NOT_FOUND');
    }
    // no captureId at all
    assert.equal((await call('POST', COMPLETE, { objectKey: init.objectKey, mimeType: 'text/plain', originalFilename: 'b.txt', data: [1, 2, 3] }, B)).status, 404);
    assert.equal(total(), 0, 'OWNERSHIP BEFORE STORAGE: not one storage read, write, delete or signed-URL issue');
    assert.equal(capturesOf(B).length, bBefore, 'no capture was created for the attacker');
    assert.equal(await readObject(init.objectKey), 'S2D-SECRET-OF-A', 'the victim\'s object is unchanged');
  });

  it('another tenant\'s REAL capture id is indistinguishable from an unknown one (404) and nothing is touched', async () => {
    const init = await initUpload(A);
    resetOps();
    const res = await completeUpload(B, init, 'S2D-STEAL');            // B presents A's captureId AND A's key
    assert.equal(res.status, 404);
    assert.equal(code(res), 'UPLOAD_NOT_FOUND');
    assert.equal(total(), 0);
    // A's pending upload is still pending and still completable by A
    const done = await completeUpload(A, init, 'S2D-A-LATER');
    assert.equal(done.status, 200);
  });

  it('a caller with its OWN pending upload cannot point it at another object: a different key is refused, no storage access', async () => {
    const victim = await initUpload(A);
    await completeUpload(A, victim, 'S2D-SECRET-OF-A');
    const own = await initUpload(B);
    resetOps();
    const variants: Array<[string, string]> = [
      ["the victim's exact key", victim.objectKey],
      ['a storage-folded spelling of the victim key', victim.objectKey.replace(/\//g, '_')],
      ['a path-traversal key', `${own.objectKey}/../../../../${victim.objectKey}`],
      ['the victim prefix with B\'s capture id', victim.objectKey.replace(/captures\/[^/]+\//, `captures/${own.captureId}/`)],
      ['an absolute path', '/etc/passwd'],
      ['another tenant\'s prefix', `tenant/${A.tenantId}/principal/${A.principalId}/captures/${own.captureId}/x.txt`],
      ['an empty-segment key', 'tenant//principal//captures//'],
    ];
    for (const [label, key] of variants) {
      for (const extra of [{}, { data: Array.from(Buffer.from('S2D-OVERWRITE-BY-B')) }]) {
        const res = await call('POST', COMPLETE, { captureId: own.captureId, objectKey: key, mimeType: 'text/plain', originalFilename: 'b.txt', ...extra }, B);
        assert.equal(res.status, 403, label);
        assert.equal(code(res), 'UPLOAD_OBJECT_KEY_MISMATCH', label);
        const body = JSON.stringify(res.data);
        assert.equal(body.includes(A.tenantId) || body.includes(A.principalId) || body.includes(victim.captureId), false, `${label}: the refusal does not echo identifiers`);
      }
    }
    assert.equal(total(), 0, 'every variant was refused before any storage access');
    assert.equal(await readObject(victim.objectKey), 'S2D-SECRET-OF-A');
    const ownRecord = capturesOf(B).find((c) => c.captureId === own.captureId)!;
    assert.equal(ownRecord.status, 'UPLOADING');
    assert.equal(ownRecord.metadata.objectKey, own.objectKey, 'B\'s capture still points at B\'s own object');
  });

  it('a delete can only ever remove the capture owner\'s own object', async () => {
    const victim = await initUpload(A);
    await completeUpload(A, victim, 'S2D-SECRET-OF-A');
    const own = await initUpload(B);
    await completeUpload(B, own, 'S2D-OWN-OF-B');
    resetOps();
    assert.equal((await call('DELETE', `/api/v1/workspace/items/${own.captureId}`, null, B)).status, 200);
    assert.equal(ops.del, 1, 'exactly one delete: B\'s own object');
    assert.equal(await readObject(own.objectKey), null);
    assert.equal(await readObject(victim.objectKey), 'S2D-SECRET-OF-A', 'A\'s object survived B\'s delete');
    // and B cannot delete A's capture at all
    resetOps();
    const foreignDelete = await call('DELETE', `/api/v1/workspace/items/${victim.captureId}`, null, B);
    assert.equal((foreignDelete.data as any).success, false, 'the delete reports that nothing was deleted');
    assert.equal(total(), 0);
    assert.equal(capturesOf(A).some((c) => c.captureId === victim.captureId), true, "A's capture record is still there");
    assert.equal(await readObject(victim.objectKey), 'S2D-SECRET-OF-A');
  });

  it('a record from BEFORE S2D that points at someone else\'s object never reaches storage: no signed URL, no read, no delete', async () => {
    const victim = await initUpload(A);
    await completeUpload(A, victim, 'S2D-SECRET-OF-A');
    // legacy poisoned record: owned by B, pointing at A's object (what the old complete route could create)
    const poisoned = store().createCapture({ ownerId: B.principalId, tenantId: B.tenantId, type: 'FILE', content: victim.objectKey, source: 'WEB', metadata: { originalName: 'x.txt', mimeType: 'text/plain', objectKey: victim.objectKey, sizeBytes: 5 }, vaultPath: `vault/${victim.objectKey}` });
    resetOps();
    assert.equal((await call('GET', `/api/v1/workspace/items/${poisoned.captureId}/download`, null, B)).status, 404);
    assert.equal((await call('GET', `/api/v1/workspace/items/${poisoned.captureId}/preview`, null, B)).status, 404);
    await call('POST', `/api/v1/workspace/items/${poisoned.captureId}/retry`, {}, B);
    assert.equal(ops.get + ops.url + ops.put + ops.del, 0, 'no read, signed URL, write or delete for a key the record\'s owner does not own');
    assert.equal((await call('DELETE', `/api/v1/workspace/items/${poisoned.captureId}`, null, B)).status, 200);
    assert.equal(ops.del, 0, 'deleting the poisoned record did not delete the other tenant\'s object');
    assert.equal(await readObject(victim.objectKey), 'S2D-SECRET-OF-A');
    assert.equal(capturesOf(B).some((c) => c.captureId === poisoned.captureId), false, 'the poisoned record itself was removed');
  });

  it('server-derived uploads (init, direct upload) always land under the caller\'s own prefix', async () => {
    const direct = await call('POST', '/api/v1/workspace/upload', { filename: '../../evil/../x.txt', mimeType: 'text/plain', content: 'S2D-DIRECT' }, B);
    assert.equal(direct.status, 201);
    const key = (direct.data as any).metadata.objectKey as string;
    assert.equal(isCanonicalObjectKeyFor(key, B.tenantId, B.principalId), true);
    assert.equal(key.includes('..'), false);
    assert.equal(isCanonicalObjectKeyFor(key, A.tenantId, A.principalId), false);
    // the record id the key was derived from is the record id
    assert.equal(key.includes((direct.data as any).captureId), true);
  });

  it('S1: anonymous and header-forged callers cannot complete or init an upload; storage is untouched', async () => {
    const init = await initUpload(A);
    resetOps();
    for (const url of [COMPLETE, INIT]) {
      assert.equal((await call('POST', url, { captureId: init.captureId, objectKey: init.objectKey, data: [1] }, null)).status, 401);
      assert.equal((await call('POST', url, { captureId: init.captureId, objectKey: init.objectKey, data: [1] }, null, { 'x-principal-id': A.principalId, 'x-nagex-tenant': A.tenantId })).status, 401);
    }
    assert.equal(total(), 0);
  });

  it('over the real HTTP server: the whole attack is refused and the victim\'s object is intact', async () => {
    const a = as(A), b = as(B);
    await withTestServer(async (origin) => {
      const post = (cookie: string, path: string, body: unknown) => fetch(origin + path, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
      const init = (await (await post(a.cookie, INIT, { filename: 'http.txt', mimeType: 'text/plain', sizeBytes: 10 })).json()) as Init;
      assert.equal((await post(a.cookie, COMPLETE, { captureId: init.captureId, objectKey: init.objectKey, mimeType: 'text/plain', originalFilename: 'http.txt', data: Array.from(Buffer.from('S2D-HTTP-SECRET')) })).status, 200);
      resetOps();
      const steal = await post(b.cookie, COMPLETE, { captureId: 'cap_b_http', objectKey: init.objectKey, mimeType: 'text/plain', originalFilename: 'b.txt', data: Array.from(Buffer.from('S2D-HTTP-OVERWRITE')) });
      assert.equal(steal.status, 404);
      assert.equal(total(), 0);
      assert.equal(await readObject(init.objectKey), 'S2D-HTTP-SECRET');
    });
  });
});

describe('S2D — object key ownership primitive', () => {
  it('only a key of the canonical shape under THIS tenant and principal is owned', () => {
    const prefix = canonicalObjectKeyPrefix('ten_x', 'usr_x');
    assert.equal(prefix, 'tenant/ten_x/principal/usr_x/captures/');
    const ok = `${prefix}cap_0123456789abcdef/1700000000_a.txt`;
    assert.equal(isCanonicalObjectKeyFor(ok, 'ten_x', 'usr_x'), true);
    const bad: unknown[] = [
      undefined, null, 5, '', {}, ok + '/extra', `${prefix}cap_1`, `${prefix}cap_1/`, `${prefix}/x.txt`, `${prefix}cap_1/..`, `${prefix}cap_1/.`, `${prefix}../cap/x`,
      ok.replace('ten_x', 'ten_y'), ok.replace('usr_x', 'usr_y'), ok.replace(/\//g, '_'), `/${ok}`, ok.replace('tenant/', 'Tenant/'), `${ok}\u0000`, `${ok} `, ok + 'x'.repeat(600),
      `${prefix}cap_1/a\\b.txt`, `${prefix}cap 1/a.txt`,
    ];
    for (const key of bad) assert.equal(isCanonicalObjectKeyFor(key, 'ten_x', 'usr_x'), false, JSON.stringify(key)?.slice(0, 60));
    assert.equal(isCanonicalObjectKeyFor(ok, 'ten_y', 'usr_x'), false);
    assert.equal(isCanonicalObjectKeyFor(ok, 'ten_x', 'usr_y'), false);
  });

  it('a capture id is server-generated only', () => {
    const s = new CaptureStore(fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-s2d-cap-')));
    for (const id of ['cap_x', '../cap_0123456789abcdef', 'cap_0123456789ABCDEF', 'cap_0123456789abcdef0', '']) {
      assert.throws(() => s.createCapture({ ownerId: 'u', tenantId: 't', type: 'TEXT', content: 'x', captureId: id }), /CAPTURE_ID_INVALID/, id);
    }
    assert.equal(s.createCapture({ ownerId: 'u', tenantId: 't', type: 'TEXT', content: 'x', captureId: 'cap_0123456789abcdef' }).captureId, 'cap_0123456789abcdef');
  });
});
