import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveNagexDataDir } from '../governance/file-record.store.js';
import type { ObjectMetadata, StorageProvider } from './storage-provider.js';

export class LocalStorageProvider implements StorageProvider {
  private readonly storageDir: string;

  constructor(storageDir?: string) {
    this.storageDir = storageDir ?? resolveNagexDataDir('object-storage', 'NAGEX_OBJECT_STORAGE_DIR');
    fs.mkdirSync(this.storageDir, { recursive: true, mode: 0o700 });
  }

  public getProviderName(): 'local' | 's3' {
    return 'local';
  }

  private sanitizeKey(key: string): string {
    return key.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
  }

  private getPaths(key: string): { dataPath: string; metaPath: string } {
    const safeKey = this.sanitizeKey(key);
    return {
      dataPath: path.join(this.storageDir, `${safeKey}.bin`),
      metaPath: path.join(this.storageDir, `${safeKey}.meta.json`),
    };
  }

  public async putObject(key: string, data: Buffer | Uint8Array, mimeType: string): Promise<ObjectMetadata> {
    const { dataPath, metaPath } = this.getPaths(key);
    const buf = Buffer.from(data);
    const checksum = crypto.createHash('sha256').update(buf).digest('hex');
    const now = new Date().toISOString();

    const metadata: ObjectMetadata = {
      objectKey: key,
      sizeBytes: buf.length,
      mimeType,
      checksum,
      uploadedAt: now,
    };

    fs.writeFileSync(dataPath, buf);
    fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2), 'utf8');
    return metadata;
  }

  public async getObject(key: string): Promise<{ data: Buffer; metadata: ObjectMetadata } | null> {
    const { dataPath, metaPath } = this.getPaths(key);
    if (!fs.existsSync(dataPath) || !fs.existsSync(metaPath)) {
      return null;
    }
    try {
      const data = fs.readFileSync(dataPath);
      const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as ObjectMetadata;
      return { data, metadata };
    } catch {
      return null;
    }
  }

  public async deleteObject(key: string): Promise<boolean> {
    const { dataPath, metaPath } = this.getPaths(key);
    let deleted = false;
    if (fs.existsSync(dataPath)) {
      fs.rmSync(dataPath, { force: true });
      deleted = true;
    }
    if (fs.existsSync(metaPath)) {
      fs.rmSync(metaPath, { force: true });
    }
    return deleted;
  }

  public async getSignedUrl(key: string, expiresInSeconds: number = 3600): Promise<string> {
    const safeKey = this.sanitizeKey(key);
    return `/api/v1/storage/local/${safeKey}?expires=${Date.now() + expiresInSeconds * 1000}`;
  }

  public async headObject(key: string): Promise<ObjectMetadata | null> {
    const { metaPath } = this.getPaths(key);
    if (!fs.existsSync(metaPath)) return null;
    try {
      return JSON.parse(fs.readFileSync(metaPath, 'utf8')) as ObjectMetadata;
    } catch {
      return null;
    }
  }
}
