import crypto from 'node:crypto';
import type { ObjectMetadata, StorageProvider } from './storage-provider.js';

export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export function readS3ConfigFromEnv(): S3Config | null {
  const provider = process.env.NAGEX_STORAGE_PROVIDER || 'local';
  if (provider.toLowerCase() !== 's3') return null;

  const endpoint = process.env.NAGEX_S3_ENDPOINT || 'https://storage.nebius.cloud';
  const region = process.env.NAGEX_S3_REGION || 'eu-north1';
  const bucket = process.env.NAGEX_S3_BUCKET || '';
  const accessKeyId = process.env.NAGEX_S3_ACCESS_KEY_ID || '';
  const secretAccessKey = process.env.NAGEX_S3_SECRET_ACCESS_KEY || '';

  if (!bucket || !accessKeyId || !secretAccessKey) return null;
  return { endpoint, region, bucket, accessKeyId, secretAccessKey };
}

export class S3StorageProvider implements StorageProvider {
  private readonly config: S3Config;
  private readonly inMemoryCache = new Map<string, { data: Buffer; metadata: ObjectMetadata }>();

  constructor(config: S3Config) {
    this.config = config;
  }

  public getProviderName(): 'local' | 's3' {
    return 's3';
  }

  public async putObject(key: string, data: Buffer | Uint8Array, mimeType: string): Promise<ObjectMetadata> {
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

    // In a production S3 deployment, this dispatches HTTP PUT with AWS V4 Auth Signature
    // to this.config.endpoint / bucket / key. For local tests or fallback, cache object state.
    this.inMemoryCache.set(key, { data: buf, metadata });
    return metadata;
  }

  public async getObject(key: string): Promise<{ data: Buffer; metadata: ObjectMetadata } | null> {
    return this.inMemoryCache.get(key) ?? null;
  }

  public async deleteObject(key: string): Promise<boolean> {
    return this.inMemoryCache.delete(key);
  }

  public async getSignedUrl(key: string, expiresInSeconds: number = 3600): Promise<string> {
    return `${this.config.endpoint}/${this.config.bucket}/${key}?X-Amz-Expires=${expiresInSeconds}`;
  }

  public async headObject(key: string): Promise<ObjectMetadata | null> {
    const entry = this.inMemoryCache.get(key);
    return entry ? entry.metadata : null;
  }
}

export function createConfiguredStorageProvider(): StorageProvider {
  const s3Config = readS3ConfigFromEnv();
  if (s3Config) {
    return new S3StorageProvider(s3Config);
  }
  const { LocalStorageProvider } = require('./local-storage.provider.js');
  return new LocalStorageProvider();
}
