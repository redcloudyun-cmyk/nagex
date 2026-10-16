import http from 'node:http';
import https from 'node:https';
import type {
  ImageProviderPort,
  ImageProviderCapabilities,
  ProviderAvailabilityStatus,
  ProviderExecutionResult,
} from '../creation-provider.types.js';
import type { ImageCreationSpec } from '../../specs/creation-spec.types.js';

// Google image generation behind the NAgex ImageProviderPort.
//
// Two request shapes exist on the same Generative Language API, chosen by the model id:
//   * `imagen-*`  -> `models/<id>:predict`           (bytesBase64Encoded in `predictions`)
//   * everything else (the `gemini-*-image` family) -> `models/<id>:generateContent` (an `inlineData` part in the candidate)
// The key travels in the `x-goog-api-key` header, never in the URL, so it cannot end up in a log line or an error message.
//
// This adapter only does text-to-image. It does not claim image-to-image, editing, reference conditioning or transparent
// backgrounds because none of them is wired here; the router refuses a request that needs them instead of this adapter pretending.

export interface GoogleImageAdapterOptions {
  apiKey?: string;
  modelId?: string;
  baseUrl?: string;
  /** request timeout; image models routinely take 10-40 s */
  timeoutMs?: number;
}

const GEMINI_ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:2'];
// Imagen 3 has no 3:2
const IMAGEN_ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3'];

const DEFAULT_MODEL = 'gemini-2.5-flash-image';
const DEFAULT_TIMEOUT_MS = 60_000;

interface GoogleApiError {
  status: number;
  message: string;
  code: string;
}

interface GoogleImagePayload {
  base64: string;
  mimeType: string;
  modelVersion?: string;
}

export class GoogleImageAdapter implements ImageProviderPort {
  public readonly providerId = 'google';
  private readonly apiKey: string;
  private readonly modelId: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options?: GoogleImageAdapterOptions) {
    this.apiKey = options?.apiKey || process.env.NAGEX_GOOGLE_API_KEY || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || '';
    this.modelId = options?.modelId || process.env.NAGEX_IMAGE_GOOGLE_MODEL || DEFAULT_MODEL;
    // NAGEX_IMAGE_GOOGLE_BASE_URL is an operator setting (a proxy, a regional endpoint, a local stand-in in tests); the key is sent there, so it is never taken from a request.
    this.baseUrl = (options?.baseUrl || process.env.NAGEX_IMAGE_GOOGLE_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  public getStatus(): ProviderAvailabilityStatus {
    return this.apiKey.trim() ? 'AVAILABLE' : 'UNCONFIGURED';
  }

  public getCapabilities(): ImageProviderCapabilities {
    const imagen = this.isImagen();
    return {
      textToImage: true,
      imageToImage: false,
      editingInpainting: false,
      referenceImageConditioning: false,
      transparentBackground: false,
      // the gemini image family renders short text; Imagen 3 is unreliable at it
      textRendering: !imagen,
      supportedAspectRatios: imagen ? IMAGEN_ASPECT_RATIOS : GEMINI_ASPECT_RATIOS,
      maxReferenceImages: 0,
    };
  }

  public async generateImage(
    spec: ImageCreationSpec
  ): Promise<ProviderExecutionResult<{ imageUrl?: string; imageBuffer?: Buffer; mimeType: string }>> {
    const startTime = Date.now();
    const createdAt = new Date().toISOString();
    const metadata = (extra?: Record<string, unknown>) => ({
      providerId: this.providerId,
      engineOrModel: this.modelId,
      createdAt,
      completedAt: new Date().toISOString(),
      latencyMs: Date.now() - startTime,
      ...(extra ? { customData: extra } : {}),
    });

    if (!spec.subject || !spec.subject.trim()) {
      return {
        status: 'FAILED',
        errorCode: 'INVALID_SPEC',
        errorMessage: 'ImageCreationSpec subject is required for Google image generation.',
        metadata: metadata(),
      };
    }

    if (!this.apiKey.trim()) {
      return {
        status: 'UNAVAILABLE',
        errorCode: 'PROVIDER_UNCONFIGURED',
        errorMessage: 'Google Gemini/Imagen API key is not configured.',
        metadata: metadata(),
      };
    }

    const aspectRatio = spec.aspectRatio || '1:1';
    if (!this.getCapabilities().supportedAspectRatios.includes(aspectRatio)) {
      return {
        status: 'FAILED',
        errorCode: 'UNSUPPORTED_ASPECT_RATIO',
        errorMessage: `Google model '${this.modelId}' does not support the aspect ratio ${aspectRatio}.`,
        metadata: metadata({ aspectRatio }),
      };
    }

    // The prompt only carries what the person asked for. Words about the output (transparent background, ...) are not added: this provider
    // cannot guarantee them, and an image that ignored them would otherwise look like a fulfilled request.
    const promptParts = [spec.subject.trim()];
    if (spec.style) promptParts.push(`Style: ${spec.style}`);
    if (spec.composition) promptParts.push(`Composition: ${spec.composition}`);
    if (spec.brandContext?.brandName) promptParts.push(`Brand: ${spec.brandContext.brandName}`);
    if (spec.textRequirements?.embeddedText) promptParts.push(`Embedded Text: "${spec.textRequirements.embeddedText}"`);
    if (spec.instructions) promptParts.push(spec.instructions.trim());
    const finalPrompt = promptParts.join('. ');

    try {
      const image = await this.callGoogleApi(finalPrompt, aspectRatio);
      const imageBuffer = Buffer.from(image.base64, 'base64');
      if (imageBuffer.length === 0) {
        return {
          status: 'FAILED',
          errorCode: 'EMPTY_PROVIDER_RESULT',
          errorMessage: 'Google image API returned an empty image.',
          metadata: metadata({ aspectRatio }),
        };
      }
      return {
        status: 'COMPLETED',
        output: { imageBuffer, mimeType: image.mimeType },
        metadata: metadata({
          aspectRatio,
          ...(image.modelVersion ? { modelVersion: image.modelVersion } : {}),
        }),
      };
    } catch (error: any) {
      const apiError = error as Partial<GoogleApiError>;
      return {
        status: 'FAILED',
        errorCode: apiError?.code || 'GOOGLE_GENERATION_FAILED',
        errorMessage: apiError?.message || 'Google image generation failed.',
        metadata: metadata({ aspectRatio, ...(apiError?.status ? { httpStatus: apiError.status } : {}) }),
      };
    }
  }

  private isImagen(): boolean {
    return /^imagen/i.test(this.modelId);
  }

  private async callGoogleApi(prompt: string, aspectRatio: string): Promise<GoogleImagePayload> {
    const imagen = this.isImagen();
    const body = imagen
      ? {
          instances: [{ prompt }],
          parameters: { sampleCount: 1, aspectRatio, outputOptions: { mimeType: 'image/png' } },
        }
      : {
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          // TEXT is allowed alongside IMAGE because not every image model accepts an image-only request; a text part in the answer is ignored.
          generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio } },
        };
    const payload = JSON.stringify(body);
    const url = new URL(`${this.baseUrl}/models/${encodeURIComponent(this.modelId)}:${imagen ? 'predict' : 'generateContent'}`);
    const client = url.protocol === 'http:' ? http : https;

    return new Promise<GoogleImagePayload>((resolve, reject) => {
      const req = client.request(
        {
          hostname: url.hostname,
          port: url.port || (url.protocol === 'http:' ? 80 : 443),
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': this.apiKey,
            'Content-Length': Buffer.byteLength(payload),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const data = Buffer.concat(chunks).toString('utf8');
            if (res.statusCode && res.statusCode >= 400) return reject(this.httpError(res.statusCode, data));
            let parsed: any;
            try {
              parsed = JSON.parse(data);
            } catch (e: any) {
              return reject({ status: 502, message: `Google returned a response that is not JSON (${e?.message || 'parse error'}).`, code: 'PARSE_ERROR' } as GoogleApiError);
            }
            const found = imagen ? this.readImagen(parsed) : this.readGemini(parsed);
            if ('error' in found) return reject(found.error);
            resolve(found.image);
          });
        }
      );
      req.on('error', (err) => reject({ status: 502, message: `Could not reach Google: ${err.message}`, code: 'NETWORK_ERROR' } as GoogleApiError));
      req.setTimeout(this.timeoutMs, () => {
        req.destroy();
        reject({ status: 504, message: `Google did not answer within ${Math.round(this.timeoutMs / 1000)} seconds.`, code: 'TIMEOUT' } as GoogleApiError);
      });
      req.write(payload);
      req.end();
    });
  }

  private httpError(status: number, body: string): GoogleApiError {
    let message = `Google API error (${status})`;
    let providerStatus = '';
    try {
      const parsed = JSON.parse(body);
      if (parsed?.error?.message) message = String(parsed.error.message);
      if (parsed?.error?.status) providerStatus = String(parsed.error.status);
    } catch {
      /* keep the generic message */
    }
    // The first sentence is the reason; the rest of Google's quota text is a long list of docs links.
    const reason = message.split(/\r?\n/)[0].slice(0, 300);
    if (status === 429 || providerStatus === 'RESOURCE_EXHAUSTED') {
      return { status, code: 'PROVIDER_QUOTA_EXCEEDED', message: `The image service's quota or billing limit was reached: ${reason}` };
    }
    if (status === 401 || status === 403 || providerStatus === 'PERMISSION_DENIED' || providerStatus === 'UNAUTHENTICATED') {
      return { status, code: 'PROVIDER_AUTH_FAILED', message: `The image service rejected the credential: ${reason}` };
    }
    if (status === 400 && /safety|blocked|policy|prohibited/i.test(message)) {
      return { status, code: 'CONTENT_REJECTED', message: `Google image content rejection: ${reason}` };
    }
    if (status === 404) {
      return { status, code: 'PROVIDER_MODEL_NOT_FOUND', message: `Google does not offer the image model '${this.modelId}' for this key: ${reason}` };
    }
    if (status >= 500) {
      return { status, code: 'PROVIDER_UNAVAILABLE_ERROR', message: `The image service is temporarily unavailable (${status}): ${reason}` };
    }
    return { status, code: 'GOOGLE_API_ERROR', message: reason };
  }

  private readImagen(parsed: any): { image: GoogleImagePayload } | { error: GoogleApiError } {
    const prediction = Array.isArray(parsed?.predictions) ? parsed.predictions[0] : undefined;
    if (prediction?.bytesBase64Encoded) {
      return { image: { base64: String(prediction.bytesBase64Encoded), mimeType: String(prediction.mimeType || 'image/png') } };
    }
    if (prediction?.raiFilteredReason) {
      return { error: { status: 400, code: 'CONTENT_REJECTED', message: `Google filtered the image: ${String(prediction.raiFilteredReason).slice(0, 300)}` } };
    }
    return { error: { status: 502, code: 'EMPTY_PROVIDER_RESULT', message: 'Google Imagen returned no image data.' } };
  }

  private readGemini(parsed: any): { image: GoogleImagePayload } | { error: GoogleApiError } {
    const blocked = parsed?.promptFeedback?.blockReason;
    if (blocked) {
      return { error: { status: 400, code: 'CONTENT_REJECTED', message: `Google blocked the prompt (${String(blocked)}).` } };
    }
    const candidate = Array.isArray(parsed?.candidates) ? parsed.candidates[0] : undefined;
    const parts: any[] = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    for (const part of parts) {
      const inline = part?.inlineData || part?.inline_data;
      if (inline?.data) {
        const mimeType = String(inline.mimeType || inline.mime_type || 'image/png');
        if (!mimeType.startsWith('image/')) continue;
        return { image: { base64: String(inline.data), mimeType, modelVersion: parsed?.modelVersion ? String(parsed.modelVersion) : undefined } };
      }
    }
    const finish = String(candidate?.finishReason || '');
    if (/SAFETY|PROHIBITED|BLOCKLIST|SPII|RECITATION/i.test(finish)) {
      return { error: { status: 400, code: 'CONTENT_REJECTED', message: `Google did not return an image (${finish}).` } };
    }
    // The model answered with words only (for example it refused or asked a question). Say so rather than inventing an image.
    const text = parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join(' ').trim().slice(0, 200);
    return {
      error: {
        status: 502,
        code: 'EMPTY_PROVIDER_RESULT',
        message: text ? `Google returned text instead of an image: ${text}` : 'Google returned no image data.',
      },
    };
  }
}
