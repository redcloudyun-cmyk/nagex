import https from 'node:https';
import type {
  ImageProviderPort,
  ImageProviderCapabilities,
  ProviderAvailabilityStatus,
  ProviderExecutionResult,
} from '../creation-provider.types.js';
import type { ImageCreationSpec } from '../../specs/creation-spec.types.js';

export interface GoogleImageAdapterOptions {
  apiKey?: string;
  modelId?: string;
  baseUrl?: string;
}

export class GoogleImageAdapter implements ImageProviderPort {
  public readonly providerId = 'google';
  private readonly apiKey: string;
  private readonly modelId: string;
  private readonly baseUrl: string;

  constructor(options?: GoogleImageAdapterOptions) {
    this.apiKey = options?.apiKey || process.env.NAGEX_GOOGLE_API_KEY || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || '';
    this.modelId = options?.modelId || process.env.NAGEX_IMAGE_GOOGLE_MODEL || 'imagen-3.0-generate-002';
    this.baseUrl = options?.baseUrl || 'https://generativelanguage.googleapis.com/v1beta';
  }

  public getStatus(): ProviderAvailabilityStatus {
    return this.apiKey.trim() ? 'AVAILABLE' : 'UNCONFIGURED';
  }

  public getCapabilities(): ImageProviderCapabilities {
    return {
      textToImage: true,
      imageToImage: true,
      editingInpainting: true,
      referenceImageConditioning: true,
      transparentBackground: true,
      textRendering: true,
      supportedAspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2'],
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
        errorMessage: 'ImageCreationSpec subject is required for Google image generation.',
        metadata: {
          providerId: this.providerId,
          engineOrModel: this.modelId,
          createdAt,
          completedAt: new Date().toISOString(),
          latencyMs: Date.now() - startTime,
        },
      };
    }

    if (!this.apiKey.trim()) {
      return {
        status: 'UNAVAILABLE',
        errorCode: 'PROVIDER_UNCONFIGURED',
        errorMessage: 'Google Gemini/Imagen API key is not configured.',
        metadata: {
          providerId: this.providerId,
          engineOrModel: this.modelId,
          createdAt,
          completedAt: new Date().toISOString(),
          latencyMs: Date.now() - startTime,
        },
      };
    }

    // Build enhanced prompt
    const promptParts = [spec.subject.trim()];
    if (spec.style) promptParts.push(`Style: ${spec.style}`);
    if (spec.composition) promptParts.push(`Composition: ${spec.composition}`);
    if (spec.constraints?.transparentBackground) promptParts.push('Isolated subject with transparent background');
    if (spec.brandContext?.brandName) promptParts.push(`Brand: ${spec.brandContext.brandName}`);
    if (spec.textRequirements?.embeddedText) promptParts.push(`Embedded Text: "${spec.textRequirements.embeddedText}"`);
    if (spec.instructions) promptParts.push(spec.instructions.trim());

    const finalPrompt = promptParts.join('. ');
    const aspectRatio = spec.aspectRatio || '1:1';

    try {
      const b64Data = await this.callGoogleApi({
        prompt: finalPrompt,
        aspectRatio,
        model: this.modelId,
      });

      const completedAt = new Date().toISOString();
      const latencyMs = Date.now() - startTime;

      if (!b64Data) {
        return {
          status: 'FAILED',
          errorCode: 'EMPTY_PROVIDER_RESULT',
          errorMessage: 'Google Imagen API returned no image data.',
          metadata: {
            providerId: this.providerId,
            engineOrModel: this.modelId,
            createdAt,
            completedAt,
            latencyMs,
          },
        };
      }

      const imageBuffer = Buffer.from(b64Data, 'base64');

      return {
        status: 'COMPLETED',
        output: {
          imageBuffer,
          mimeType: spec.constraints?.transparentBackground ? 'image/png' : 'image/png',
        },
        metadata: {
          providerId: this.providerId,
          engineOrModel: this.modelId,
          customData: {
            aspectRatio,
            transparentBackgroundRequested: !!spec.constraints?.transparentBackground,
          },
          createdAt,
          completedAt,
          latencyMs,
        },
      };
    } catch (error: any) {
      const completedAt = new Date().toISOString();
      const latencyMs = Date.now() - startTime;

      return {
        status: 'FAILED',
        errorCode: error?.code || 'GOOGLE_GENERATION_FAILED',
        errorMessage: error?.message || 'Google image generation failed.',
        metadata: {
          providerId: this.providerId,
          engineOrModel: this.modelId,
          createdAt,
          completedAt,
          latencyMs,
        },
      };
    }
  }

  private async callGoogleApi(params: { prompt: string; aspectRatio: string; model: string }): Promise<string> {
    const payload = JSON.stringify({
      instances: [{ prompt: params.prompt }],
      parameters: {
        sampleCount: 1,
        aspectRatio: params.aspectRatio,
        outputOptions: { mimeType: 'image/png' },
      },
    });

    const url = new URL(`${this.baseUrl}/models/${params.model}:predict?key=${this.apiKey}`);
    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            let errorMsg = `Google API error (${res.statusCode})`;
            try {
              const errObj = JSON.parse(data);
              if (errObj.error?.message) errorMsg = errObj.error.message;
            } catch (_) {}
            return reject({ status: res.statusCode, message: errorMsg, code: 'GOOGLE_API_ERROR' });
          }
          try {
            const parsed = JSON.parse(data);
            if (parsed.predictions && parsed.predictions.length > 0 && parsed.predictions[0].bytesBase64Encoded) {
              return resolve(parsed.predictions[0].bytesBase64Encoded);
            }
            if (parsed.candidates && parsed.candidates.length > 0) {
              const part = parsed.candidates[0].content?.parts?.[0];
              if (part?.inlineData?.data) {
                return resolve(part.inlineData.data);
              }
            }
            reject({ status: 500, message: 'Invalid Google Imagen response format', code: 'MALFORMED_RESPONSE' });
          } catch (e: any) {
            reject({ status: 500, message: e.message, code: 'PARSE_ERROR' });
          }
        });
      });
      req.on('error', (err) => reject({ status: 500, message: err.message, code: 'NETWORK_ERROR' }));
      req.setTimeout(30000, () => {
        req.destroy();
        reject({ status: 504, message: 'Google request timed out after 30 seconds', code: 'TIMEOUT' });
      });
      req.write(payload);
      req.end();
    });
  }
}
