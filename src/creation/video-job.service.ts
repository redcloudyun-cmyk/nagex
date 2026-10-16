import crypto from 'node:crypto';
import { NagexError } from '../common/errors.js';
import { detectRequestLanguage } from '../common/request-language.js';
import type { ActionApprovalStore } from '../governance/action-approval.store.js';
import type { AuditLogger } from '../governance/audit.logger.js';
import type { ArtifactStore } from '../artifacts/artifact.store.js';
import type { ImageStore } from './image.store.js';
import type { CreationProviderRouter } from './providers/creation-provider-router.js';
import type { VideoCostEstimate, VideoProviderPort } from './providers/creation-provider.types.js';
import { asVideoProviderError, VideoProviderError } from './providers/video-provider-error.js';
import type { VideoCreationSpec } from './specs/creation-spec.types.js';
import { newVideoJobId, TERMINAL_VIDEO_STATUSES, VIDEO_ID_PATTERN, type VideoJobRecord, type VideoJobStatus, type VideoStore } from './video.store.js';
import { validateMp4 } from './video-media.js';

// The video job runtime: price -> the person approves -> submit once -> poll with bounds -> download, validate, store -> artifact.
//
// Rules this class enforces (each has a test):
//   * Nothing is sent to a provider before an approval that binds the exact request AND its price. The approval is the existing ActionApprovalStore
//     (request / approve / consume with a payload hash) - there is no second approval system.
//   * A request that is materially more expensive at approval time than what was shown needs a new approval.
//   * The same paid job is never started twice: identical active requests are returned as one job, the approval is consumed once, the provider
//     call carries the job's idempotency key, and a restart resolves a half-finished submission instead of repeating it blindly.
//   * State comes from the provider's own answers. There is no invented progress; COMPLETED exists only after a valid MP4 is on disk.
//   * Waiting is bounded (poll schedule, total wait, consecutive-failure limit, download attempts).

export const VIDEO_TOOL_ID = 'creation.video.generate';

const PROVIDER_LABELS: Record<string, string> = { higgsfield: 'Higgsfield', 'google-veo': 'Google Veo' };

export interface VideoJobServiceDeps {
  store: VideoStore;
  providerRouter: CreationProviderRouter;
  approvalStore: ActionApprovalStore;
  artifactStore?: ArtifactStore;
  imageStore?: ImageStore;
  auditLogger?: AuditLogger;
  now?: () => number;
  /** per-job ceiling in USD; a dearer request is refused before any approval is asked for */
  maxCostUsd?: number;
  /** how long a submitted job may stay unfinished before NAgex stops waiting and says so */
  maxWaitMs?: number;
  /** a rise of the price over what was approved (fraction) that requires a new approval */
  repriceTolerance?: number;
}

export interface PrepareVideoInput {
  tenantId: string;
  ownerId: string;
  requestId: string;
  prompt: string;
  durationSeconds?: number;
  aspectRatio?: string;
  sourceImageId?: string;
  parentJobId?: string;
  requestedProviderId?: string;
}

export interface VideoJobView {
  jobId: string;
  status: VideoJobStatus;
  title: string;
  prompt: string;
  mode: string;
  durationSeconds: number;
  aspectRatio: string;
  estimate: VideoCostEstimate;
  serviceLabel: string;
  sourceImageId?: string;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  submittedAt?: string;
  completedAt?: string;
  artifactId?: string;
  mediaUrl?: string;
  mimeType?: string;
  byteLength?: number;
  cancellable: boolean;
  parentJobId?: string;
}

const HARD_PROMPT_LIMIT = 2000;
const ASPECT_RATIOS = new Set(['16:9', '9:16', '1:1']);
/** errors at submission time that mean "this service cannot take the job right now": nothing was started */
const UNAVAILABLE_CODES = new Set([
  'PROVIDER_UNCONFIGURED', 'PROVIDER_AUTH_FAILED', 'PROVIDER_QUOTA_EXCEEDED', 'PROVIDER_BILLING_REQUIRED',
  'PROVIDER_INSUFFICIENT_CREDITS', 'PROVIDER_MODEL_NOT_FOUND', 'PROVIDER_UNAVAILABLE_ERROR',
]);

// After these the provider may or may not have started the job (the request or the answer was lost). 503 / 423 / 4xx are definite refusals.
function isAmbiguousSubmitFailure(failure: VideoProviderError): boolean {
  if (failure.code === 'NETWORK_ERROR' || failure.code === 'TIMEOUT' || failure.code === 'MALFORMED_RESPONSE') return true;
  return failure.httpStatus !== undefined && failure.httpStatus >= 500 && failure.httpStatus !== 503;
}

function normalizePrompt(prompt: string): string {
  return prompt.trim().replace(/\s+/g, ' ');
}

export class VideoJobService {
  private readonly now: () => number;
  private readonly maxCostUsd: number;
  private readonly maxWaitMs: number;
  private readonly repriceTolerance: number;
  private readonly busy = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: VideoJobServiceDeps) {
    this.now = deps.now ?? Date.now;
    const envCost = Number(process.env.NAGEX_VIDEO_MAX_COST_USD);
    this.maxCostUsd = deps.maxCostUsd ?? (Number.isFinite(envCost) && envCost > 0 ? envCost : 5);
    const envWait = Number(process.env.NAGEX_VIDEO_MAX_WAIT_SECONDS);
    this.maxWaitMs = deps.maxWaitMs ?? (Number.isFinite(envWait) && envWait > 0 ? envWait * 1000 : 20 * 60 * 1000);
    this.repriceTolerance = deps.repriceTolerance ?? 0.1;
  }

  // ── availability ───────────────────────────────────────────────────────────

  /** true only when a registered provider is configured: this is what the router and the capability brief use to decide whether video is offered at all */
  public isAvailable(): boolean {
    return this.firstProvider() !== null;
  }

  private firstProvider(requestedProviderId?: string): VideoProviderPort | null {
    try {
      return this.deps.providerRouter.selectVideoProvider({ creationKind: 'VIDEO', requestId: 'availability' } as VideoCreationSpec, { requestedProviderId }).selectedProvider;
    } catch {
      return null;
    }
  }

  private providerById(providerId: string): VideoProviderPort | null {
    return this.firstProvider(providerId);
  }

  // ── prepare (price + approval request; nothing is sent) ───────────────────

  public async prepare(input: PrepareVideoInput): Promise<{ job: VideoJobRecord; deduplicated: boolean }> {
    const prompt = normalizePrompt(input.prompt || '');
    if (!prompt) throw this.error('INVALID_PROMPT', 'VALIDATION', 'A description of the video is required.', input.requestId);
    if (prompt.length > HARD_PROMPT_LIMIT) throw this.error('PROMPT_TOO_LONG', 'VALIDATION', `The video description is longer than ${HARD_PROMPT_LIMIT} characters.`, input.requestId);

    const provider = (() => {
      try {
        return this.deps.providerRouter.selectVideoProvider({ creationKind: 'VIDEO', requestId: input.requestId } as VideoCreationSpec, { requestedProviderId: input.requestedProviderId }).selectedProvider;
      } catch (error: any) {
        throw this.error(error?.code === 'PROVIDER_NOT_FOUND' ? 'PROVIDER_NOT_FOUND' : 'NO_CREATION_PROVIDER_AVAILABLE', 'PROVIDER', 'No video service is set up for NAgex right now.', input.requestId);
      }
    })();
    const caps = provider.getCapabilities();

    let sourceImage: { bytes: Buffer; mimeType: string; imageId: string; sha256: string } | undefined;
    if (input.sourceImageId) {
      if (!caps.imageToVideo) throw this.error('IMAGE_TO_VIDEO_UNSUPPORTED', 'VALIDATION', 'The video service cannot start a video from an image.', input.requestId);
      sourceImage = this.loadSourceImage(input.sourceImageId, input.tenantId, input.ownerId, input.requestId);
    } else if (!caps.textToVideo) {
      throw this.error('TEXT_TO_VIDEO_UNSUPPORTED', 'VALIDATION', 'The video service cannot make a video from text.', input.requestId);
    }

    const aspectRatio = (input.aspectRatio && ASPECT_RATIOS.has(input.aspectRatio) ? input.aspectRatio : '16:9') as VideoJobRecord['aspectRatio'];
    if (!caps.supportedAspectRatios.includes(aspectRatio)) {
      throw this.error('UNSUPPORTED_ASPECT_RATIO', 'VALIDATION', `The video service cannot make ${aspectRatio} videos.`, input.requestId);
    }
    const requested = Number.isFinite(Number(input.durationSeconds)) && Number(input.durationSeconds) > 0 ? Math.round(Number(input.durationSeconds)) : 5;
    const durationSeconds = Math.min(caps.maxDurationSeconds, Math.max(caps.minDurationSeconds, requested));

    const mode = sourceImage ? 'IMAGE_TO_VIDEO' : 'TEXT_TO_VIDEO';
    const duplicate = this.deps.store
      .list(input.tenantId, input.ownerId, 200)
      .find((job) =>
        !TERMINAL_VIDEO_STATUSES.has(job.status) &&
        job.providerId === provider.providerId && job.mode === mode && job.prompt === prompt &&
        job.durationSeconds === durationSeconds && job.aspectRatio === aspectRatio && (job.sourceImageId || '') === (input.sourceImageId || ''));
    if (duplicate) return { job: duplicate, deduplicated: true };

    const spec = this.specFor({ prompt, durationSeconds, aspectRatio, title: `Video: ${prompt.slice(0, 40)}`, tenantId: input.tenantId, ownerId: input.ownerId, requestId: input.requestId }, sourceImage);
    let estimate: VideoCostEstimate;
    try {
      estimate = await provider.estimateCost(spec);
    } catch (error) {
      const failure = asVideoProviderError(error);
      throw this.error(failure.code, 'PROVIDER', `The price of this video could not be obtained, so it was not offered: ${failure.message}`, input.requestId);
    }
    if (estimate.usd === null || !Number.isFinite(estimate.usd)) {
      throw this.error('COST_UNKNOWN', 'POLICY', 'The video service did not give a price in dollars, so the cost cannot be shown and the video was not offered.', input.requestId);
    }
    if (estimate.usd > this.maxCostUsd) {
      throw this.error('COST_LIMIT_EXCEEDED', 'POLICY', `This video would cost about $${estimate.usd.toFixed(2)}, above the $${this.maxCostUsd.toFixed(2)} limit per video.`, input.requestId);
    }

    const jobId = newVideoJobId();
    const timestamp = new Date(this.now()).toISOString();
    const job: VideoJobRecord = {
      jobId,
      tenantId: input.tenantId,
      ownerId: input.ownerId,
      title: spec.title,
      prompt,
      mode,
      providerId: provider.providerId,
      model: provider.modelFor(spec),
      durationSeconds,
      aspectRatio,
      ...(sourceImage ? { sourceImageId: sourceImage.imageId } : {}),
      ...(input.parentJobId ? { parentJobId: input.parentJobId } : {}),
      status: 'AWAITING_APPROVAL',
      estimate,
      approvalId: '',
      payloadHash: '',
      idempotencyKey: `nagex-${jobId}`,
      submitAttempts: 0,
      pollCount: 0,
      consecutivePollFailures: 0,
      requestId: input.requestId,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.attachApproval(job, sourceImage?.sha256 ?? null);
    this.deps.store.save(job);
    this.audit('video.prepared', job, 'PENDING_APPROVAL');
    return { job, deduplicated: false };
  }

  private attachApproval(job: VideoJobRecord, sourceImageSha256: string | null): void {
    const approval = this.deps.approvalStore.request({
      toolId: VIDEO_TOOL_ID,
      tenantId: job.tenantId,
      principalId: job.ownerId,
      payload: this.approvalPayload(job, sourceImageSha256),
    });
    job.approvalId = approval.approvalId;
    job.payloadHash = approval.payloadHash;
  }

  private approvalPayload(job: VideoJobRecord, sourceImageSha256: string | null): Record<string, unknown> {
    return {
      jobId: job.jobId,
      providerId: job.providerId,
      model: job.model,
      mode: job.mode,
      prompt: job.prompt,
      durationSeconds: job.durationSeconds,
      aspectRatio: job.aspectRatio,
      sourceImageId: job.sourceImageId ?? null,
      sourceImageSha256,
      estimateUsd: job.estimate.usd,
      estimateBasis: job.estimate.basis,
    };
  }

  // ── approve (the one moment a paid job can start) ─────────────────────────

  public async approve(jobId: string, tenantId: string, ownerId: string, requestId: string): Promise<{ job: VideoJobRecord; reapprovalRequired: boolean }> {
    const job = this.requireJob(jobId, tenantId, ownerId, requestId);
    // a double click, a second tab or a retry must not reach the provider again
    if (job.status !== 'AWAITING_APPROVAL') return { job, reapprovalRequired: false };
    if (this.busy.has(job.jobId)) return { job, reapprovalRequired: false };
    this.busy.add(job.jobId);
    try {
      const provider = this.providerById(job.providerId);
      if (!provider) {
        return { job: this.finish(job, 'UNAVAILABLE', 'PROVIDER_UNCONFIGURED', 'The video service is no longer available.'), reapprovalRequired: false };
      }
      let sourceImage: ReturnType<VideoJobService['loadSourceImage']> | undefined;
      if (job.sourceImageId) sourceImage = this.loadSourceImage(job.sourceImageId, tenantId, ownerId, requestId);
      const spec = this.specFor(job, sourceImage);

      // 1) the price may have moved since it was shown
      let fresh: VideoCostEstimate;
      try {
        fresh = await provider.estimateCost(spec);
      } catch (error) {
        const failure = asVideoProviderError(error);
        return { job: this.finish(job, UNAVAILABLE_CODES.has(failure.code) ? 'UNAVAILABLE' : 'FAILED', failure.code, failure.message), reapprovalRequired: false };
      }
      if (fresh.usd === null || !Number.isFinite(fresh.usd)) {
        return { job: this.finish(job, 'FAILED', 'COST_UNKNOWN', 'The video service no longer gave a price, so nothing was started.'), reapprovalRequired: false };
      }
      const approvedUsd = job.estimate.usd ?? 0;
      if (fresh.usd > approvedUsd * (1 + this.repriceTolerance) + 0.005) {
        if (fresh.usd > this.maxCostUsd) {
          return { job: this.finish(job, 'FAILED', 'COST_LIMIT_EXCEEDED', `The price rose to about $${fresh.usd.toFixed(2)}, above the limit, so nothing was started.`), reapprovalRequired: false };
        }
        try { this.deps.approvalStore.reject(job.approvalId, tenantId, ownerId, requestId); } catch { /* already decided or expired: the new request below supersedes it */ }
        job.estimate = fresh;
        this.attachApproval(job, sourceImage?.sha256 ?? null);
        this.deps.store.save(job);
        this.audit('video.reapproval_required', job, 'PENDING_APPROVAL');
        return { job, reapprovalRequired: true };
      }

      // 2) the person's approval is granted and consumed exactly once, for exactly this request
      try {
        this.deps.approvalStore.approve(job.approvalId, tenantId, ownerId, requestId);
        this.deps.approvalStore.consume(job.approvalId, tenantId, ownerId, VIDEO_TOOL_ID, this.approvalPayload(job, sourceImage?.sha256 ?? null), requestId, job.jobId);
      } catch (error: any) {
        if (error?.code === 'APPROVAL_EXPIRED') {
          this.finish(job, 'DECLINED', 'APPROVAL_EXPIRED', 'The approval expired before it was used, so nothing was started.');
        } else if (error?.code === 'APPROVAL_NOT_FOUND') {
          this.finish(job, 'DECLINED', 'APPROVAL_LOST', 'The approval for this video was lost (NAgex restarted), so nothing was started. Ask again if you still want it.');
        }
        throw error;
      }

      // 3) written BEFORE the provider call so a crash cannot make a started job look unstarted
      job.status = 'SUBMITTING';
      job.submitAttempts = 1;
      this.deps.store.save(job);
      this.audit('video.approved', job, 'SUCCESS');
      await this.submit(job, provider, spec);
      return { job, reapprovalRequired: false };
    } finally {
      this.busy.delete(job.jobId);
    }
  }

  private async submit(job: VideoJobRecord, provider: VideoProviderPort, spec: VideoCreationSpec): Promise<void> {
    const caps = provider.getCapabilities();
    for (;;) {
      try {
        const { providerRequestId } = await provider.submitVideo(spec, { idempotencyKey: job.idempotencyKey });
        job.providerRequestId = providerRequestId;
        job.status = 'PENDING';
        job.submittedAt = new Date(this.now()).toISOString();
        this.deps.store.save(job);
        this.audit('video.submitted', job, 'SUCCESS');
        return;
      } catch (error) {
        const failure = asVideoProviderError(error);
        // A repeated submission is only safe where the provider de-duplicates it by key
        if (failure.retryable && caps.idempotentSubmit && job.submitAttempts < 2) {
          job.submitAttempts += 1;
          this.deps.store.save(job);
          continue;
        }
        if (isAmbiguousSubmitFailure(failure)) {
          // network failure / timeout / 5xx: the provider may or may not have started it. Say exactly that; do not retry blindly.
          this.finish(job, 'FAILED', 'SUBMIT_UNCERTAIN', 'NAgex could not confirm whether the video service started this video. Check the service account before asking again, so you are not charged twice.');
        } else {
          this.finish(job, UNAVAILABLE_CODES.has(failure.code) ? 'UNAVAILABLE' : 'FAILED', failure.code, failure.message);
        }
        return;
      }
    }
  }

  // ── decline / cancel ──────────────────────────────────────────────────────

  public decline(jobId: string, tenantId: string, ownerId: string, requestId: string): VideoJobRecord {
    const job = this.requireJob(jobId, tenantId, ownerId, requestId);
    if (job.status !== 'AWAITING_APPROVAL') {
      throw this.error('VIDEO_NOT_AWAITING_APPROVAL', 'CONFLICT', 'This video has already been started or finished, so it cannot be declined.', requestId);
    }
    try { this.deps.approvalStore.reject(job.approvalId, tenantId, ownerId, requestId); } catch { /* already expired */ }
    return this.finish(job, 'DECLINED', 'USER_DECLINED', 'You declined this video. Nothing was sent to the video service.');
  }

  public async cancel(jobId: string, tenantId: string, ownerId: string, requestId: string): Promise<{ job: VideoJobRecord; cancelled: boolean }> {
    const job = this.requireJob(jobId, tenantId, ownerId, requestId);
    if (TERMINAL_VIDEO_STATUSES.has(job.status)) return { job, cancelled: false };
    if (job.status === 'AWAITING_APPROVAL') return { job: this.decline(jobId, tenantId, ownerId, requestId), cancelled: true };
    const provider = this.providerById(job.providerId);
    if (!provider || !provider.getCapabilities().cancelQueued || !provider.cancelVideo) {
      throw this.error('CANCEL_UNSUPPORTED', 'CONFLICT', 'This video service cannot cancel a video once it has been started.', requestId);
    }
    if (job.status !== 'PENDING' || !job.providerRequestId) {
      throw this.error('CANCEL_NOT_POSSIBLE', 'CONFLICT', 'The video is already being made and can no longer be cancelled.', requestId);
    }
    try {
      const outcome = await provider.cancelVideo(job.providerRequestId);
      if (outcome === 'CANCELLED') return { job: this.finish(job, 'CANCELLED', 'USER_CANCELLED', 'You cancelled this video before it started.'), cancelled: true };
      return { job, cancelled: false };
    } catch (error) {
      const failure = asVideoProviderError(error);
      throw this.error(failure.code, 'PROVIDER', failure.message, requestId);
    }
  }

  // ── read / refresh ────────────────────────────────────────────────────────

  public get(jobId: string, tenantId: string, ownerId: string): VideoJobRecord | null {
    return this.deps.store.get(jobId, tenantId, ownerId);
  }

  public list(tenantId: string, ownerId: string, limit = 50): VideoJobRecord[] {
    return this.deps.store.list(tenantId, ownerId, limit);
  }

  /** the owner's job, brought up to date from the provider if it is due (the same step the background driver takes) */
  public async refresh(jobId: string, tenantId: string, ownerId: string): Promise<VideoJobRecord | null> {
    const job = this.deps.store.get(jobId, tenantId, ownerId);
    if (!job) return null;
    return this.advance(job);
  }

  public media(jobId: string, tenantId: string, ownerId: string): { bytes: Buffer; mimeType: string; fileName: string } | null {
    const job = this.deps.store.get(jobId, tenantId, ownerId);
    if (!job || job.status !== 'COMPLETED') return null;
    const bytes = this.deps.store.readBinary(job);
    if (!bytes || bytes.length === 0) return null;
    return { bytes, mimeType: job.mimeType || 'video/mp4', fileName: `nagex-${job.jobId}.mp4` };
  }

  public toView(job: VideoJobRecord): VideoJobView {
    const provider = this.providerById(job.providerId);
    return {
      jobId: job.jobId,
      status: job.status,
      title: job.title,
      prompt: job.prompt,
      mode: job.mode,
      durationSeconds: job.durationSeconds,
      aspectRatio: job.aspectRatio,
      estimate: job.estimate,
      serviceLabel: PROVIDER_LABELS[job.providerId] || 'the video service',
      ...(job.sourceImageId ? { sourceImageId: job.sourceImageId } : {}),
      ...(job.errorCode ? { errorCode: job.errorCode } : {}),
      ...(job.errorMessage ? { errorMessage: job.errorMessage } : {}),
      createdAt: job.createdAt,
      ...(job.submittedAt ? { submittedAt: job.submittedAt } : {}),
      ...(job.completedAt ? { completedAt: job.completedAt } : {}),
      ...(job.artifactId ? { artifactId: job.artifactId } : {}),
      ...(job.status === 'COMPLETED' ? { mediaUrl: `/api/v1/creations/videos/${job.jobId}/media`, mimeType: job.mimeType, byteLength: job.byteLength } : {}),
      cancellable: job.status === 'PENDING' && Boolean(provider?.getCapabilities().cancelQueued),
      ...(job.parentJobId ? { parentJobId: job.parentJobId } : {}),
    };
  }

  // ── the driver ────────────────────────────────────────────────────────────

  public startDriver(intervalMs = 3000): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, intervalMs);
    this.timer.unref?.();
  }

  public stopDriver(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** one pass over every unfinished job (also how a restart picks up where the previous process stopped) */
  public async tick(): Promise<void> {
    for (const job of this.deps.store.listActive()) {
      try { await this.advance(job); } catch (error) {
        console.error(JSON.stringify({ event: 'nagex_video_driver_error', jobId: job.jobId, message: error instanceof Error ? error.message : 'unknown' }));
      }
    }
  }

  private async advance(job: VideoJobRecord): Promise<VideoJobRecord> {
    if (TERMINAL_VIDEO_STATUSES.has(job.status) || this.busy.has(job.jobId)) return job;
    this.busy.add(job.jobId);
    try {
      if (job.status === 'AWAITING_APPROVAL') return this.expireIfApprovalLapsed(job);
      if (job.status === 'SUBMITTING') return await this.recoverSubmitting(job);
      return await this.pollOnce(job);
    } finally {
      this.busy.delete(job.jobId);
    }
  }

  private expireIfApprovalLapsed(job: VideoJobRecord): VideoJobRecord {
    const approval = this.deps.approvalStore.get(job.approvalId, job.tenantId, job.ownerId, 'video_expiry');
    if (!approval) {
      return this.finish(job, 'DECLINED', 'APPROVAL_LOST', 'The approval for this video was lost (NAgex restarted), so nothing was started. Ask again if you still want it.');
    }
    if (approval.status === 'EXPIRED') {
      return this.finish(job, 'DECLINED', 'APPROVAL_EXPIRED', 'The approval expired, so nothing was started. Ask again if you still want this video.');
    }
    return job;
  }

  // The process stopped between "approved" and "the provider answered". Where the provider de-duplicates by key the same submission is repeated once
  // (it cannot create a second job); otherwise NAgex does not guess - it says it cannot tell.
  private async recoverSubmitting(job: VideoJobRecord): Promise<VideoJobRecord> {
    const provider = this.providerById(job.providerId);
    if (!provider || !provider.getCapabilities().idempotentSubmit || job.submitAttempts >= 2) {
      return this.finish(job, 'FAILED', 'SUBMIT_UNCERTAIN', 'NAgex restarted while sending this video and cannot tell whether the service started it. Check the service account before asking again, so you are not charged twice.');
    }
    let sourceImage: ReturnType<VideoJobService['loadSourceImage']> | undefined;
    try {
      if (job.sourceImageId) sourceImage = this.loadSourceImage(job.sourceImageId, job.tenantId, job.ownerId, job.requestId);
    } catch {
      return this.finish(job, 'FAILED', 'IMAGE_NOT_FOUND', 'The source image is no longer available.');
    }
    job.submitAttempts += 1;
    this.deps.store.save(job);
    await this.submit(job, provider, this.specFor(job, sourceImage));
    return job;
  }

  private async pollOnce(job: VideoJobRecord): Promise<VideoJobRecord> {
    const provider = this.providerById(job.providerId);
    if (!provider || !job.providerRequestId) {
      return this.finish(job, 'FAILED', 'PROVIDER_UNAVAILABLE_ERROR', 'The video service is no longer available to check this video.');
    }
    const now = this.now();
    const submittedAt = job.submittedAt ? Date.parse(job.submittedAt) : now;
    if (now - submittedAt > this.maxWaitMs) {
      return this.finish(job, 'FAILED', 'WAIT_LIMIT_REACHED', 'The video service did not finish in the time NAgex waits. The service may still complete it - check its account; NAgex has stopped waiting.');
    }
    if (job.lastPolledAt && now < Date.parse(job.lastPolledAt) + this.nextDelayMs(job.pollCount)) return job;

    job.lastPolledAt = new Date(now).toISOString();
    job.pollCount += 1;
    try {
      const result = await provider.pollVideo(job.providerRequestId);
      job.consecutivePollFailures = 0;
      switch (result.state) {
        case 'QUEUED':
          job.status = 'PENDING';
          return this.deps.store.save(job);
        case 'RUNNING':
          job.status = 'RUNNING';
          return this.deps.store.save(job);
        case 'CANCELLED':
          return this.finish(job, 'CANCELLED', 'PROVIDER_CANCELLED', 'The video service cancelled this video.');
        case 'CONTENT_REJECTED':
          return this.finish(job, 'FAILED', 'CONTENT_REJECTED', result.errorMessage || 'The video service declined this request for content reasons.');
        case 'FAILED':
          return this.finish(job, 'FAILED', result.errorCode || 'PROVIDER_JOB_FAILED', result.errorMessage || 'The video service could not make this video.');
        case 'COMPLETED':
          return await this.complete(job, provider, result.media!);
      }
    } catch (error) {
      const failure = asVideoProviderError(error);
      job.consecutivePollFailures += 1;
      if (!failure.retryable || job.consecutivePollFailures >= 5) {
        return this.finish(job, 'FAILED', failure.code, failure.message);
      }
      return this.deps.store.save(job); // a passing outage: keep the state and try again on the next due poll
    }
    return job;
  }

  private nextDelayMs(pollCount: number): number {
    return Math.min(10_000, Math.round(2000 * Math.pow(1.5, Math.max(0, pollCount - 1))));
  }

  private async complete(job: VideoJobRecord, provider: VideoProviderPort, media: { url: string }): Promise<VideoJobRecord> {
    job.status = 'RUNNING';
    try {
      const downloaded = await provider.downloadVideo(media);
      const valid = validateMp4(downloaded.bytes);
      const storagePath = this.deps.store.saveBinary(job.jobId, valid.bytes);
      job.mimeType = valid.mimeType;
      job.byteLength = valid.byteLength;
      job.sha256 = valid.sha256;
      job.binaryStoragePath = storagePath;
      if (this.deps.artifactStore) {
        const artifact = this.deps.artifactStore.saveCompleted({
          tenantId: job.tenantId,
          ownerId: job.ownerId,
          type: 'VIDEO',
          title: job.title,
          // provider-neutral on purpose: this text reaches ordinary Recent Creations cards
          preview: `Video (${job.durationSeconds}s, ${job.aspectRatio})`,
          sourceType: 'CAPTURE',
          sourceId: job.jobId,
          openTarget: `/api/v1/creations/videos/${job.jobId}`,
        });
        job.artifactId = artifact.artifactId;
      }
      job.status = 'COMPLETED';
      job.completedAt = new Date(this.now()).toISOString();
      this.deps.store.save(job);
      this.audit('video.completed', job, 'SUCCESS', { bytes: valid.byteLength, sha256: valid.sha256 });
      return job;
    } catch (error) {
      const failure = asVideoProviderError(error, 'MEDIA_DOWNLOAD_FAILED');
      job.downloadAttempts = (job.downloadAttempts ?? 0) + 1;
      // the provider says it is done, so a transient download problem is retried on the next poll, a few times at most
      if (failure.retryable && job.downloadAttempts < 3) return this.deps.store.save(job);
      return this.finish(job, 'FAILED', failure.code === 'MEDIA_INVALID' ? 'MEDIA_INVALID' : 'MEDIA_DOWNLOAD_FAILED',
        `The video service reported the video as finished, but NAgex could not obtain a valid file: ${failure.message}`);
    }
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private finish(job: VideoJobRecord, status: VideoJobStatus, errorCode: string, errorMessage: string): VideoJobRecord {
    job.status = status;
    job.errorCode = errorCode;
    job.errorMessage = errorMessage.slice(0, 400);
    job.completedAt = new Date(this.now()).toISOString();
    this.deps.store.save(job);
    this.audit(`video.${status.toLowerCase()}`, job, status === 'DECLINED' ? 'DENIED' : 'FAILED', { errorCode });
    return job;
  }

  private requireJob(jobId: string, tenantId: string, ownerId: string, requestId: string): VideoJobRecord {
    const job = VIDEO_ID_PATTERN.test(jobId) ? this.deps.store.get(jobId, tenantId, ownerId) : null;
    if (!job) throw this.error('VIDEO_NOT_FOUND', 'NOT_FOUND', 'Video not found.', requestId);
    return job;
  }

  private loadSourceImage(imageId: string, tenantId: string, ownerId: string, requestId: string) {
    const record = this.deps.imageStore?.get(imageId, tenantId, ownerId);
    const bytes = record ? this.deps.imageStore!.getBinary(record.binaryStoragePath) : null;
    if (!record || !bytes || bytes.length === 0) throw this.error('IMAGE_NOT_FOUND', 'NOT_FOUND', 'Source image not found.', requestId);
    return { bytes, mimeType: record.mimeType, imageId: record.imageId, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  }

  private specFor(
    job: { prompt: string; durationSeconds: number; aspectRatio: string; title: string; tenantId: string; ownerId: string; requestId: string },
    sourceImage?: { bytes: Buffer; mimeType: string; imageId: string },
  ): VideoCreationSpec {
    return {
      creationKind: 'VIDEO',
      title: job.title,
      locale: detectRequestLanguage(job.prompt) === 'ko' ? 'ko' : 'en',
      tenantId: job.tenantId,
      ownerId: job.ownerId,
      requestId: job.requestId,
      totalDurationSeconds: job.durationSeconds,
      aspectRatio: job.aspectRatio as VideoCreationSpec['aspectRatio'],
      narrativeSummary: job.prompt,
      storyboard: [{ sceneId: 'scene_1', objective: 'Main scene', durationSeconds: job.durationSeconds, visualDescription: job.prompt }],
      ...(sourceImage ? { sourceImage: { bytes: sourceImage.bytes, mimeType: sourceImage.mimeType, imageId: sourceImage.imageId } } : {}),
    };
  }

  private audit(action: string, job: VideoJobRecord, result: 'SUCCESS' | 'DENIED' | 'PENDING_APPROVAL' | 'FAILED', extra: Record<string, unknown> = {}): void {
    this.deps.auditLogger?.logEvent({
      actor: { type: 'user', id: job.ownerId },
      tenant_id: job.tenantId,
      action,
      resource: { type: 'VideoJob', id: job.jobId },
      result,
      request_id: job.requestId,
      details: { provider: job.providerId, model: job.model, durationSeconds: job.durationSeconds, aspectRatio: job.aspectRatio, estimateUsd: job.estimate.usd, ...extra },
    });
  }

  private error(code: string, category: NagexError['category'], message: string, requestId: string): NagexError {
    return new NagexError({ code, category, message, request_id: requestId });
  }
}
