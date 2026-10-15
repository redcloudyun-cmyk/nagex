// D-9 integration - a separate, pre-existing truthfulness defect found while inspecting the Vault write paths: VaultStore.saveItem() swallowed disk-write errors (FileRecordStore.write logs and
// returns), so POST /api/v1/workspace/vault, the Inbox "save to Vault" and the Knowledge upload answered 201 with a Vault item that was never stored - and the Inbox route then marked the
// capture ACTIONED. FAKE_SUCCESS_PATHS must be 0. The approval-gated save (VaultStore.saveItemOnce) never had this problem; this test pins the ordinary paths too.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { handleAsyncApiRequest, vaultStore } from '../src/server_web.js';
import { captureStore } from '../src/workspace/capture.store.js';
import { resolveNagexDataDir } from '../src/governance/file-record.store.js';
import { authAs } from './_s1_session_auth.js';

const TENANT = 'ten_vault_truth';
const as = (user: string) => authAs(TENANT, user);

// the Vault directory becomes a plain file for the duration of `body`: nothing can be written below it
async function withUnwritableVault<T>(body: () => Promise<T>): Promise<T> {
  const dir = resolveNagexDataDir('vault', 'NAGEX_VAULT_DIR');
  fs.mkdirSync(dir, { recursive: true });
  const aside = `${dir}.aside-${Date.now()}`;
  fs.renameSync(dir, aside);
  fs.writeFileSync(dir, 'blocked');
  try {
    return await body();
  } finally {
    fs.rmSync(dir, { force: true });
    fs.renameSync(aside, dir);
  }
}

describe('a Vault write that did not persist is never answered as saved', () => {
  test('POST /api/v1/workspace/vault: an unwritable Vault is an error, not a 201 with an item that does not exist', async () => {
    const user = 'usr_truth_1';
    const res = await withUnwritableVault(() => handleAsyncApiRequest('POST', '/api/v1/workspace/vault', { title: 'Will not persist', type: 'DOCUMENT', contentText: 'body' }, as(user)));
    assert.ok(res.status >= 500, `expected a server error, got ${res.status}`);
    assert.doesNotMatch(JSON.stringify(res.data), /vlt_/, 'no item id is handed out for something that was not stored');
    assert.equal(vaultStore.listItems(TENANT, user).length, 0);
  });

  test('a normal write still answers 201 and the item is readable (nothing else changed)', async () => {
    const user = 'usr_truth_2';
    const res = await handleAsyncApiRequest('POST', '/api/v1/workspace/vault', { title: 'Persists', type: 'DOCUMENT', contentText: 'body' }, as(user));
    assert.equal(res.status, 201);
    assert.equal(vaultStore.getItem((res.data as any).vaultItemId, TENANT, user)?.title, 'Persists');
  });

  test('Inbox "save to Vault": a Vault that can not write leaves the capture NOT actioned (it was not saved)', async () => {
    const user = 'usr_truth_3';
    const capture = captureStore.createCapture({ ownerId: user, tenantId: TENANT, type: 'TEXT', content: 'remember this', source: 'WEB' });
    const res = await withUnwritableVault(() => handleAsyncApiRequest('POST', `/api/v1/workspace/inbox/${capture.captureId}/save-to-vault`, {}, as(user)));
    assert.ok(res.status >= 500, `expected a server error, got ${res.status}`);
    assert.notEqual(captureStore.getCapture(capture.captureId, TENANT, user)?.status, 'ACTIONED');
    assert.equal(vaultStore.listItems(TENANT, user).length, 0);
  });
});
