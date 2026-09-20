import type { ModelProviderCapabilities } from './model-routing.types.js';
import {
  ModelProviderError,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ModelUsage,
  type ProviderId,
  type ProviderRuntimeStatus,
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

  public get capabilities(): ModelProviderCapabilities {
    return {
      provider: this.name,
      supportsJsonMode: true,
      supportsGeneralChat: true,
      supportsStructuredExtraction: true,
    };
  }

  // R7 §4 — real, observed last-outcome state. Never set optimistically:
  // stays null until this instance has actually attempted a real
  // generate() call, at which point recordOutcome() below sets it from
  // that call's real success/failure, never from the mere presence of an
  // API key.
  private lastOutcome: 'success' | 'failure' | null = null;
  private lastCheckedAt: string | null = null;
  private lastFailureReason: string | null = null;

  constructor(options: ProviderOptions) {
    this.apiKey = options.apiKey?.trim() || null;
    this.model = options.model?.trim() || null;
    this.fetchFn = options.fetchFn ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  protected recordOutcome(outcome: 'success' | 'failure', failureReason: string | null): void {
    this.lastOutcome = outcome;
    this.lastCheckedAt = new Date().toISOString();
    this.lastFailureReason = outcome === 'success' ? null : failureReason;
  }

  public status(): ProviderStatus {
    const configured = Boolean(this.apiKey && this.model);
    const status: ProviderRuntimeStatus = !configured
      ? 'UNCONFIGURED'
      : this.lastOutcome === 'failure'
        ? 'DEGRADED'
        : this.lastOutcome === 'success'
          ? 'LIVE'
          : 'CONFIGURED';
    return {
      configured,
      // R7.1 root-cause fix: `available` must mean "a real call has been
      // observed to succeed", never "credentials are merely present".
      // CONFIGURED (key present, never actually tried) and DEGRADED (key
      // present, last real attempt failed) are BOTH available=false — only
      // LIVE is available=true. Configured alone must never imply available.
      available: status === 'LIVE',
      provider: this.name,
      model: this.model,
      status,
      lastCheckedAt: this.lastCheckedAt,
      degradedReason: status === 'DEGRADED' ? this.lastFailureReason : null,
    };
  }

  // R7.1 — a cheap, bounded, explicit probe so real health can be observed
  // without waiting for organic user traffic, and without GET /status
  // itself ever triggering a generation (directive: the status read must
  // stay a pure read). Reuses this provider's own real generate() path
  // (same auth/timeout/error-normalization/recordOutcome as a real
  // request) with the smallest possible real prompt — not a fake ping that
  // bypasses the actual API. A no-op for an unconfigured provider: nothing
  // to probe, status() already reports UNCONFIGURED correctly on its own.
  public async probe(): Promise<void> {
    if (!this.apiKey || !this.model) return;
    try {
      await this.generate({ messages: [{ role: 'user', content: 'ping' }], requestId: `probe_${this.name}_${Date.now()}` });
    } catch {
      // generate() already called recordOutcome('failure', ...) internally
      // (via postJson) before throwing — nothing further to do here; the
      // probe's job is only to cause a real attempt, not to propagate it.
    }
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

  // Thin wrapper around postJsonInner solely to record the real observed
  // outcome (success/failure) of this actual network attempt — the single
  // real signal status()'s LIVE/DEGRADED distinction is built on (R7 §4).
  protected async postJson(url: string, headers: Record<string, string>, body: unknown, requestId: string): Promise<unknown> {
    try {
      const result = await this.postJsonInner(url, headers, body, requestId);
      this.recordOutcome('success', null);
      return result;
    } catch (error) {
      const reason = error instanceof ModelProviderError ? error.code : 'PROVIDER_UNKNOWN_ERROR';
      this.recordOutcome('failure', reason);
      throw error;
    }
  }

  private async postJsonInner(url: string, headers: Record<string, string>, body: unknown, requestId: string): Promise<unknown> {
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

  protected response(text: string, startedAt: number, requestId: string, usage?: ModelUsage | null): ModelResponse {
    if (!text.trim()) {
      this.recordOutcome('failure', 'EMPTY_PROVIDER_RESPONSE');
      throw new ModelProviderError({ provider: this.name, code: 'EMPTY_PROVIDER_RESPONSE', message: `${this.name} returned no text.`, requestId, retryable: true });
    }
    return { text, provider: this.name, model: this.model!, latencyMs: Date.now() - startedAt, requestId, usage: usage ?? null };
  }
}

export class OpenAIProvider extends HttpModelProvider {
  public readonly name = 'openai' as const;

  public get capabilities(): ModelProviderCapabilities {
    return {
      provider: this.name,
      supportsJsonMode: false,
      supportsGeneralChat: true,
      supportsStructuredExtraction: false,
    };
  }

  public async generate(request: ModelRequest): Promise<ModelResponse> {
    const { apiKey, model } = this.assertConfigured(request.requestId);
    const startedAt = Date.now();
    const payload = await this.postJson(
      'https://api.openai.com/v1/responses',
      { Authorization: `Bearer ${apiKey}` },
      { model, input: request.messages, store: false },
      request.requestId,
    ) as { output_text?: string; output?: Array<{ content?: Array<{ type?: string; text?: string }> }>; usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number } };
    const text = payload.output_text ?? payload.output?.flatMap((item) => item.content ?? []).find((item) => item.type === 'output_text')?.text ?? '';
    const usage = payload.usage
      ? { inputTokens: payload.usage.input_tokens ?? null, outputTokens: payload.usage.output_tokens ?? null, totalTokens: payload.usage.total_tokens ?? null }
      : null;
    return this.response(text, startedAt, request.requestId, usage);
  }
}

export class GeminiProvider extends HttpModelProvider {
  public readonly name = 'gemini' as const;

  public get capabilities(): ModelProviderCapabilities {
    return {
      provider: this.name,
      supportsJsonMode: true,
      supportsGeneralChat: true,
      supportsStructuredExtraction: true,
    };
  }

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
    ) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number } };
    const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('') ?? '';
    const usage = payload.usageMetadata
      ? { inputTokens: payload.usageMetadata.promptTokenCount ?? null, outputTokens: payload.usageMetadata.candidatesTokenCount ?? null, totalTokens: payload.usageMetadata.totalTokenCount ?? null }
      : null;
    return this.response(text, startedAt, request.requestId, usage);
  }
}

export class NebiusProvider extends HttpModelProvider {
  public readonly name = 'nebius' as const;

  public get capabilities(): ModelProviderCapabilities {
    return {
      provider: this.name,
      supportsJsonMode: true,
      supportsGeneralChat: true,
      supportsStructuredExtraction: true,
    };
  }

  public async generate(request: ModelRequest): Promise<ModelResponse> {
    const { apiKey, model } = this.assertConfigured(request.requestId);
    const startedAt = Date.now();
    const payload = await this.postJson(
      'https://api.tokenfactory.nebius.com/v1/chat/completions',
      { Authorization: `Bearer ${apiKey}` },
      { model, messages: request.messages, ...(request.jsonMode ? { response_format: { type: 'json_object' } } : {}) },
      request.requestId,
    ) as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } };
    const usage = payload.usage
      ? { inputTokens: payload.usage.prompt_tokens ?? null, outputTokens: payload.usage.completion_tokens ?? null, totalTokens: payload.usage.total_tokens ?? null }
      : null;
    return this.response(payload.choices?.[0]?.message?.content ?? '', startedAt, request.requestId, usage);
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
