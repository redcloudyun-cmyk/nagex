import type { CreationSourceRef } from '../creation-runtime.types.js';

export type ProviderAvailabilityStatus =
  | 'UNCONFIGURED'
  | 'CONFIGURED'
  | 'AVAILABLE'
  | 'DEGRADED'
  | 'UNAVAILABLE';

export type ProviderExecutionStatus =
  | 'COMPLETED'
  | 'PENDING'
  | 'FAILED'
  | 'UNAVAILABLE';

export type ProviderRoutingReasonCode =
  | 'EXPLICIT_PROVIDER'
  | 'REQUIRED_CAPABILITY'
  | 'DEFAULT_PROVIDER'
  | 'PRIVACY_POLICY'
  | 'FORMAT_REQUIREMENT'
  | 'PROVIDER_UNAVAILABLE_FALLBACK';

export interface ProviderExecutionMetadata {
  providerId: string;
  engineOrModel?: string;
  providerJobId?: string;
  providerAssetId?: string;
  latencyMs?: number;
  createdAt: string;
  completedAt?: string;
  customData?: Record<string, unknown>;
}

export interface ProviderExecutionResult<TOutput = unknown> {
  status: ProviderExecutionStatus;
  output?: TOutput;
  metadata: ProviderExecutionMetadata;
  errorCode?: string;
  errorMessage?: string;
}

// ── Domain Capabilities Models ──

export interface ImageProviderCapabilities {
  textToImage: boolean;
  imageToImage: boolean;
  editingInpainting: boolean;
  referenceImageConditioning: boolean;
  transparentBackground: boolean;
  textRendering: boolean;
  supportedAspectRatios: string[];
  maxReferenceImages: number;
}

export interface PresentationProviderCapabilities {
  generateDeck: boolean;
  renderVisuals: boolean;
  editSlide: boolean;
  exportPdf: boolean;
  exportPptx: boolean;
  brandTemplates: boolean;
  chartRendering: boolean;
  speakerNotesSupport: boolean;
}

export interface VideoProviderCapabilities {
  textToVideo: boolean;
  imageToVideo: boolean;
  referenceVideoConditioning: boolean;
  audioNarration: boolean;
  minDurationSeconds: number;
  maxDurationSeconds: number;
  supportedAspectRatios: string[];
  /** a request that is still queued at the provider can be cancelled there */
  cancelQueued: boolean;
  /** the provider honours an idempotency key, so an ambiguous submission may be repeated without a second paid job */
  idempotentSubmit: boolean;
}

/** What the provider (or its published price list) says one clip will cost. Shown to the person BEFORE anything is submitted. */
export interface VideoCostEstimate {
  usd: number | null;
  credits: number | null;
  /** PROVIDER_QUOTE: the provider priced this exact request; PRICE_TABLE: computed from a published per-second price (an estimate, not a quote) */
  basis: 'PROVIDER_QUOTE' | 'PRICE_TABLE';
}

/** The provider's own job states, reduced to what NAgex acts on. */
export type VideoProviderJobState = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CONTENT_REJECTED' | 'CANCELLED';

export interface VideoProviderPollResult {
  state: VideoProviderJobState;
  /** present only when state is COMPLETED */
  media?: { url: string };
  errorCode?: string;
  errorMessage?: string;
}

// ── Domain Provider Ports ──

export interface ImageProviderPort {
  readonly providerId: string;
  getStatus(): ProviderAvailabilityStatus;
  getCapabilities(): ImageProviderCapabilities;
  generateImage(spec: import('../specs/creation-spec.types.js').ImageCreationSpec): Promise<ProviderExecutionResult<{ imageUrl?: string; imageBuffer?: Buffer; mimeType: string }>>;
}

export interface PresentationProviderPort {
  readonly providerId: string;
  getStatus(): ProviderAvailabilityStatus;
  getCapabilities(): PresentationProviderCapabilities;
  generatePresentation(spec: import('../specs/creation-spec.types.js').PresentationCreationSpec): Promise<ProviderExecutionResult<{ presentationUrl?: string; presentationBuffer?: Buffer; rawDeckJson?: Record<string, unknown>; mimeType: string }>>;
}

// A video is an asynchronous, paid job: it is priced, submitted, polled and only then downloaded. The port says so instead of pretending to
// be one blocking call. Methods throw VideoProviderError (video-provider-error.ts) with a stable code; nothing here returns a fake success.
export interface VideoProviderPort {
  readonly providerId: string;
  getStatus(): ProviderAvailabilityStatus;
  getCapabilities(): VideoProviderCapabilities;
  /** the model the given spec would run on (recorded with the job and shown in the approval) */
  modelFor(spec: import('../specs/creation-spec.types.js').VideoCreationSpec): string;
  estimateCost(spec: import('../specs/creation-spec.types.js').VideoCreationSpec): Promise<VideoCostEstimate>;
  /** starts the paid job; `idempotencyKey` is stable per NAgex job so a repeated call cannot start a second one where the provider supports it */
  submitVideo(spec: import('../specs/creation-spec.types.js').VideoCreationSpec, context: { idempotencyKey: string }): Promise<{ providerRequestId: string }>;
  pollVideo(providerRequestId: string): Promise<VideoProviderPollResult>;
  /** only present when capabilities().cancelQueued */
  cancelVideo?(providerRequestId: string): Promise<'CANCELLED' | 'NOT_CANCELLABLE'>;
  downloadVideo(media: { url: string }): Promise<{ bytes: Buffer; mimeType: string }>;
}

export interface ProviderRoutingDecision<TPort> {
  selectedProvider: TPort;
  reasonCode: ProviderRoutingReasonCode;
  explanation: string;
}
