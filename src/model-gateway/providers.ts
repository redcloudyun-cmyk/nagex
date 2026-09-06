import {
  ModelProviderError,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ProviderId,
  type ProviderStatus,
} from './model-provider.js';

type FetchFn = typeof fetch;

interface ProviderOptions {
  apiKey?: string;
  model?: string;
  fetchFn?: FetchFn;
  timeoutMs?: number;
}

abstract class HttpModelProvider implements ModelProvider {
  public abstract readonly name: ProviderId;
  public readonly model: string | null;
  protected readonly apiKey: string | null;
  protected readonly fetchFn: FetchFn;
  protected readonly timeoutMs: number;

  constructor(options: ProviderOptions) {
    this.apiKey = options.apiKey?.trim() || null;
    this.model = options.model?.trim() || null;
    this.fetchFn = options.fetchFn ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  public status(): ProviderStatus {
    const configured = Boolean(this.apiKey && this.model);
    return { configured, available: configured, provider: this.name, model: this.model };
  }

  protected assertConfigured(requestId: string): { apiKey: string; model: string } {
    if (!this.apiKey || !this.model) {
      throw new ModelProviderError({
        provider: this.name,
        code: 'PROVIDER_NOT_CONFIGURED',
        message: `${this.name} provider is not configured.`,
        requestId,
        retryable: false,
      });
    }
    return { apiKey: this.apiKey, model: this.model };
  }

  protected async postJson(url: string, headers: Record<string, string>, body: unknown, requestId: string): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const category = response.status === 401 || response.status === 403
          ? 'AUTHENTICATION'
          : response.status === 429
            ? 'RATE_LIMIT'
            : 'PROVIDER';
        throw new ModelProviderError({
          provider: this.name,
          code: `PROVIDER_HTTP_${response.status}`,
          message: `${this.name} request failed with HTTP ${response.status}.`,
          requestId,
          category,
          retryable: response.status === 408 || response.status === 429 || response.status >= 500,
        });
      }
      return await response.json();
    } catch (error) {
      if (error instanceof ModelProviderError) throw error;
      if (controller.signal.aborted) {
        throw new ModelProviderError({
          provider: this.name,
          code: 'PROVIDER_TIMEOUT',
          message: `${this.name} request timed out.`,
          requestId,
          category: 'TIMEOUT',
          retryable: true,
        });
      }
      throw new ModelProviderError({
        provider: this.name,
        code: 'PROVIDER_NETWORK_ERROR',
        message: `${this.name} request failed.`,
        requestId,
        retryable: true,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  public abstract generate(request: ModelRequest): Promise<ModelResponse>;

  protected response(text: string, startedAt: number, requestId: string): ModelResponse {
    if (!text.trim()) {
      throw new ModelProviderError({ provider: this.name, code: 'EMPTY_PROVIDER_RESPONSE', message: `${this.name} returned no text.`, requestId, retryable: true });
    }
    return { text, provider: this.name, model: this.model!, latencyMs: Date.now() - startedAt, requestId };
  }
}

export class OpenAIProvider extends HttpModelProvider {
  public readonly name = 'openai' as const;

  public async generate(request: ModelRequest): Promise<ModelResponse> {
    const { apiKey, model } = this.assertConfigured(request.requestId);
    const startedAt = Date.now();
    const payload = await this.postJson(
      'https://api.openai.com/v1/responses',
      { Authorization: `Bearer ${apiKey}` },
      { model, input: request.messages, store: false },
      request.requestId,
    ) as { output_text?: string; output?: Array<{ content?: Array<{ type?: string; text?: string }> }> };
    const text = payload.output_text ?? payload.output?.flatMap((item) => item.content ?? []).find((item) => item.type === 'output_text')?.text ?? '';
    return this.response(text, startedAt, request.requestId);
  }
}

export class GeminiProvider extends HttpModelProvider {
  public readonly name = 'gemini' as const;

  public async generate(request: ModelRequest): Promise<ModelResponse> {
    const { apiKey, model } = this.assertConfigured(request.requestId);
    const startedAt = Date.now();
    const system = request.messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n');
    const contents = request.messages.filter((message) => message.role !== 'system').map((message) => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: message.content }],
    }));
    const payload = await this.postJson(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      { 'x-goog-api-key': apiKey },
      {
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        contents,
        ...(request.jsonMode ? { generationConfig: { responseMimeType: 'application/json' } } : {}),
      },
      request.requestId,
    ) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('') ?? '';
    return this.response(text, startedAt, request.requestId);
  }
}

export class NebiusProvider extends HttpModelProvider {
  public readonly name = 'nebius' as const;

  public async generate(request: ModelRequest): Promise<ModelResponse> {
    const { apiKey, model } = this.assertConfigured(request.requestId);
    const startedAt = Date.now();
    const payload = await this.postJson(
      'https://api.tokenfactory.nebius.com/v1/chat/completions',
      { Authorization: `Bearer ${apiKey}` },
      { model, messages: request.messages, ...(request.jsonMode ? { response_format: { type: 'json_object' } } : {}) },
      request.requestId,
    ) as { choices?: Array<{ message?: { content?: string } }> };
    return this.response(payload.choices?.[0]?.message?.content ?? '', startedAt, request.requestId);
  }
}

export function createProviders(env: NodeJS.ProcessEnv = process.env, fetchFn?: FetchFn, timeoutMs?: number): ModelProvider[] {
  const providers = [
    new OpenAIProvider({ apiKey: env.OPENAI_API_KEY, model: env.NAGEX_OPENAI_MODEL, fetchFn, timeoutMs }),
    new GeminiProvider({ apiKey: env.GEMINI_API_KEY, model: env.NAGEX_GEMINI_MODEL, fetchFn, timeoutMs }),
    new NebiusProvider({ apiKey: env.NEBIUS_API_KEY, model: env.NAGEX_NEBIUS_MODEL, fetchFn, timeoutMs }),
  ];
  const byName = new Map<string, ModelProvider>(providers.map((provider) => [provider.name, provider]));
  const configuredPriority = (env.NAGEX_PROVIDER_PRIORITY || 'nebius,openai,gemini')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  return [
    ...configuredPriority.map((name) => byName.get(name)).filter((provider): provider is ModelProvider => Boolean(provider)),
    ...providers.filter((provider) => !configuredPriority.includes(provider.name)),
  ];
}
