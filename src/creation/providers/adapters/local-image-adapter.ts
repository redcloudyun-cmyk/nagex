import http from 'node:http';
import type {
  ImageProviderPort,
  ImageProviderCapabilities,
  ProviderAvailabilityStatus,
  ProviderExecutionResult,
} from '../creation-provider.types.js';
import type { ImageCreationSpec } from '../../specs/creation-spec.types.js';

export class LocalImageAdapter implements ImageProviderPort {
  public readonly providerId = 'local-gpu';
  private readonly endpointUrl: string;

  constructor(endpointUrl?: string) {
    this.endpointUrl = endpointUrl || process.env.NAGEX_LOCAL_IMAGE_ENDPOINT || 'http://127.0.0.1:7860/sdapi/v1/txt2img';
  }

  public getStatus(): ProviderAvailabilityStatus {
    return process.env.NAGEX_LOCAL_IMAGE_ENDPOINT ? 'AVAILABLE' : 'UNCONFIGURED';
  }

  public getCapabilities(): ImageProviderCapabilities {
    return {
      textToImage: true,
      imageToImage: true,
      editingInpainting: true,
      referenceImageConditioning: true,
      transparentBackground: true,
      textRendering: false,
      supportedAspectRatios: ['1:1', '16:9', '9:16', '512x512', '768x512', '512x768'],
      maxReferenceImages: 1,
    };
  }

  public async generateImage(
    spec: ImageCreationSpec
  ): Promise<ProviderExecutionResult<{ imageUrl?: string; imageBuffer?: Buffer; mimeType: string }>> {
    const startTime = Date.now();
    const createdAt = new Date().toISOString();

    if (!spec.subject || !spec.subject.trim()) {
      return {
        status: 'FAILED',
        errorCode: 'INVALID_SPEC',
        errorMessage: 'ImageCreationSpec subject is required for local GPU image generation.',
        metadata: {
          providerId: this.providerId,
          engineOrModel: 'local-sd',
          createdAt,
          completedAt: new Date().toISOString(),
          latencyMs: Date.now() - startTime,
        },
      };
    }

    return {
      status: 'UNAVAILABLE',
      errorCode: 'LOCAL_GPU_UNCONFIGURED',
      errorMessage: 'Local GPU image generation endpoint is not active.',
      metadata: {
        providerId: this.providerId,
        engineOrModel: 'local-sd',
        createdAt,
        completedAt: new Date().toISOString(),
        latencyMs: Date.now() - startTime,
      },
    };
  }
}
