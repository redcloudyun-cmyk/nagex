import http from 'node:http';
import https from 'node:https';
import type {
  ImageProviderPort,
  ImageProviderCapabilities,
  ProviderAvailabilityStatus,
  ProviderExecutionResult,
} from '../creation-provider.types.js';
import type { ImageCreationSpec } from '../../specs/creation-spec.types.js';

export interface OpenAIImageAdapterOptions {
  apiKey?: string;
  modelId?: string;
  baseUrl?: string;
}

export class OpenAIImageAdapter implements ImageProviderPort {
  public readonly providerId = 'openai';
  private readonly apiKey: string;
  private readonly modelId: string;
  private readonly baseUrl: string;

  constructor(options?: OpenAIImageAdapterOptions) {
    this.apiKey = options?.apiKey || process.env.NAGEX_OPENAI_API_KEY || process.env.OPENAI_API_KEY || '';
    this.modelId = options?.modelId || process.env.NAGEX_IMAGE_OPENAI_MODEL || 'dall-e-3';
    this.baseUrl = options?.baseUrl || 'https://api.openai.com/v1';
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
      transparentBackground: false,
      textRendering: true,
      supportedAspectRatios: ['1:1', '16:9', '9:16', '1024x1024', '1792x1024', '1024x1792'],
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
        errorMessage: 'ImageCreationSpec subject is required for OpenAI image generation.',
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
        errorMessage: 'OpenAI API key is not configured.',
        metadata: {
          providerId: this.providerId,
          engineOrModel: this.modelId,
          createdAt,
          completedAt: new Date().toISOString(),
          latencyMs: Date.now() - startTime,
        },
      };
    }

    // Build enhanced prompt from canonical spec
    const promptParts = [spec.subject.trim()];
    if (spec.style) promptParts.push(`Style: ${spec.style}`);
    if (spec.composition) promptParts.push(`Composition: ${spec.composition}`);
    if (spec.brandContext?.brandName) promptParts.push(`Brand: ${spec.brandContext.brandName}`);
    if (spec.textRequirements?.embeddedText) promptParts.push(`Embedded Text: "${spec.textRequirements.embeddedText}"`);
    if (spec.instructions) promptParts.push(spec.instructions.trim());

    const finalPrompt = promptParts.join('. ');

    let size = '1024x1024';
    if (spec.aspectRatio === '16:9') size = '1792x1024';
    if (spec.aspectRatio === '9:16') size = '1024x1792';

    try {
      const responseData = await this.callOpenAiApi({
        prompt: finalPrompt,
        size,
        model: this.modelId,
      });

      const completedAt = new Date().toISOString();
      const latencyMs = Date.now() - startTime;

      if (!responseData.b64_json && !responseData.url) {
        return {
          status: 'FAILED',
          errorCode: 'EMPTY_PROVIDER_RESULT',
          errorMessage: 'OpenAI API returned no image data.',
          metadata: {
            providerId: this.providerId,
            engineOrModel: this.modelId,
            createdAt,
            completedAt,
            latencyMs,
          },
        };
      }

      let imageBuffer: Buffer;
      if (responseData.b64_json) {
        imageBuffer = Buffer.from(responseData.b64_json, 'base64');
      } else if (responseData.url) {
        imageBuffer = await this.downloadImage(responseData.url);
      } else {
        return {
          status: 'FAILED',
          errorCode: 'MALFORMED_RESPONSE',
          errorMessage: 'OpenAI returned neither b64_json nor url.',
          metadata: {
            providerId: this.providerId,
            engineOrModel: this.modelId,
            createdAt,
            completedAt,
            latencyMs,
          },
        };
      }

      return {
        status: 'COMPLETED',
        output: {
          imageBuffer,
          mimeType: 'image/png',
        },
        metadata: {
          providerId: this.providerId,
          engineOrModel: this.modelId,
          providerJobId: responseData.revised_prompt ? `req_${Date.now()}` : undefined,
          customData: {
            revisedPrompt: responseData.revised_prompt,
            requestedSize: size,
          },
          createdAt,
          completedAt,
          latencyMs,
        },
      };
    } catch (error: any) {
      const completedAt = new Date().toISOString();
      const latencyMs = Date.now() - startTime;

      if (error?.status === 400 && error?.message?.includes('content_policy')) {
        return {
          status: 'FAILED',
          errorCode: 'CONTENT_REJECTED',
          errorMessage: `OpenAI content policy rejection: ${error.message}`,
          metadata: {
            providerId: this.providerId,
            engineOrModel: this.modelId,
            createdAt,
            completedAt,
            latencyMs,
          },
        };
      }

      return {
        status: 'FAILED',
        errorCode: error?.code || 'OPENAI_GENERATION_FAILED',
        errorMessage: error?.message || 'OpenAI image generation failed.',
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

  private async callOpenAiApi(params: { prompt: string; size: string; model: string }): Promise<{ b64_json?: string; url?: string; revised_prompt?: string }> {
    const payload = JSON.stringify({
      model: params.model,
      prompt: params.prompt,
      n: 1,
      size: params.size,
      response_format: 'b64_json',
    });

    const url = new URL(`${this.baseUrl}/images/generations`);
    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            let errorMsg = `OpenAI API error (${res.statusCode})`;
            try {
              const errObj = JSON.parse(data);
              if (errObj.error?.message) errorMsg = errObj.error.message;
            } catch (_) {}
            return reject({ status: res.statusCode, message: errorMsg, code: 'OPENAI_API_ERROR' });
          }
          try {
            const parsed = JSON.parse(data);
            if (parsed.data && parsed.data.length > 0) {
              return resolve(parsed.data[0]);
            }
            reject({ status: 500, message: 'Invalid OpenAI response format', code: 'MALFORMED_RESPONSE' });
          } catch (e: any) {
            reject({ status: 500, message: e.message, code: 'PARSE_ERROR' });
          }
        });
      });
      req.on('error', (err) => reject({ status: 500, message: err.message, code: 'NETWORK_ERROR' }));
      req.setTimeout(30000, () => {
        req.destroy();
        reject({ status: 504, message: 'OpenAI request timed out after 30 seconds', code: 'TIMEOUT' });
      });
      req.write(payload);
      req.end();
    });
  }

  private async downloadImage(urlStr: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const url = new URL(urlStr);
      const client = url.protocol === 'https:' ? https : http;
      client.get(urlStr, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }).on('error', (err) => reject(err));
    });
  }
}
