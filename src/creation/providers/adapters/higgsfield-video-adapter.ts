import type {
  ProviderAvailabilityStatus,
  VideoCostEstimate,
  VideoProviderCapabilities,
  VideoProviderPollResult,
  VideoProviderPort,
} from '../creation-provider.types.js';
import type { VideoCreationSpec } from '../../specs/creation-spec.types.js';
import { VideoProviderError } from '../video-provider-error.js';
import { fetchMedia, putBytes, requestJson, type JsonResponse } from '../video-http.js';
import { MAX_VIDEO_BYTES } from '../../video-media.js';
import { videoDurationOf, videoPromptOf } from '../video-prompt.js';

// Higgsfield video generation through its official REST API (https://docs.higgsfield.ai).
//
// Chosen over the hosted MCP server (mcp.higgsfield.ai) because that one is OAuth-per-person in a browser: NAgex must poll a job and fetch its result
// with nobody present, which needs a server-side credential. The REST API takes a key pair (`Authorization: Key <id>:<secret>`), is asynchronous
// (submit -> request_id -> poll -> output URL), honours an `Idempotency-Key`, offers a price estimate and a cancel while still queued.
//
// Facts used (from the official docs, read 2026-10-16):
//   submit    POST {base}/<model path>                 body: prompt, duration (3-15), aspect_ratio (16:9|9:16|1:1) | image_url (public URL)
//   estimate  POST {base}/estimate/<model path>        same body -> {"credits":"1.500","usd":"0.094"} (strings)
//   status    GET  {base}/requests/{request_id}/status -> queued | in_progress | completed | failed | nsfw | canceled; completed has video.url
//   cancel    POST {base}/requests/{request_id}/cancel -> 202 only while queued, 400 once processing started
//   upload    POST {base}/files/generate-upload-url {"content_type"} -> {public_url, upload_url, upload_headers}; PUT the bytes (no credentials) to upload_url
//   errors    401 bad credentials, 403 insufficient credits, 404 unknown model/request, 422 validation or idempotency-key reuse, 423/503 model busy, 500
//   billing   only successful requests are charged; failed and nsfw are not; outputs are kept at least 7 days
// The status URL returned by the API is NOT followed: it is rebuilt from the configured base so a credential is never sent to an address taken from a response.

export interface HiggsfieldVideoAdapterOptions {
  keyId?: string;
  keySecret?: string;
  baseUrl?: string;
  /** model family path, e.g. `kling-video/v3.0/std`; `/text-to-video` or `/image-to-video` is appended */
  modelFamily?: string;
  requestTimeoutMs?: number;
  /** tests only: allow a loopback media/upload host */
  allowLocalTestDestinations?: boolean;
}

const DEFAULT_FAMILY = 'kling-video/v3.0/std';
const MODEL_FAMILY_PATTERN = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*){1,4}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export class HiggsfieldVideoAdapter implements VideoProviderPort {
  public readonly providerId = 'higgsfield';
  private readonly keyId: string;
  private readonly keySecret: string;
  private readonly baseUrl: string;
  private readonly family: string;
  private readonly timeoutMs: number;
  private readonly allowLocal: boolean;

  constructor(options: HiggsfieldVideoAdapterOptions = {}) {
    this.keyId = (options.keyId ?? process.env.NAGEX_HIGGSFIELD_KEY_ID ?? process.env.HF_API_KEY_ID ?? '').trim();
    this.keySecret = (options.keySecret ?? process.env.NAGEX_HIGGSFIELD_KEY_SECRET ?? process.env.HF_API_KEY_SECRET ?? '').trim();
    this.baseUrl = (options.baseUrl ?? process.env.NAGEX_VIDEO_HIGGSFIELD_BASE_URL ?? 'https://api.higgsfield.ai').replace(/\/+$/, '');
    const family = (options.modelFamily ?? process.env.NAGEX_VIDEO_HIGGSFIELD_MODEL ?? DEFAULT_FAMILY).trim().replace(/^\/+|\/+$/g, '');
    // the family becomes part of a URL path: a value that is not a plain model path is ignored, not trusted
    this.family = MODEL_FAMILY_PATTERN.test(family) && !family.includes('..') ? family : DEFAULT_FAMILY;
    this.timeoutMs = options.requestTimeoutMs ?? 30_000;
    this.allowLocal = options.allowLocalTestDestinations ?? process.env.NAGEX_ALLOW_LOCAL_TEST_URLS === '1';
  }

  public getStatus(): ProviderAvailabilityStatus {
    return this.keyId && this.keySecret ? 'AVAILABLE' : 'UNCONFIGURED';
  }

  public getCapabilities(): VideoProviderCapabilities {
    return {
      textToVideo: true,
      imageToVideo: true,
      referenceVideoConditioning: false,
      audioNarration: false,
      minDurationSeconds: 3,
      maxDurationSeconds: 15,
      supportedAspectRatios: ['16:9', '9:16', '1:1'],
      cancelQueued: true,
      idempotentSubmit: true,
    };
  }

  public modelFor(spec: VideoCreationSpec): string {
    return this.modelPath(spec);
  }

  public async estimateCost(spec: VideoCreationSpec): Promise<VideoCostEstimate> {
    this.requireCredentials();
    // The estimate of an image-to-video request would need the image to be uploaded first, and nothing leaves NAgex before the person approves.
    // Image-to-video is priced per second like text-to-video, so the text-to-video quote for the same length is used and is labelled an estimate.
    const imageMode = Boolean(spec.sourceImage);
    const quotePath = imageMode ? `${this.family}/text-to-video` : this.modelPath(spec);
    const response = await this.call('POST', `/estimate/${quotePath}`, this.bodyFor(spec, undefined, true));
    const usd = Number(response.json?.usd);
    const credits = Number(response.json?.credits);
    if (!Number.isFinite(usd) || usd < 0) {
      throw new VideoProviderError('MALFORMED_RESPONSE', 'The video service returned a price that could not be read.');
    }
    return { usd, credits: Number.isFinite(credits) ? credits : null, basis: imageMode ? 'PRICE_TABLE' : 'PROVIDER_QUOTE' };
  }

  public async submitVideo(spec: VideoCreationSpec, context: { idempotencyKey: string }): Promise<{ providerRequestId: string }> {
    this.requireCredentials();
    let imageUrl: string | undefined;
    if (spec.sourceImage) imageUrl = await this.uploadImage(spec.sourceImage.bytes, spec.sourceImage.mimeType);
    const response = await this.call('POST', `/${this.modelPath(spec)}`, this.bodyFor(spec, imageUrl, false), { 'Idempotency-Key': context.idempotencyKey });
    const requestId = String(response.json?.request_id ?? '');
    if (!REQUEST_ID_PATTERN.test(requestId)) {
      throw new VideoProviderError('MALFORMED_RESPONSE', 'The video service accepted the request but returned no usable request id.');
    }
    return { providerRequestId: requestId };
  }

  public async pollVideo(providerRequestId: string): Promise<VideoProviderPollResult> {
    this.requireCredentials();
    this.requireRequestId(providerRequestId);
    const response = await this.call('GET', `/requests/${providerRequestId}/status`);
    const status = String(response.json?.status ?? '');
    switch (status) {
      case 'queued':
        return { state: 'QUEUED' };
      case 'in_progress':
        return { state: 'RUNNING' };
      case 'completed': {
        const url = response.json?.video?.url;
        if (typeof url !== 'string' || !url) {
          return { state: 'FAILED', errorCode: 'MALFORMED_RESPONSE', errorMessage: 'The video service reported the video as finished but returned no file.' };
        }
        return { state: 'COMPLETED', media: { url } };
      }
      case 'failed':
        return { state: 'FAILED', errorCode: 'PROVIDER_JOB_FAILED', errorMessage: this.shortReason(response.json?.error) || 'The video service could not make this video.' };
      case 'nsfw':
        return { state: 'CONTENT_REJECTED', errorCode: 'CONTENT_REJECTED', errorMessage: 'The video service declined this request for content reasons.' };
      case 'canceled':
        return { state: 'CANCELLED' };
      default:
        throw new VideoProviderError('MALFORMED_RESPONSE', `The video service reported a state NAgex does not know ("${status.slice(0, 40)}").`);
    }
  }

  public async cancelVideo(providerRequestId: string): Promise<'CANCELLED' | 'NOT_CANCELLABLE'> {
    this.requireCredentials();
    this.requireRequestId(providerRequestId);
    try {
      await this.call('POST', `/requests/${providerRequestId}/cancel`, undefined);
      return 'CANCELLED';
    } catch (error) {
      if (error instanceof VideoProviderError && error.httpStatus === 400) return 'NOT_CANCELLABLE';
      throw error;
    }
  }

  public async downloadVideo(media: { url: string }): Promise<{ bytes: Buffer; mimeType: string }> {
    // The output URL is public: no credential is sent to it.
    const fetched = await fetchMedia(media.url, { maxBytes: MAX_VIDEO_BYTES, timeoutMs: 180_000, allowLocalTestDestinations: this.allowLocal });
    return { bytes: fetched.bytes, mimeType: fetched.contentType.startsWith('video/') ? fetched.contentType : 'video/mp4' };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private modelPath(spec: VideoCreationSpec): string {
    return `${this.family}/${spec.sourceImage ? 'image-to-video' : 'text-to-video'}`;
  }

  private bodyFor(spec: VideoCreationSpec, imageUrl: string | undefined, forEstimate: boolean): Record<string, unknown> {
    const caps = this.getCapabilities();
    const duration = Math.min(caps.maxDurationSeconds, Math.max(caps.minDurationSeconds, videoDurationOf(spec, 5)));
    const body: Record<string, unknown> = { prompt: videoPromptOf(spec), duration };
    if (spec.sourceImage && !forEstimate) {
      // image-to-video takes its shape from the image
      body.image_url = imageUrl;
    } else {
      body.aspect_ratio = spec.aspectRatio || '16:9';
    }
    return body;
  }

  private async uploadImage(bytes: Buffer, mimeType: string): Promise<string> {
    const contentType = /^image\/(jpeg|png|webp|gif)$/.test(mimeType) ? mimeType : 'image/png';
    const slot = await this.call('POST', '/files/generate-upload-url', { content_type: contentType });
    const publicUrl = slot.json?.public_url;
    const uploadUrl = slot.json?.upload_url;
    if (typeof publicUrl !== 'string' || typeof uploadUrl !== 'string') {
      throw new VideoProviderError('MALFORMED_RESPONSE', 'The video service did not return an upload address for the image.');
    }
    const uploadHeaders: Record<string, string> = {};
    for (const [name, value] of Object.entries(slot.json?.upload_headers && typeof slot.json.upload_headers === 'object' ? slot.json.upload_headers : {})) {
      if (typeof value === 'string' && !/^(authorization|cookie|host|content-length)$/i.test(name)) uploadHeaders[name] = value;
    }
    if (!Object.keys(uploadHeaders).some((n) => n.toLowerCase() === 'content-type')) uploadHeaders['Content-Type'] = contentType;
    await putBytes(uploadUrl, bytes, uploadHeaders, { timeoutMs: 60_000, allowLocalTestDestinations: this.allowLocal });
    return publicUrl;
  }

  private requireCredentials(): void {
    if (!this.keyId || !this.keySecret) {
      throw new VideoProviderError('PROVIDER_UNCONFIGURED', 'The video service credentials are not configured.');
    }
  }

  private requireRequestId(id: string): void {
    if (!REQUEST_ID_PATTERN.test(id)) throw new VideoProviderError('MALFORMED_RESPONSE', 'The stored video request id is not valid.');
  }

  private shortReason(value: unknown): string {
    return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
  }

  private async call(method: 'GET' | 'POST', path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<JsonResponse> {
    const response = await requestJson(`${this.baseUrl}${path}`, {
      method,
      body,
      timeoutMs: this.timeoutMs,
      headers: { Authorization: `Key ${this.keyId}:${this.keySecret}`, ...extraHeaders },
    });
    if (response.status >= 200 && response.status < 300) return response;
    throw this.httpError(response);
  }

  private httpError(response: JsonResponse): VideoProviderError {
    const status = response.status;
    const detail = typeof response.json?.detail === 'string' ? response.json.detail.replace(/\s+/g, ' ').trim().slice(0, 160) : '';
    const suffix = detail ? ` (${detail})` : '';
    if (status === 401) return new VideoProviderError('PROVIDER_AUTH_FAILED', `The video service did not accept NAgex's credentials${suffix}.`, { httpStatus: status });
    if (status === 403) return new VideoProviderError('PROVIDER_INSUFFICIENT_CREDITS', `The video service refused the request - the account may be out of credit or not allowed to use this model${suffix}.`, { httpStatus: status });
    if (status === 404) return new VideoProviderError('PROVIDER_MODEL_NOT_FOUND', `The video service does not know this model or request for this account${suffix}.`, { httpStatus: status });
    if (status === 422) return new VideoProviderError('PROVIDER_REJECTED_REQUEST', `The video service rejected the request details${suffix}.`, { httpStatus: status });
    if (status === 429) return new VideoProviderError('PROVIDER_QUOTA_EXCEEDED', `The video service is rate limiting this account${suffix}.`, { httpStatus: status, retryable: true });
    if (status === 423 || status === 503) return new VideoProviderError('PROVIDER_UNAVAILABLE_ERROR', `The video model is busy or switched off right now${suffix}.`, { httpStatus: status, retryable: true });
    if (status >= 500) return new VideoProviderError('PROVIDER_UNAVAILABLE_ERROR', `The video service had an internal error (${status}).`, { httpStatus: status, retryable: true });
    return new VideoProviderError('PROVIDER_REJECTED_REQUEST', `The video service answered ${status}${suffix}.`, { httpStatus: status });
  }
}
