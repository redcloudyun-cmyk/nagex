import fs from 'node:fs';
import path from 'node:path';
import { FileRecordStore, resolveNagexDataDir } from '../governance/file-record.store.js';
import type { CreationSourceRef } from './creation-runtime.types.js';
import type { ProviderExecutionMetadata } from './providers/creation-provider.types.js';
import type { PresentationOutlineSlide } from '../model-gateway/presentation-outline.js';

/** NAgex-owned presentation identity. The file lives in NAgex storage; no provider URL is ever the presentation. */
export const PRESENTATION_ID_PATTERN = /^pres_[0-9a-f]{24}$/;

export interface PresentationRecord {
  presentationId: string;
  tenantId: string;
  ownerId: string;
  title: string;
  subtitle: string;
  summary: string;
  locale: 'en' | 'ko';
  slides: PresentationOutlineSlide[];
  mimeType: string;
  byteLength: number;
  binaryStoragePath: string;
  sourceRefs: CreationSourceRef[];
  providerExecutionMetadata: ProviderExecutionMetadata;
  artifactId?: string;
  // Additive (revisions): a revised deck is a NEW deck that points back; the first deck of a family has none of these. revisionIndex 1 = the original.
  parentPresentationId?: string;
  revisedFromPresentationId?: string;
  revisionIndex?: number;
  createdAt: string;
  updatedAt: string;
}

export function isPresentationRecord(value: unknown): value is PresentationRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.presentationId === 'string' &&
    typeof v.tenantId === 'string' &&
    typeof v.ownerId === 'string' &&
    typeof v.title === 'string' &&
    Array.isArray(v.slides) &&
    typeof v.binaryStoragePath === 'string' &&
    typeof v.createdAt === 'string'
  );
}

export class PresentationStore {
  private readonly recordStore: FileRecordStore<PresentationRecord>;
  private readonly bytesDir: string;

  constructor(options?: { metaDir?: string; bytesDir?: string }) {
    const metaDir = options?.metaDir ?? resolveNagexDataDir('presentations', 'NAGEX_PRESENTATIONS_DIR');
    this.bytesDir = options?.bytesDir ?? resolveNagexDataDir('presentation-bytes', 'NAGEX_PRESENTATION_BYTES_DIR');
    this.recordStore = new FileRecordStore<PresentationRecord>(metaDir, isPresentationRecord);
    if (!fs.existsSync(this.bytesDir)) fs.mkdirSync(this.bytesDir, { recursive: true });
  }

  public save(record: PresentationRecord): PresentationRecord {
    this.recordStore.write(record.presentationId, record);
    return record;
  }

  public saveBinary(presentationId: string, buffer: Buffer): string {
    if (!PRESENTATION_ID_PATTERN.test(presentationId)) throw new Error('Invalid presentation id.');
    const filePath = path.join(this.bytesDir, `${presentationId}.pptx`);
    fs.writeFileSync(filePath, buffer);
    return filePath;
  }

  public getBinary(filePath: string): Buffer | null {
    // only ever read a file this store wrote: inside bytesDir and named like a presentation
    const resolved = path.resolve(filePath);
    if (path.dirname(resolved) !== path.resolve(this.bytesDir) || !/^pres_[0-9a-f]{24}\.pptx$/.test(path.basename(resolved))) return null;
    return fs.existsSync(resolved) ? fs.readFileSync(resolved) : null;
  }

  /** Strict tenant + owner equality: a wrong tenant, a wrong owner and an unknown id are indistinguishable. */
  public get(presentationId: string, tenantId: string, ownerId: string): PresentationRecord | null {
    if (!PRESENTATION_ID_PATTERN.test(presentationId)) return null;
    const record = this.recordStore.read(presentationId);
    if (!record || record.tenantId !== tenantId || record.ownerId !== ownerId) return null;
    return record;
  }

  public list(tenantId: string, ownerId: string, limit = 50): PresentationRecord[] {
    const records = this.recordStore.readAll().filter((rec) => rec.tenantId === tenantId && rec.ownerId === ownerId);
    records.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return records.slice(0, limit);
  }
}
