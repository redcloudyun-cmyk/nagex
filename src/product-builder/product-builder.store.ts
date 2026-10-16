// Persistent, owner-scoped storage of Product Builder projects (and the binary assets they own: mockup images). A project is a resumable record: nothing about its progress lives only in memory.
import fs from 'node:fs';
import path from 'node:path';
import { FileRecordStore, resolveNagexDataDir } from '../governance/file-record.store.js';
import { getCurrentISOString } from '../common/utils.js';
import type { ProductProjectRecord } from './product-builder.types.js';

function isProjectRecord(value: unknown): value is ProductProjectRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.projectId === 'string' && typeof v.tenantId === 'string' && typeof v.ownerId === 'string' && typeof v.state === 'string' && typeof v.request === 'string' && Array.isArray(v.history) && typeof v.createdAt === 'string';
}

const MAX_HISTORY = 200;

export class ProductProjectStore {
  private readonly records: FileRecordStore<ProductProjectRecord>;
  public readonly baseDir: string;

  constructor(options: { dir?: string; env?: NodeJS.ProcessEnv } = {}) {
    this.baseDir = options.dir ?? resolveNagexDataDir('product-builder', 'NAGEX_PRODUCT_BUILDER_DIR', options.env ?? process.env);
    fs.mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
    this.records = new FileRecordStore<ProductProjectRecord>(path.join(this.baseDir, 'projects'), isProjectRecord);
  }

  public save(record: ProductProjectRecord): ProductProjectRecord {
    record.updatedAt = getCurrentISOString();
    if (record.history.length > MAX_HISTORY) record.history = record.history.slice(-MAX_HISTORY);
    this.records.writeOrThrow(record.projectId, record);
    return record;
  }

  /** Someone else's project is as absent as one that never existed. */
  public getOwned(projectId: string, tenantId: string, ownerId: string): ProductProjectRecord | null {
    const record = this.records.read(projectId);
    return record && record.tenantId === tenantId && record.ownerId === ownerId ? record : null;
  }

  public listOwned(tenantId: string, ownerId: string): ProductProjectRecord[] {
    return this.records.readAll().filter((r) => r.tenantId === tenantId && r.ownerId === ownerId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  public listAll(): ProductProjectRecord[] {
    return this.records.readAll();
  }

  // ---- mockup images --------------------------------------------------------------------------------------------------------------------------------------------------------------------------

  public mockupDir(projectId: string): string {
    if (!/^pbp_[0-9a-f]{12,}$/.test(projectId)) throw new Error('INVALID_PROJECT_ID');
    return path.join(this.baseDir, 'mockups', projectId);
  }

  public writeMockup(projectId: string, fileName: string, data: Buffer): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/.test(fileName)) throw new Error('INVALID_FILE_NAME');
    const dir = this.mockupDir(projectId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, fileName), data, { mode: 0o600 });
  }

  public readMockup(projectId: string, fileName: string): Buffer | null {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/.test(fileName)) return null;
    try { return fs.readFileSync(path.join(this.mockupDir(projectId), fileName)); } catch { return null; }
  }
}
