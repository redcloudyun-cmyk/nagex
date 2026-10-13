// Per-user MCP server connections. Every record belongs to exactly one tenant + user and every read is owner-scoped: a
// record owned by someone else is indistinguishable from one that does not exist. The bearer credential (if any) is a
// secret: it is encrypted at rest (AES-256-GCM, NAGEX_TOKEN_ENCRYPTION_KEY; memory only without a key) and never leaves
// this store except to the MCP client that signs a request for the owner.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decryptJson, encryptJson, loadEncryptionKey, type EncryptedEnvelope } from '../integrations/google/token.crypto.js';
import type { McpJsonSchema } from './mcp-schema.js';

// AUTH_REQUIRED: the server rejected the stored credential (expired, revoked or rotated). Nothing is callable until the owner reconnects with a new one.
export type McpConnectionStatus = 'CONNECTED' | 'IDENTITY_MISMATCH' | 'AUTH_REQUIRED' | 'ERROR';

export interface McpToolState {
  name: string;
  description: string;
  inputSchema: McpJsonSchema;
  schemaHash: string;
  readOnlyHint: boolean | null;
  // A discovered tool is NEVER callable until the owner enables it.
  enabled: boolean;
  // The advertised definition differs from what the owner enabled: disabled until re-enabled by the owner.
  changedSinceEnabled: boolean;
  capabilityId: string;
}

export interface McpConnectionRecord {
  connectionId: string;
  tenantId: string;
  principalId: string;
  name: string;
  url: string;
  bearerToken: string | null;
  status: McpConnectionStatus;
  reason: string | null;
  // Pinned on first successful initialize; any later mismatch blocks every tool until the owner removes and re-adds the server.
  identity: { origin: string; serverName: string; serverVersion: string; protocolVersion: string; pinnedAt: string };
  tools: McpToolState[];
  rejectedTools: Array<{ name: string; reason: string }>;
  createdAt: string;
  discoveredAt: string;
}

export interface McpConnectionView extends Omit<McpConnectionRecord, 'bearerToken' | 'tenantId' | 'principalId'> {
  hasCredential: boolean;
}

export function toView(record: McpConnectionRecord): McpConnectionView {
  const { bearerToken, tenantId: _tenantId, principalId: _principalId, ...rest } = record;
  return { ...rest, hasCredential: Boolean(bearerToken) };
}

export interface McpConnectionStore {
  add(record: McpConnectionRecord): void;
  get(tenantId: string, principalId: string, connectionId: string): McpConnectionRecord | undefined;
  list(tenantId: string, principalId: string): McpConnectionRecord[];
  save(record: McpConnectionRecord): void;
  remove(tenantId: string, principalId: string, connectionId: string): boolean;
  // Internal lookup used by the broker path; the caller MUST still verify ownership against the request identity.
  findByCapabilityId(capabilityId: string): McpConnectionRecord | undefined;
  all(): McpConnectionRecord[];
  // True when connections survive a restart (encrypted file with NAGEX_TOKEN_ENCRYPTION_KEY); false = memory only.
  readonly durable: boolean;
}

export class InMemoryMcpConnectionStore implements McpConnectionStore {
  protected readonly records = new Map<string, McpConnectionRecord>();
  public get durable(): boolean { return false; }

  public add(record: McpConnectionRecord): void { this.records.set(record.connectionId, record); this.onChange(); }
  public get(tenantId: string, principalId: string, connectionId: string): McpConnectionRecord | undefined {
    const record = this.records.get(connectionId);
    return record && record.tenantId === tenantId && record.principalId === principalId ? record : undefined;
  }
  public list(tenantId: string, principalId: string): McpConnectionRecord[] {
    return [...this.records.values()].filter((r) => r.tenantId === tenantId && r.principalId === principalId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  public save(record: McpConnectionRecord): void { this.records.set(record.connectionId, record); this.onChange(); }
  public remove(tenantId: string, principalId: string, connectionId: string): boolean {
    if (!this.get(tenantId, principalId, connectionId)) return false;
    this.records.delete(connectionId);
    this.onChange();
    return true;
  }
  public findByCapabilityId(capabilityId: string): McpConnectionRecord | undefined {
    const match = /^mcp\.(mcp_[a-f0-9]{16})\./.exec(capabilityId);
    return match ? this.records.get(match[1]) : undefined;
  }
  public all(): McpConnectionRecord[] { return [...this.records.values()]; }
  protected onChange(): void {}
  protected setAll(records: McpConnectionRecord[]): void { this.records.clear(); for (const r of records) this.records.set(r.connectionId, r); }
}

function isRecord(value: unknown): value is McpConnectionRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.connectionId === 'string' && /^mcp_[a-f0-9]{16}$/.test(v.connectionId) && typeof v.tenantId === 'string' && typeof v.principalId === 'string'
    && typeof v.name === 'string' && typeof v.url === 'string' && Array.isArray(v.tools) && !!v.identity && typeof v.identity === 'object';
}

export function resolveDefaultMcpStorePath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.NAGEX_MCP_STORE_PATH) return env.NAGEX_MCP_STORE_PATH;
  const preferred = '/var/lib/nagex/mcp-connections.json';
  try { fs.accessSync(path.dirname(preferred), fs.constants.W_OK); return preferred; } catch { return path.join(os.homedir(), '.local', 'share', 'nagex', 'mcp-connections.json'); }
}

export class PersistentMcpConnectionStore extends InMemoryMcpConnectionStore {
  private readonly filePath: string;
  private readonly key: Buffer | null;
  public override get durable(): boolean { return this.key !== null; }

  constructor(options: { filePath?: string; env?: NodeJS.ProcessEnv } = {}) {
    super();
    const env = options.env ?? process.env;
    this.filePath = options.filePath ?? resolveDefaultMcpStorePath(env);
    this.key = loadEncryptionKey(env);
    if (!this.key) return;
    try {
      const envelope = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as EncryptedEnvelope;
      if (envelope.version !== 1) throw new Error('unsupported version');
      const list = decryptJson<unknown[]>(this.key, envelope);
      this.setAll((Array.isArray(list) ? list : []).filter(isRecord));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error(JSON.stringify({ event: 'mcp_store_invalid', message: 'Could not decrypt or parse the persisted MCP connections; treating them as absent.' }));
    }
  }

  protected onChange(): void {
    if (!this.key) return;
    const dir = path.dirname(this.filePath);
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (this.records.size === 0) { fs.rmSync(this.filePath, { force: true }); return; }
      const tmp = path.join(dir, `.mcp-connections.json.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
      const fd = fs.openSync(tmp, 'w', 0o600);
      try { fs.writeSync(fd, JSON.stringify(encryptJson(this.key, [...this.records.values()]))); try { fs.fsyncSync(fd); } catch { /* best effort */ } } finally { fs.closeSync(fd); }
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, this.filePath);
    } catch (error) {
      console.error(JSON.stringify({ event: 'mcp_store_persist_failed', code: (error as NodeJS.ErrnoException).code ?? 'UNKNOWN' }));
    }
  }
}
