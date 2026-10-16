import type {
  ProviderAvailabilityStatus,
  VideoCostEstimate,
  VideoProviderCapabilities,
  VideoProviderPollResult,
  VideoProviderPort,
} from '../creation-provider.types.js';
import type { VideoCreationSpec } from '../../specs/creation-spec.types.js';
import { VideoProviderError } from '../video-provider-error.js';
import { fetchMedia, requestJson, type JsonResponse } from '../video-http.js';
import { MAX_VIDEO_BYTES } from '../../video-media.js';
import { videoDurationOf, videoPromptOf } from '../video-prompt.js';

// Google Veo video generation through the Gemini API (https://ai.google.dev/gemini-api/docs/video).
//
// Facts used (official docs, read 2026-10-16):
//   submit   POST {base}/models/<model>:predictLongRunning        header x-goog-api-key
//            body {"instances":[{"prompt":"...","image":{"inlineData":{"mimeType","data"}}}],"parameters":{"aspectRatio","durationSeconds","resolution"}}
//   poll     GET  {base}/<operation name>  -> {"done":bool, "response":{"generateVideoResponse":{"generatedSamples":[{"video":{"uri"}}]}}} | {"error":{...}}
//   download GET the uri with the same header (redirects are followed by the downloader); generated videos are deleted after 2 days
//   price    per second of video, paid tier only (no free tier for any Veo 3.1 model): see PRICE_PER_SECOND_USD
//
// A Gemini text key does NOT by itself mean Veo is usable (it is paid and billing-gated), so this provider reports UNCONFIGURED until the operator
// states that the project has Veo access (NAGEX_VEO_ENABLED=1). Without that NAgex never offers a video it cannot make.

export interface VeoVideoAdapterOptions {
  apiKey?: string;
  enabled?: boolean;
  modelId?: string;
  baseUrl?: string;
  resolution?: '720p' | '1080p';
  requestTimeoutMs?: number;
  allowLocalTestDestinations?: boolean;
}

// USD per second of generated video at 720p / 1080p (the published paid-tier list price, 2026-10-16). A model that is not here has no estimate and cannot be offered.
const PRICE_PER_SECOND_USD: Record<string, { '720p': number; '1080p': number }> = {
  'veo-3.1-generate-preview': { '720p': 0.4, '1080p': 0.4 },
  'veo-3.1-fast-generate-preview': { '720p': 0.1, '1080p': 0.12 },
  'veo-3.1-lite-generate-preview': { '720p': 0.05, '1080p': 0.08 },
};

const ALLOWED_DURATIONS = [4, 6, 8];
const DEFAULT_MODEL = 'veo-3.1-lite-generate-preview';
const MODEL_PATTERN = /^veo-[a-z0-9.-]{2,60}$/;
const OPERATION_PATTERN = /^(models\/[A-Za-z0-9._-]+\/)?operations\/[A-Za-z0-9._-]+$/;

export class VeoVideoAdapter implements VideoProviderPort {
  public readonly providerId = 'google-veo';
  private readonly apiKey: string;
  private readonly enabled: boolean;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly resolution: '720p' | '1080p';
  private readonly timeoutMs: number;
  private readonly allowLocal: boolean;

  constructor(options: VeoVideoAdapterOptions = {}) {
    this.apiKey = (options.apiKey ?? process.env.NAGEX_GOOGLE_API_KEY ?? process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY ?? '').trim();
    this.enabled = options.enabled ?? /^(1|true|yes)$/i.test(process.env.NAGEX_VEO_ENABLED || '');
    const model = (options.modelId ?? process.env.NAGEX_VIDEO_VEO_MODEL ?? DEFAULT_MODEL).trim();
    this.model = MODEL_PATTERN.test(model) ? model : DEFAULT_MODEL;
    this.baseUrl = (options.baseUrl ?? process.env.NAGEX_VIDEO_VEO_BASE_URL ?? 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
    this.resolution = options.resolution ?? '720p';
    this.timeoutMs = options.requestTimeoutMs ?? 30_000;
    this.allowLocal = options.allowLocalTestDestinations ?? process.env.NAGEX_ALLOW_LOCAL_TEST_URLS === '1';
  }

  public getStatus(): ProviderAvailabilityStatus {
    return this.apiKey && this.enabled ? 'AVAILABLE' : 'UNCONFIGURED';
  }

  public getCapabilities(): VideoProviderCapabilities {
    return {
      textToVideo: true,
      imageToVideo: true,
      referenceVideoConditioning: false,
      audioNarration: false,
      minDurationSeconds: ALLOWED_DURATIONS[0],
      maxDurationSeconds: ALLOWED_DURATIONS[ALLOWED_DURATIONS.length - 1],
      supportedAspectRatios: ['16:9', '9:16'],
      cancelQueued: false,
      idempotentSubmit: false,
    };
  }

  public modelFor(): string {
    return this.model;
  }

  public async estimateCost(spec: VideoCreationSpec): Promise<VideoCostEstimate> {
    const price = PRICE_PER_SECOND_USD[this.model];
    if (!price) {
      throw new VideoProviderError('UNSUPPORTED_REQUEST', `There is no published price for the video model "${this.model}", so a cost cannot be shown and it will not be offered.`);
    }
    const seconds = this.durationFor(spec);
    return { usd: Math.round(price[this.resolution] * seconds * 100) / 100, credits: null, basis: 'PRICE_TABLE' };
  }

  public async submitVideo(spec: VideoCreationSpec): Promise<{ providerRequestId: string }> {
    this.requireReady();
    const instance: Record<string, unknown> = { prompt: videoPromptOf(spec) };
    if (spec.sourceImage) {
      instance.image = { inlineData: { mimeType: spec.sourceImage.mimeType, data: spec.sourceImage.bytes.toString('base64') } };
    }
    const response = await this.call('POST', `/models/${this.model}:predictLongRunning`, {
      instances: [instance],
      parameters: {
        aspectRatio: spec.aspectRatio === '9:16' ? '9:16' : '16:9',
        durationSeconds: String(this.durationFor(spec)),
        resolution: this.resolution,
      },
    });
    const name = String(response.json?.name ?? '');
    if (!OPERATION_PATTERN.test(name)) {
      throw new VideoProviderError('MALFORMED_RESPONSE', 'Google accepted the request but returned no usable operation name.');
    }
    return { providerRequestId: name };
  }

  public async pollVideo(providerRequestId: string): Promise<VideoProviderPollResult> {
    this.requireReady();
    if (!OPERATION_PATTERN.test(providerRequestId)) throw new VideoProviderError('MALFORMED_RESPONSE', 'The stored operation name is not valid.');
    const response = await this.call('GET', `/${providerRequestId}`);
    const body = response.json;
    if (!body || typeof body !== 'object') throw new VideoProviderError('MALFORMED_RESPONSE', 'Google returned an unreadable operation state.');
    if (body.done !== true) return { state: 'RUNNING' };
    if (body.error) {
      const message = String(body.error.message || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      if (/safety|blocked|policy|prohibited|filtered/i.test(message)) return { state: 'CONTENT_REJECTED', errorCode: 'CONTENT_REJECTED', errorMessage: message };
      return { state: 'FAILED', errorCode: 'PROVIDER_JOB_FAILED', errorMessage: message || 'Google could not make this video.' };
    }
    const generated = body.response?.generateVideoResponse;
    const uri = generated?.generatedSamples?.[0]?.video?.uri;
    if (typeof uri === 'string' && uri) return { state: 'COMPLETED', media: { url: uri } };
    if (Number(generated?.raiMediaFilteredCount) > 0) {
      const reason = Array.isArray(generated?.raiMediaFilteredReasons) ? String(generated.raiMediaFilteredReasons[0] || '').slice(0, 160) : '';
      return { state: 'CONTENT_REJECTED', errorCode: 'CONTENT_REJECTED', errorMessage: reason || 'Google filtered the video for safety reasons.' };
    }
    return { state: 'FAILED', errorCode: 'MALFORMED_RESPONSE', errorMessage: 'Google reported the operation finished but returned no video.' };
  }

  public async downloadVideo(media: { url: string }): Promise<{ bytes: Buffer; mimeType: string }> {
    this.requireReady();
    let target: URL;
    try { target = new URL(media.url); } catch { throw new VideoProviderError('MEDIA_DOWNLOAD_FAILED', 'The video address from Google is not a valid address.'); }
    // The key is sent only to the Google API host the job was created on, never to any other address.
    if (target.host !== new URL(this.baseUrl).host) {
      throw new VideoProviderError('MEDIA_DOWNLOAD_FAILED', 'The video address is not on the Google API host, so it was not downloaded.');
    }
    const fetched = await fetchMedia(media.url, {
      headers: { 'x-goog-api-key': this.apiKey },
      maxBytes: MAX_VIDEO_BYTES,
      timeoutMs: 180_000,
      allowLocalTestDestinations: this.allowLocal,
    });
    return { bytes: fetched.bytes, mimeType: fetched.contentType.startsWith('video/') ? fetched.contentType : 'video/mp4' };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private durationFor(spec: VideoCreationSpec): number {
    const wanted = videoDurationOf(spec, 8);
    return ALLOWED_DURATIONS.reduce((best, d) => (Math.abs(d - wanted) < Math.abs(best - wanted) ? d : best), ALLOWED_DURATIONS[0]);
  }

  private requireReady(): void {
    if (!this.apiKey) throw new VideoProviderError('PROVIDER_UNCONFIGURED', 'No Google API key is configured.');
    if (!this.enabled) throw new VideoProviderError('PROVIDER_UNCONFIGURED', 'Google video generation has not been enabled for this NAgex installation.');
  }

  private async call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<JsonResponse> {
    const response = await requestJson(`${this.baseUrl}${path}`, {
      method,
      body,
      timeoutMs: this.timeoutMs,
      headers: { 'x-goog-api-key': this.apiKey },
    });
    if (response.status >= 200 && response.status < 300) return response;
    throw this.httpError(response);
  }

  private httpError(response: JsonResponse): VideoProviderError {
    const status = response.status;
    const providerStatus = String(response.json?.error?.status || '');
    const message = String(response.json?.error?.message || '').split(/\r?\n/)[0].replace(/\s+/g, ' ').trim().slice(0, 240);
    const suffix = message ? `: ${message}` : '';
    if (status === 429 || providerStatus === 'RESOURCE_EXHAUSTED') {
      return new VideoProviderError('PROVIDER_QUOTA_EXCEEDED', `Google's video quota or billing limit was reached${suffix}`, { httpStatus: status });
    }
    if (/billing|paid tier|free tier|not available on the free|upgrade/i.test(message) || providerStatus === 'FAILED_PRECONDITION') {
      return new VideoProviderError('PROVIDER_BILLING_REQUIRED', `Google requires a paid (billing-enabled) project for video generation${suffix}`, { httpStatus: status });
    }
    if (status === 401 || status === 403 || providerStatus === 'PERMISSION_DENIED' || providerStatus === 'UNAUTHENTICATED') {
      return new VideoProviderError('PROVIDER_AUTH_FAILED', `Google did not accept the credential for video generation${suffix}`, { httpStatus: status });
    }
    if (status === 404) return new VideoProviderError('PROVIDER_MODEL_NOT_FOUND', `Google does not offer the video model "${this.model}" for this key${suffix}`, { httpStatus: status });
    if (status === 400 && /safety|blocked|policy|prohibited/i.test(message)) return new VideoProviderError('CONTENT_REJECTED', `Google declined the request for content reasons${suffix}`, { httpStatus: status });
    if (status >= 500) return new VideoProviderError('PROVIDER_UNAVAILABLE_ERROR', `Google's video service is temporarily unavailable (${status})${suffix}`, { httpStatus: status, retryable: true });
    return new VideoProviderError('PROVIDER_REJECTED_REQUEST', `Google rejected the video request (${status})${suffix}`, { httpStatus: status });
  }
}
