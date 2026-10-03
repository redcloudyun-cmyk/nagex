// Security Gate S2D — source contract that keeps the tenant-resource-ownership boundary from regressing.
// Behavior is certified by security_s2d_tenant_resource_ownership; this only pins the structure it depends on.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (rel: string): string => fs.readFileSync(path.resolve(rel), 'utf8').replace(/\r\n/g, '\n');
const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []));

describe('S2D — tenant resource ownership contract', () => {
  it('completeUpload decides ownership (record lookup, status, key) before ANY storage access and can no longer create a capture from a client key', () => {
    const src = read('src/workspace/quick-capture.service.ts');
    const start = src.indexOf('public async completeUpload(');
    const body = src.slice(start, src.indexOf('\n  }\n', start));
    const lookup = body.indexOf('this.store.getCapture(params.captureId, params.tenantId, params.ownerId)');
    const owned = body.indexOf('this.ownedObjectKey(item)');
    const firstStorage = body.indexOf('this.storageProvider.');
    assert.ok(lookup > 0 && owned > lookup && firstStorage > owned, 'record lookup, then key ownership, then storage');
    assert.equal(/createCapture\(/.test(body), false, 'completion never creates a capture');
    assert.equal(/storageProvider\.\w+\(params\.objectKey/.test(body), false, 'a client-supplied key never reaches storage');
    assert.match(body, /UPLOAD_OBJECT_KEY_MISMATCH/);
    assert.match(body, /UPLOAD_NOT_PENDING/);
  });

  it('every storage access that follows a capture record goes through the ownership guard', () => {
    const src = read('src/workspace/quick-capture.service.ts');
    // the only direct storage calls with a record's key are inside ownedObjectKey-guarded code
    assert.equal(/storageProvider\.(getObject|deleteObject|getSignedUrl)\(\s*item\.metadata\.objectKey/.test(src), false, 'no direct use of a record key');
    for (const fn of ['deleteCaptureItem', 'getDownloadUrl', 'retryCapture']) {
      const at = src.indexOf(`public async ${fn}(`);
      assert.ok(at > 0, fn);
      assert.ok(src.slice(at, at + 2500).includes('ownedObjectKey('), `${fn} uses the guard`);
    }
    assert.match(src, /isCanonicalObjectKeyFor\(key, item\.tenantId, item\.ownerId\)/);
    const processor = read('src/workspace/capture-processor.ts');
    assert.match(processor, /isCanonicalObjectKeyFor\(item\.metadata\.objectKey, item\.tenantId, item\.ownerId\)/);
  });

  it('no route reads an object key from the request into storage, and keys are derived from the record id', () => {
    for (const f of walk(path.resolve('src/http'))) {
      const s = fs.readFileSync(f, 'utf8');
      assert.equal(/storageProvider\.(getObject|putObject|deleteObject)\(/.test(s), false, `${path.basename(f)} must not call storage directly`);
    }
    const svc = read('src/workspace/quick-capture.service.ts');
    assert.equal((svc.match(/captureId,\s+\/\/ S2D: the record id is the id the object key was derived from/g) ?? []).length, 2, 'init and direct upload both bind record id to key');
    assert.match(read('src/workspace/capture.store.ts'), /CAPTURE_ID_INVALID/);
  });

  it('the execution history is filtered by tenant AND principal, and new records carry their owner', () => {
    const src = read('src/http/routes/governance.routes.ts');
    assert.match(src, /executionHistory\.filter\(\(e\) => e\.tenant_id === tenantId && e\.principal_id === principal\.id\)/);
    assert.match(src, /principal_id: principal\.id/);
    assert.equal(/executions: executionHistory,/.test(src), false, 'the shared array is never returned directly');
  });
});
