import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { FileRecordStore, resolveNagexDataDir } from '../governance/file-record.store.js';
import type { CreationSourceRef } from './creation-runtime.types.js';
import type { ProviderExecutionMetadata } from './providers/creation-provider.types.js';

export interface ImageRecord {
  imageId: string;
  tenantId: string;
  ownerId: string;
  title: string;
  prompt: string;
  style?: string;
  aspectRatio: string;
  mimeType: string;
  width: number;
  height: number;
  binaryStoragePath: string;
  parentImageId?: string;
  revisionIndex: number;
  sourceRefs: CreationSourceRef[];
  providerExecutionMetadata: ProviderExecutionMetadata;
  artifactId?: string;
  createdAt: string;
  updatedAt: string;
}

export function isImageRecord(value: unknown): value is ImageRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.imageId === 'string' &&
    typeof v.tenantId === 'string' &&
    typeof v.ownerId === 'string' &&
    typeof v.title === 'string' &&
    typeof v.prompt === 'string' &&
    typeof v.mimeType === 'string' &&
    typeof v.binaryStoragePath === 'string' &&
    typeof v.createdAt === 'string'
  );
}

export class ImageStore {
  private readonly recordStore: FileRecordStore<ImageRecord>;
  private readonly bytesDir: string;

  constructor(options?: { metaDir?: string; bytesDir?: string }) {
    const metaDir = options?.metaDir ?? resolveNagexDataDir('images', 'NAGEX_IMAGES_DIR');
    this.bytesDir = options?.bytesDir ?? resolveNagexDataDir('image-bytes', 'NAGEX_IMAGE_BYTES_DIR');
    this.recordStore = new FileRecordStore<ImageRecord>(metaDir, isImageRecord);

    if (!fs.existsSync(this.bytesDir)) {
      fs.mkdirSync(this.bytesDir, { recursive: true });
    }
  }

  public save(record: ImageRecord): ImageRecord {
    this.recordStore.write(record.imageId, record);
    return record;
  }

  public saveBinary(imageId: string, buffer: Buffer, mimeType: string): string {
    const ext = mimeType.includes('png') ? '.png' : mimeType.includes('webp') ? '.webp' : '.jpg';
    const filePath = path.join(this.bytesDir, `${imageId}${ext}`);
    fs.writeFileSync(filePath, buffer);
    return filePath;
  }

  public getBinary(filePath: string): Buffer | null {
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath);
    }
    return null;
  }

  public get(imageId: string, tenantId: string, ownerId: string): ImageRecord | null {
    const record = this.recordStore.read(imageId);
    if (!record || record.tenantId !== tenantId || record.ownerId !== ownerId) {
      return null;
    }
    return record;
  }

  public list(tenantId: string, ownerId: string, limit = 50): ImageRecord[] {
    const records = this.recordStore.readAll().filter(
      (rec) => rec.tenantId === tenantId && rec.ownerId === ownerId
    );
    records.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return records.slice(0, limit);
  }

  public getLineage(parentImageId: string, tenantId: string, ownerId: string): ImageRecord[] {
    return this.recordStore.readAll().filter(
      (rec) => rec.tenantId === tenantId && rec.ownerId === ownerId && (rec.imageId === parentImageId || rec.parentImageId === parentImageId)
    ).sort((a, b) => a.revisionIndex - b.revisionIndex);
  }
}
