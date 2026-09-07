import crypto from 'node:crypto';
import { NagexError } from '../common/errors.js';
import type { ObjectMetadata, StorageProvider } from './storage-provider.js';

export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface S3ConfigValidationResult {
  config: S3Config | null;
  missingFields: string[];
}

export function validateS3ConfigFromEnv(): S3ConfigValidationResult {
  const provider = process.env.NAGEX_STORAGE_PROVIDER || 'local';
  if (provider.toLowerCase() !== 's3') {
    return { config: null, missingFields: [] };
  }

  const endpoint = process.env.NAGEX_S3_ENDPOINT || '';
  const region = process.env.NAGEX_S3_REGION || '';
  const bucket = process.env.NAGEX_S3_BUCKET || '';
  const accessKeyId = process.env.NAGEX_S3_ACCESS_KEY_ID || '';
  const secretAccessKey = process.env.NAGEX_S3_SECRET_ACCESS_KEY || '';

  const missingFields: string[] = [];
  if (!endpoint) missingFields.push('NAGEX_S3_ENDPOINT');
  if (!region) missingFields.push('NAGEX_S3_REGION');
  if (!bucket) missingFields.push('NAGEX_S3_BUCKET');
  if (!accessKeyId) missingFields.push('NAGEX_S3_ACCESS_KEY_ID');
  if (!secretAccessKey) missingFields.push('NAGEX_S3_SECRET_ACCESS_KEY');

  if (missingFields.length > 0) {
    return { config: null, missingFields };
  }

  return {
    config: { endpoint, region, bucket, accessKeyId, secretAccessKey },
    missingFields: [],
  };
}

export function readS3ConfigFromEnv(): S3Config | null {
  const { config } = validateS3ConfigFromEnv();
  return config;
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

  private isMockFallbackAllowed(): boolean {
    return process.env.NAGEX_S3_ALLOW_MOCK_FALLBACK === '1';
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

    const uploadUrl = await this.getSignedUploadUrl(key, mimeType, 3600);

    try {
      const res = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': mimeType },
        body: buf,
      });

      if (!res.ok) {
        throw new Error(`S3 HTTP ${res.status} ${res.statusText}`);
      }
    } catch (err) {
      if (!this.isMockFallbackAllowed()) {
        throw new NagexError({
          code: 'STORAGE_PROVIDER_ERROR',
          category: 'PROVIDER',
          message: `S3 putObject failed for key "${key}": ${err instanceof Error ? err.message : String(err)}`,
          request_id: `req_s3_put_${Date.now()}`,
        });
      }
    }

    this.inMemoryCache.set(key, { data: buf, metadata });
    return metadata;
  }

  public async getObject(key: string): Promise<{ data: Buffer; metadata: ObjectMetadata } | null> {
    const downloadUrl = await this.getSignedUrl(key, 3600);

    try {
      const res = await fetch(downloadUrl);
      if (res.ok) {
        const arrayBuf = await res.arrayBuffer();
        const buf = Buffer.from(arrayBuf);
        const mimeType = res.headers.get('content-type') || 'application/octet-stream';
        const checksum = crypto.createHash('sha256').update(buf).digest('hex');
        const metadata: ObjectMetadata = {
          objectKey: key,
          sizeBytes: buf.length,
          mimeType,
          checksum,
          uploadedAt: new Date().toISOString(),
        };
        this.inMemoryCache.set(key, { data: buf, metadata });
        return { data: buf, metadata };
      }
      if (res.status === 404) {
        return null;
      }
      throw new Error(`S3 HTTP ${res.status} ${res.statusText}`);
    } catch (err) {
      if (!this.isMockFallbackAllowed()) {
        throw new NagexError({
          code: 'STORAGE_PROVIDER_ERROR',
          category: 'PROVIDER',
          message: `S3 getObject failed for key "${key}": ${err instanceof Error ? err.message : String(err)}`,
          request_id: `req_s3_get_${Date.now()}`,
        });
      }
    }

    const cached = this.inMemoryCache.get(key);
    return cached ?? null;
  }

  public async deleteObject(key: string): Promise<boolean> {
    const deleteUrl = this.buildSigV4Url('DELETE', key, 3600);

    try {
      const res = await fetch(deleteUrl, { method: 'DELETE' });
      if (!res.ok && res.status !== 404 && res.status !== 204) {
        throw new Error(`S3 HTTP ${res.status}`);
      }
      this.inMemoryCache.delete(key);
      return res.ok || res.status === 204 || res.status === 404;
    } catch (err) {
      if (!this.isMockFallbackAllowed()) {
        throw new NagexError({
          code: 'STORAGE_PROVIDER_ERROR',
          category: 'PROVIDER',
          message: `S3 deleteObject failed for key "${key}": ${err instanceof Error ? err.message : String(err)}`,
          request_id: `req_s3_del_${Date.now()}`,
        });
      }
    }

    return this.inMemoryCache.delete(key);
  }

  public async headObject(key: string): Promise<ObjectMetadata | null> {
    const headUrl = this.buildSigV4Url('HEAD', key, 3600);

    try {
      const res = await fetch(headUrl, { method: 'HEAD' });
      if (res.ok) {
        return {
          objectKey: key,
          sizeBytes: Number(res.headers.get('content-length') || 0),
          mimeType: res.headers.get('content-type') || 'application/octet-stream',
          checksum: res.headers.get('etag')?.replace(/"/g, '') || '',
          uploadedAt: res.headers.get('last-modified') || new Date().toISOString(),
        };
      }
      if (res.status === 404) {
        return null;
      }
      throw new Error(`S3 HTTP ${res.status} ${res.statusText}`);
    } catch (err) {
      if (!this.isMockFallbackAllowed()) {
        throw new NagexError({
          code: 'STORAGE_PROVIDER_ERROR',
          category: 'PROVIDER',
          message: `S3 headObject failed for key "${key}": ${err instanceof Error ? err.message : String(err)}`,
          request_id: `req_s3_head_${Date.now()}`,
        });
      }
    }

    const entry = this.inMemoryCache.get(key);
    return entry ? entry.metadata : null;
  }

  public async checkHealth(): Promise<{ configured: boolean; reachable: boolean; bucket?: string; region?: string; mode: 'LIVE' | 'DEVELOPMENT' | 'OFFLINE' }> {
    const pingKey = `health_ping_${Date.now()}.txt`;
    try {
      const headUrl = this.buildSigV4Url('HEAD', pingKey, 60);
      const res = await fetch(headUrl, { method: 'HEAD' });
      const reachable = res.status < 500; // HTTP 200, 404, or 403 means S3 endpoint is online
      return {
        configured: true,
        reachable,
        bucket: this.config.bucket,
        region: this.config.region,
        mode: reachable ? 'LIVE' : 'OFFLINE',
      };
    } catch {
      return {
        configured: true,
        reachable: false,
        bucket: this.config.bucket,
        region: this.config.region,
        mode: 'OFFLINE',
      };
    }
  }

  public async getSignedUrl(key: string, expiresInSeconds: number = 3600): Promise<string> {
    return this.buildSigV4Url('GET', key, expiresInSeconds);
  }

  public async getSignedUploadUrl(key: string, mimeType: string, expiresInSeconds: number = 3600): Promise<string> {
    return this.buildSigV4Url('PUT', key, expiresInSeconds, mimeType);
  }

  private buildSigV4Url(method: 'GET' | 'PUT' | 'DELETE' | 'HEAD', key: string, expiresInSeconds: number, mimeType?: string): string {
    const now = new Date();
    const dateStr = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dayStr = dateStr.slice(0, 8);
    const region = this.config.region;
    const service = 's3';
    const credentialScope = `${dayStr}/${region}/${service}/aws4_request`;

    const endpointUrl = new URL(this.config.endpoint);
    const host = endpointUrl.host;
    const bucket = this.config.bucket;
    const cleanKey = key.replace(/^\/+/, '');
    const path = `/${bucket}/${cleanKey}`;

    const queryParams: Record<string, string> = {
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${this.config.accessKeyId}/${credentialScope}`,
      'X-Amz-Date': dateStr,
      'X-Amz-Expires': String(expiresInSeconds),
      'X-Amz-SignedHeaders': 'host',
    };

    const canonicalQueryString = Object.keys(queryParams)
      .sort()
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(queryParams[k])}`)
      .join('&');

    const canonicalHeaders = `host:${host}\n`;
    const signedHeaders = 'host';
    const payloadHash = 'UNSIGNED-PAYLOAD';

    const canonicalRequest = [
      method,
      path,
      canonicalQueryString,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const canonicalRequestHash = crypto.createHash('sha256').update(canonicalRequest).digest('hex');

    const stringToSign = [
      'AWS4-HMAC-SHA256',
      dateStr,
      credentialScope,
      canonicalRequestHash,
    ].join('\n');

    const kDate = crypto.createHmac('sha256', `AWS4${this.config.secretAccessKey}`).update(dayStr).digest();
    const kRegion = crypto.createHmac('sha256', kDate).update(region).digest();
    const kService = crypto.createHmac('sha256', kRegion).update(service).digest();
    const kSigning = crypto.createHmac('sha256', kService).update('aws4_request').digest();

    const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

    return `${endpointUrl.origin}${path}?${canonicalQueryString}&X-Amz-Signature=${signature}`;
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
