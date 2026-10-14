import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { PersistentMcpOAuthCredentialStore } from '../src/mcp/mcp-oauth-persistent-store.js';

const env = { NAGEX_TOKEN_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex') };
const identity = { tenantId: 'tenant-p', principalId: 'user-p', resource: 'https://mcp.example.org/mcp', issuer: 'https://auth.example.org', clientId: 'nagex-client' };
const tokens = { accessToken: 'private-access-test', refreshToken: 'private-refresh-test', tokenType: 'Bearer' as const, expiresIn: 3600, scope: ['tools.read'] };
function temp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-mcp-oauth-'));
  return { dir, file: path.join(dir, 'credentials.json'), close: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

describe('MCP OAuth encrypted persistent credential store', () => {
  it('survives a restart and never writes plaintext secrets', () => {
    const t = temp();
    try {
      const store = new PersistentMcpOAuthCredentialStore({ file: t.file, env });
      store.save(identity, tokens, 23);
      const disk = fs.readFileSync(t.file, 'utf8');
      assert.doesNotMatch(disk, /private-access-test|private-refresh-test/);
      const reloaded = new PersistentMcpOAuthCredentialStore({ file: t.file, env });
      assert.deepEqual(reloaded.load(identity), { identity, tokens, storedAt: 23 });
      assert.equal(reloaded.load({ ...identity, principalId: 'other' }), null);
      assert.equal(reloaded.remove(identity), true);
      assert.equal(new PersistentMcpOAuthCredentialStore({ file: t.file, env }).load(identity), null);
    } finally { t.close(); }
  });
  it('fails closed for absent key, wrong key, tampered bytes or unsupported schema', () => {
    const t = temp();
    try {
      assert.throws(() => new PersistentMcpOAuthCredentialStore({ file: t.file, env: {} }), /MCP_OAUTH_ENCRYPTION_REQUIRED/);
      new PersistentMcpOAuthCredentialStore({ file: t.file, env }).save(identity, tokens);
      const wrong = { NAGEX_TOKEN_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex') };
      assert.throws(() => new PersistentMcpOAuthCredentialStore({ file: t.file, env: wrong }));
      const document = JSON.parse(fs.readFileSync(t.file, 'utf8'));
      document.records[0].envelope.ciphertext = Buffer.from('modified ciphertext').toString('base64');
      fs.writeFileSync(t.file, JSON.stringify(document));
      assert.throws(() => new PersistentMcpOAuthCredentialStore({ file: t.file, env }));
      fs.writeFileSync(t.file, JSON.stringify({ schema: 999, records: [] }));
      assert.throws(() => new PersistentMcpOAuthCredentialStore({ file: t.file, env }), /MCP_OAUTH_STORE_SCHEMA_INVALID/);
    } finally { t.close(); }
  });
  it('does not restore from a symlink and refuses malformed snapshots', () => {
    const t = temp();
    try {
      const original = path.join(t.dir, 'other.json');
      fs.writeFileSync(original, JSON.stringify({ schema: 1, records: [] }));
      // On Windows, creating symlinks may require Developer Mode or elevated
      // privileges. Verify the security invariant when OS policy permits it.
      let symlinkCreated = false;
      try { fs.symlinkSync(original, t.file); symlinkCreated = true; }
      catch (error) {
        if (!['EPERM', 'EACCES', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      }
      if (symlinkCreated) {
        assert.throws(() => new PersistentMcpOAuthCredentialStore({ file: t.file, env }), /MCP_OAUTH_STORE_INVALID_FILE/);
        fs.rmSync(t.file);
      }
      fs.writeFileSync(t.file, JSON.stringify({ schema: 1, records: [{ id: 'forged' }] }));
      assert.throws(() => new PersistentMcpOAuthCredentialStore({ file: t.file, env }));
    } finally { t.close(); }
  });
  it('does not change in-memory ownership when a write fails', () => {
    const t = temp();
    try {
      const store = new PersistentMcpOAuthCredentialStore({ file: t.file, env });
      store.save(identity, tokens);
      const invalid = { ...identity, principalId: 'invalid-test' };
      // A directory in place of the final file blocks replacement and triggers rollback.
      fs.rmSync(t.file);
      fs.mkdirSync(t.file);
      assert.throws(() => store.save(invalid, tokens));
      assert.equal(store.load(invalid), null);
      assert.ok(store.load(identity));
    } finally { t.close(); }
  });
});
