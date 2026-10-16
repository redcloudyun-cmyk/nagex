import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { FileRecordStore, resolveNagexDataDir } from '../governance/file-record.store.js';
import type { VideoCostEstimate } from './providers/creation-provider.types.js';

// Persistent record of one video job and the bytes of the finished video.
//
// The record is the single source of truth for a job: its state is read from here by the status route and by the driver, never inferred from the
// screen. Every transition that matters (approved -> submitting -> submitted, completed, failed) is written with writeOrThrow so a crash cannot
// leave the file claiming something that did not happen.

export type VideoJobStatus =
  | 'AWAITING_APPROVAL' // priced and prepared; nothing has been sent anywhere
  | 'SUBMITTING' // approval consumed, provider call in flight (a crash here is resolved on restart, never guessed)
  | 'PENDING' // accepted by the provider, waiting in its queue
  | 'RUNNING' // the provider is generating
  | 'COMPLETED' // the MP4 was downloaded, validated and stored
  | 'FAILED'
  | 'CANCELLED' // cancelled at the provider (only offered where the provider supports it)
  | 'DECLINED' // the person said no (or the approval expired) - nothing was ever sent
  | 'UNAVAILABLE'; // no provider could take it

export const TERMINAL_VIDEO_STATUSES: ReadonlySet<VideoJobStatus> = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'DECLINED', 'UNAVAILABLE']);

export type VideoJobMode = 'TEXT_TO_VIDEO' | 'IMAGE_TO_VIDEO';

export interface VideoJobRecord {
  jobId: string;
  tenantId: string;
  ownerId: string;
  title: string;
  prompt: string;
  mode: VideoJobMode;
  providerId: string;
  model: string;
  durationSeconds: number;
  aspectRatio: '16:9' | '9:16' | '1:1';
  /** image-to-video: the person's own NAgex image (never a URL) */
  sourceImageId?: string;
  status: VideoJobStatus;
  /** why a terminal state was reached (stable code); `reason` is for the person, `errorCode`/`errorMessage` are the provider-neutral failure facts */
  errorCode?: string;
  errorMessage?: string;
  estimate: VideoCostEstimate;
  approvalId: string;
  /** digest of the exact request the approval was given for; a different request needs a new approval */
  payloadHash: string;
  idempotencyKey: string;
  providerRequestId?: string;
  parentJobId?: string;
  submitAttempts: number;
  pollCount: number;
  consecutivePollFailures: number;
  downloadAttempts?: number;
  lastPolledAt?: string;
  submittedAt?: string;
  completedAt?: string;
  // the finished file
  mimeType?: string;
  byteLength?: number;
  sha256?: string;
  binaryStoragePath?: string;
  artifactId?: string;
  requestId: string;
  createdAt: string;
  updatedAt: string;
}

export const VIDEO_ID_PATTERN = /^vid_[0-9a-f]{24}$/;

export function newVideoJobId(): string {
  return `vid_${crypto.randomBytes(12).toString('hex')}`;
}

const STATUSES: ReadonlySet<string> = new Set(['AWAITING_APPROVAL', 'SUBMITTING', 'PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'DECLINED', 'UNAVAILABLE']);

export function isVideoJobRecord(value: unknown): value is VideoJobRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.jobId === 'string' && VIDEO_ID_PATTERN.test(v.jobId) &&
    typeof v.tenantId === 'string' && typeof v.ownerId === 'string' &&
    typeof v.title === 'string' && typeof v.prompt === 'string' &&
    typeof v.status === 'string' && STATUSES.has(v.status) &&
    typeof v.providerId === 'string' && typeof v.approvalId === 'string' &&
    typeof v.createdAt === 'string' && typeof v.idempotencyKey === 'string' &&
    !!v.estimate && typeof v.estimate === 'object'
  );
}

export class VideoStore {
  private readonly records: FileRecordStore<VideoJobRecord>;
  private readonly bytesDir: string;

  constructor(options?: { metaDir?: string; bytesDir?: string }) {
    const metaDir = options?.metaDir ?? resolveNagexDataDir('videos', 'NAGEX_VIDEOS_DIR');
    this.bytesDir = options?.bytesDir ?? resolveNagexDataDir('video-bytes', 'NAGEX_VIDEO_BYTES_DIR');
    this.records = new FileRecordStore<VideoJobRecord>(metaDir, isVideoJobRecord);
    fs.mkdirSync(this.bytesDir, { recursive: true });
  }

  /** persists or throws: a job state must never be silently lost */
  public save(record: VideoJobRecord): VideoJobRecord {
    record.updatedAt = new Date().toISOString();
    this.records.writeOrThrow(record.jobId, record);
    return record;
  }

  /** the owner's job, or null - a wrong tenant, a wrong owner and an unknown id are indistinguishable */
  public get(jobId: string, tenantId: string, ownerId: string): VideoJobRecord | null {
    if (!VIDEO_ID_PATTERN.test(jobId)) return null;
    const record = this.records.read(jobId);
    return record && record.tenantId === tenantId && record.ownerId === ownerId ? record : null;
  }

  /** for the driver only: every tenant's non-terminal jobs */
  public listActive(): VideoJobRecord[] {
    return this.records.readAll().filter((r) => !TERMINAL_VIDEO_STATUSES.has(r.status));
  }

  public list(tenantId: string, ownerId: string, limit = 50): VideoJobRecord[] {
    return this.records
      .readAll()
      .filter((r) => r.tenantId === tenantId && r.ownerId === ownerId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  public saveBinary(jobId: string, bytes: Buffer): string {
    if (!VIDEO_ID_PATTERN.test(jobId)) throw new Error('invalid video job id');
    const filePath = path.join(this.bytesDir, `${jobId}.mp4`);
    const tmp = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmp, bytes, { mode: 0o600 });
    fs.renameSync(tmp, filePath);
    return filePath;
  }

  public readBinary(record: VideoJobRecord): Buffer | null {
    if (!record.binaryStoragePath) return null;
    // the path is only ever read from inside the bytes directory, whatever a record says
    const resolved = path.resolve(record.binaryStoragePath);
    if (path.dirname(resolved) !== path.resolve(this.bytesDir)) return null;
    try {
      return fs.readFileSync(resolved);
    } catch {
      return null;
    }
  }
}
