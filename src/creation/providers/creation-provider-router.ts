import { NagexError } from '../../common/errors.js';
import type {
  ImageProviderPort,
  PresentationProviderPort,
  VideoProviderPort,
  ProviderRoutingDecision,
  ImageProviderCapabilities,
  PresentationProviderCapabilities,
  VideoProviderCapabilities,
} from './creation-provider.types.js';
import type {
  ImageCreationSpec,
  PresentationCreationSpec,
  VideoCreationSpec,
} from '../specs/creation-spec.types.js';

export interface ProviderRoutingOptions {
  requestedProviderId?: string;
  privacyMode?: 'STANDARD' | 'LOCAL_ONLY';
}

export class CreationProviderRouter {
  private readonly imageProviders = new Map<string, ImageProviderPort>();
  private readonly presentationProviders = new Map<string, PresentationProviderPort>();
  private readonly videoProviders = new Map<string, VideoProviderPort>();

  // ── Registration Methods ──

  public registerImageProvider(provider: ImageProviderPort): void {
    this.imageProviders.set(provider.providerId.toLowerCase(), provider);
  }

  public registerPresentationProvider(provider: PresentationProviderPort): void {
    this.presentationProviders.set(provider.providerId.toLowerCase(), provider);
  }

  public registerVideoProvider(provider: VideoProviderPort): void {
    this.videoProviders.set(provider.providerId.toLowerCase(), provider);
  }

  // ── Image Provider Selection ──

  public selectImageProvider(
    spec: ImageCreationSpec,
    options?: ProviderRoutingOptions
  ): ProviderRoutingDecision<ImageProviderPort> {
    const requested = options?.requestedProviderId?.toLowerCase();

    // 1. Explicit provider override check
    if (requested) {
      const target = this.imageProviders.get(requested);
      if (!target) {
        throw new NagexError({
          code: 'PROVIDER_NOT_FOUND',
          category: 'PROVIDER',
          message: `Requested image provider '${options?.requestedProviderId}' is not registered.`,
          request_id: spec.requestId,
        });
      }

      const status = target.getStatus();
      if (status !== 'AVAILABLE' && status !== 'CONFIGURED' && status !== 'DEGRADED') {
        throw new NagexError({
          code: 'PROVIDER_UNAVAILABLE',
          category: 'PROVIDER',
          message: `Requested image provider '${target.providerId}' is in status ${status}.`,
          request_id: spec.requestId,
        });
      }

      // Check capability requirements on explicit override
      const caps = target.getCapabilities();
      if (spec.constraints?.transparentBackground && !caps.transparentBackground) {
        throw new NagexError({
          code: 'CAPABILITY_UNSUPPORTED',
          category: 'PROVIDER',
          message: `Requested image provider '${target.providerId}' does not support required capability 'transparentBackground'.`,
          request_id: spec.requestId,
        });
      }

      return {
        selectedProvider: target,
        reasonCode: 'EXPLICIT_PROVIDER',
        explanation: `Explicitly requested provider '${target.providerId}' selected after capability and availability validation.`,
      };
    }

    // 2. Capability & Availability search
    const candidates = Array.from(this.imageProviders.values());
    if (candidates.length === 0) {
      throw new NagexError({
        code: 'NO_CREATION_PROVIDER_AVAILABLE',
        category: 'PROVIDER',
        message: `No image creation providers are registered in runtime.`,
        request_id: spec.requestId,
      });
    }

    for (const provider of candidates) {
      const status = provider.getStatus();
      if (status === 'UNCONFIGURED' || status === 'UNAVAILABLE') continue;

      const caps = provider.getCapabilities();
      if (spec.constraints?.transparentBackground && !caps.transparentBackground) continue;
      if (spec.aspectRatio && caps.supportedAspectRatios.length > 0 && !caps.supportedAspectRatios.includes(spec.aspectRatio)) continue;

      return {
        selectedProvider: provider,
        reasonCode: 'REQUIRED_CAPABILITY',
        explanation: `Selected provider '${provider.providerId}' matching requested capabilities and availability.`,
      };
    }

    throw new NagexError({
      code: 'NO_CREATION_PROVIDER_AVAILABLE',
      category: 'PROVIDER',
      message: `No available image provider satisfies the requested capabilities or requirements.`,
      request_id: spec.requestId,
    });
  }

  // ── Presentation Provider Selection ──

  public selectPresentationProvider(
    spec: PresentationCreationSpec,
    options?: ProviderRoutingOptions
  ): ProviderRoutingDecision<PresentationProviderPort> {
    const requested = options?.requestedProviderId?.toLowerCase();

    if (requested) {
      const target = this.presentationProviders.get(requested);
      if (!target) {
        throw new NagexError({
          code: 'PROVIDER_NOT_FOUND',
          category: 'PROVIDER',
          message: `Requested presentation provider '${options?.requestedProviderId}' is not registered.`,
          request_id: spec.requestId,
        });
      }
      const status = target.getStatus();
      if (status === 'UNCONFIGURED' || status === 'UNAVAILABLE') {
        throw new NagexError({
          code: 'PROVIDER_UNAVAILABLE',
          category: 'PROVIDER',
          message: `Requested presentation provider '${target.providerId}' is ${status}.`,
          request_id: spec.requestId,
        });
      }
      return {
        selectedProvider: target,
        reasonCode: 'EXPLICIT_PROVIDER',
        explanation: `Explicitly requested presentation provider '${target.providerId}' selected.`,
      };
    }

    const available = Array.from(this.presentationProviders.values()).find(
      (p) => p.getStatus() === 'AVAILABLE' || p.getStatus() === 'CONFIGURED'
    );

    if (!available) {
      throw new NagexError({
        code: 'NO_CREATION_PROVIDER_AVAILABLE',
        category: 'PROVIDER',
        message: `No presentation creation providers are available.`,
        request_id: spec.requestId,
      });
    }

    return {
      selectedProvider: available,
      reasonCode: 'DEFAULT_PROVIDER',
      explanation: `Selected available presentation provider '${available.providerId}'.`,
    };
  }

  // ── Video Provider Selection ──

  public selectVideoProvider(
    spec: VideoCreationSpec,
    options?: ProviderRoutingOptions
  ): ProviderRoutingDecision<VideoProviderPort> {
    const requested = options?.requestedProviderId?.toLowerCase();

    if (requested) {
      const target = this.videoProviders.get(requested);
      if (!target) {
        throw new NagexError({
          code: 'PROVIDER_NOT_FOUND',
          category: 'PROVIDER',
          message: `Requested video provider '${options?.requestedProviderId}' is not registered.`,
          request_id: spec.requestId,
        });
      }
      const status = target.getStatus();
      if (status === 'UNCONFIGURED' || status === 'UNAVAILABLE') {
        throw new NagexError({
          code: 'PROVIDER_UNAVAILABLE',
          category: 'PROVIDER',
          message: `Requested video provider '${target.providerId}' is ${status}.`,
          request_id: spec.requestId,
        });
      }
      return {
        selectedProvider: target,
        reasonCode: 'EXPLICIT_PROVIDER',
        explanation: `Explicitly requested video provider '${target.providerId}' selected.`,
      };
    }

    const available = Array.from(this.videoProviders.values()).find(
      (p) => p.getStatus() === 'AVAILABLE' || p.getStatus() === 'CONFIGURED'
    );

    if (!available) {
      throw new NagexError({
        code: 'NO_CREATION_PROVIDER_AVAILABLE',
        category: 'PROVIDER',
        message: `No video creation providers are available.`,
        request_id: spec.requestId,
      });
    }

    return {
      selectedProvider: available,
      reasonCode: 'DEFAULT_PROVIDER',
      explanation: `Selected available video provider '${available.providerId}'.`,
    };
  }
}
