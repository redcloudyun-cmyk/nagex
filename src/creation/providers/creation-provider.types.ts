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
  maxDurationSeconds: number;
  supportedAspectRatios: string[];
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
  generatePresentation(spec: import('../specs/creation-spec.types.js').PresentationCreationSpec): Promise<ProviderExecutionResult<{ presentationUrl?: string; rawDeckJson?: Record<string, unknown>; mimeType: string }>>;
}

export interface VideoProviderPort {
  readonly providerId: string;
  getStatus(): ProviderAvailabilityStatus;
  getCapabilities(): VideoProviderCapabilities;
  generateVideo(spec: import('../specs/creation-spec.types.js').VideoCreationSpec): Promise<ProviderExecutionResult<{ videoUrl?: string; videoJobId?: string; mimeType: string }>>;
}

export interface ProviderRoutingDecision<TPort> {
  selectedProvider: TPort;
  reasonCode: ProviderRoutingReasonCode;
  explanation: string;
}
