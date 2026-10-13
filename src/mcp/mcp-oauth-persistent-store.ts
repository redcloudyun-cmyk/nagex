// Durable encrypted MCP OAuth token vault for a single NAgex server process.
// Production deployment must mount this path on protected storage, coordinate
// multiple writers, backup/rotate keys and implement token lifecycle separately.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { McpOAuthCredentialVault, type McpOAuthCredentialIdentity } from './mcp-oauth-credential-vault.js';
import type { McpOAuthTokens } from './mcp-oauth-token.js';

const MAX_FILE_BYTES = 4 * 1024 * 1024;
export const MCP_OAUTH_STORE_SCHEMA = 1;

export class PersistentMcpOAuthCredentialStore {
  private readonly vault: McpOAuthCredentialVault;
  private readonly file: string;

  constructor(options: { file: string; env?: NodeJS.ProcessEnv }) {
    if (!options.file || !path.isAbsolute(options.file)) throw new Error('MCP_OAUTH_STORE_PATH_REQUIRED');
    this.file = options.file;
    this.vault = new McpOAuthCredentialVault(options.env);
    try {
      const stat = fs.lstatSync(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) throw new Error('MCP_OAUTH_STORE_INVALID_FILE');
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { schema?: number; records?: unknown };
      if (raw?.schema !== MCP_OAUTH_STORE_SCHEMA) throw new Error('MCP_OAUTH_STORE_SCHEMA_INVALID');
      this.vault.restoreSealedSnapshot(raw.records);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  public load(identity: McpOAuthCredentialIdentity) { return this.vault.load(identity); }
  public sealedSnapshot() { return this.vault.sealedSnapshot(); }

  public save(identity: McpOAuthCredentialIdentity, tokens: McpOAuthTokens, now = Date.now()): void {
    const previous = this.vault.sealedSnapshot();
    this.vault.save(identity, tokens, now);
    try { this.persist(); }
    catch (error) {
      this.vault.restoreSealedSnapshot(previous);
      throw error;
    }
  }

  public remove(identity: McpOAuthCredentialIdentity): boolean {
    const previous = this.vault.sealedSnapshot();
    if (!this.vault.remove(identity)) return false;
    try { this.persist(); }
    catch (error) {
      this.vault.restoreSealedSnapshot(previous);
      throw error;
    }
    return true;
  }

  private persist(): void {
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Refuse symlink replacement rather than writing into unexpected storage.
    try {
      const existing = fs.lstatSync(this.file);
      if (!existing.isFile() || existing.isSymbolicLink()) throw new Error('MCP_OAUTH_STORE_INVALID_FILE');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const payload = JSON.stringify({ schema: MCP_OAUTH_STORE_SCHEMA, records: this.vault.sealedSnapshot() });
    if (Buffer.byteLength(payload) > MAX_FILE_BYTES) throw new Error('MCP_OAUTH_STORE_TOO_LARGE');
    const temp = path.join(dir, '.mcp-oauth-' + process.pid + '-' + crypto.randomBytes(8).toString('hex') + '.tmp');
    let fd: number | undefined;
    try {
      fd = fs.openSync(temp, 'wx', 0o600);
      fs.writeFileSync(fd, payload, 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(temp, this.file);
      fs.chmodSync(this.file, 0o600);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.rmSync(temp, { force: true }); } catch { /* do not mask the original error */ }
    }
  }
}
