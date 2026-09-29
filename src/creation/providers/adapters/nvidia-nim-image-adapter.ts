import https from 'node:https';
import http from 'node:http';
import type {
  ImageProviderPort,
  ImageProviderCapabilities,
  ProviderAvailabilityStatus,
  ProviderExecutionResult,
} from '../creation-provider.types.js';
import type { ImageCreationSpec } from '../../specs/creation-spec.types.js';

export interface NvidiaNimImageAdapterOptions {
  apiKey?: string;
  modelId?: string;
  endpointUrl?: string;
}

export class NvidiaNimImageAdapter implements ImageProviderPort {
  public readonly providerId = 'nvidia-nim';
  private readonly apiKey: string;
  private readonly modelId: string;
  private readonly endpointUrl: string;

  constructor(options?: NvidiaNimImageAdapterOptions) {
    this.apiKey = options?.apiKey || process.env.NAGEX_NIM_API_KEY || process.env.NVIDIA_API_KEY || '';
    this.modelId = options?.modelId || process.env.NAGEX_IMAGE_NIM_MODEL || 'black-forest-labs/flux-1-dev';
    this.endpointUrl = options?.endpointUrl || process.env.NAGEX_NIM_IMAGE_ENDPOINT || 'https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux-1-dev';
  }

  public getStatus(): ProviderAvailabilityStatus {
    return this.apiKey.trim() || process.env.NAGEX_NIM_IMAGE_ENDPOINT ? 'AVAILABLE' : 'UNCONFIGURED';
  }

  public getCapabilities(): ImageProviderCapabilities {
    return {
      textToImage: true,
      imageToImage: true,
      editingInpainting: true,
      referenceImageConditioning: true,
      transparentBackground: true,
      textRendering: true,
      supportedAspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:2'],
      maxReferenceImages: 2,
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
        errorMessage: 'ImageCreationSpec subject is required for NVIDIA NIM generation.',
        metadata: {
          providerId: this.providerId,
          engineOrModel: this.modelId,
          createdAt,
          completedAt: new Date().toISOString(),
          latencyMs: Date.now() - startTime,
        },
      };
    }

    if (this.getStatus() === 'UNCONFIGURED') {
      return {
        status: 'UNAVAILABLE',
        errorCode: 'PROVIDER_UNCONFIGURED',
        errorMessage: 'NVIDIA NIM endpoint or API key is not configured.',
        metadata: {
          providerId: this.providerId,
          engineOrModel: this.modelId,
          createdAt,
          completedAt: new Date().toISOString(),
          latencyMs: Date.now() - startTime,
        },
      };
    }

    const finalPrompt = [spec.subject.trim(), spec.style, spec.composition, spec.instructions]
      .filter(Boolean)
      .join('. ');

    try {
      const b64Data = await this.callNimApi(finalPrompt, spec.aspectRatio || '1:1');
      const completedAt = new Date().toISOString();
      const latencyMs = Date.now() - startTime;

      return {
        status: 'COMPLETED',
        output: {
          imageBuffer: Buffer.from(b64Data, 'base64'),
          mimeType: 'image/png',
        },
        metadata: {
          providerId: this.providerId,
          engineOrModel: this.modelId,
          createdAt,
          completedAt,
          latencyMs,
        },
      };
    } catch (error: any) {
      return {
        status: 'FAILED',
        errorCode: error?.code || 'NIM_GENERATION_FAILED',
        errorMessage: error?.message || 'NVIDIA NIM image generation failed.',
        metadata: {
          providerId: this.providerId,
          engineOrModel: this.modelId,
          createdAt,
          completedAt: new Date().toISOString(),
          latencyMs: Date.now() - startTime,
        },
      };
    }
  }

  private async callNimApi(prompt: string, aspectRatio: string): Promise<string> {
    const payload = JSON.stringify({
      prompt,
      aspect_ratio: aspectRatio,
      mode: 'text-to-image',
    });

    const url = new URL(this.endpointUrl);
    const client = url.protocol === 'https:' ? https : http;

    return new Promise((resolve, reject) => {
      const req = client.request(
        {
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: `${url.pathname}${url.search}`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(this.apiKey ? { 'Authorization': `Bearer ${this.apiKey}` } : {}),
            'Content-Length': Buffer.byteLength(payload),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 400) {
              return reject({ status: res.statusCode, message: `NVIDIA NIM API error (${res.statusCode}): ${data}`, code: 'NIM_API_ERROR' });
            }
            try {
              const parsed = JSON.parse(data);
              if (parsed.artifacts && parsed.artifacts[0]?.base64) {
                return resolve(parsed.artifacts[0].base64);
              }
              if (parsed.b64_json) return resolve(parsed.b64_json);
              reject({ status: 500, message: 'Invalid NVIDIA NIM response format', code: 'MALFORMED_RESPONSE' });
            } catch (e: any) {
              reject({ status: 500, message: e.message, code: 'PARSE_ERROR' });
            }
          });
        }
      );
      req.on('error', (err) => reject({ status: 500, message: err.message, code: 'NETWORK_ERROR' }));
      req.setTimeout(30000, () => {
        req.destroy();
        reject({ status: 504, message: 'NVIDIA NIM request timed out', code: 'TIMEOUT' });
      });
      req.write(payload);
      req.end();
    });
  }
}
