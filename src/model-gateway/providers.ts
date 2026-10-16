import type { ModelProviderCapabilities, ModelTaskKind } from './model-routing.types.js';
import {
  ModelProviderError,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ModelResponseMeta,
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
  // How long a provider whose last call failed stays deprioritized before it may be tried again (default 60 s, bounded 1 s - 10 min).
  degradedCooldownMs?: number;
  now?: () => number;
}

export const DEFAULT_DEGRADED_COOLDOWN_MS = 60_000;
export function readDegradedCooldownMs(env: NodeJS.ProcessEnv): number {
  const raw = Number(env.NAGEX_PROVIDER_DEGRADED_COOLDOWN_MS);
  return Number.isFinite(raw) && raw >= 1_000 && raw <= 600_000 ? Math.floor(raw) : DEFAULT_DEGRADED_COOLDOWN_MS;
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
  private lastCheckedAtMs = 0;
  private lastFailureReason: string | null = null;
  private readonly degradedCooldownMs: number;
  private readonly clock: () => number;

  constructor(options: ProviderOptions) {
    this.degradedCooldownMs = options.degradedCooldownMs !== undefined && options.degradedCooldownMs >= 0 ? options.degradedCooldownMs : DEFAULT_DEGRADED_COOLDOWN_MS;
    this.clock = options.now ?? (() => Date.now());
    this.apiKey = options.apiKey?.trim() || null;
    this.model = options.model?.trim() || null;
    this.fetchFn = options.fetchFn ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  protected recordOutcome(outcome: 'success' | 'failure', failureReason: string | null): void {
    this.lastOutcome = outcome;
    this.lastCheckedAtMs = this.clock();
    this.lastCheckedAt = new Date(this.lastCheckedAtMs).toISOString();
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
      // A failed provider is retried after the cool-down: the failure was one real observation, not a verdict that lasts until restart.
      retryEligible: status === 'DEGRADED' && this.clock() - this.lastCheckedAtMs >= this.degradedCooldownMs,
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
  protected async postJson(url: string, headers: Record<string, string>, body: unknown, requestId: string, timeoutMs?: number): Promise<unknown> {
    return (await this.postJsonDetailed(url, headers, body, requestId, timeoutMs)).payload;
  }

  // Same as postJson, additionally returning the response headers (for a provider's request id). The request headers —
  // which carry the credential — are never returned, stored or logged.
  protected async postJsonDetailed(url: string, headers: Record<string, string>, body: unknown, requestId: string, timeoutMs?: number): Promise<{ payload: unknown; responseHeaders: Headers | undefined }> {
    try {
      const result = await this.postJsonInner(url, headers, body, requestId, timeoutMs);
      this.recordOutcome('success', null);
      return result;
    } catch (error) {
      const reason = error instanceof ModelProviderError ? error.code : 'PROVIDER_UNKNOWN_ERROR';
      this.recordOutcome('failure', reason);
      throw error;
    }
  }

  private async postJsonInner(url: string, headers: Record<string, string>, body: unknown, requestId: string, timeoutOverrideMs?: number): Promise<{ payload: unknown; responseHeaders: Headers | undefined }> {
    const controller = new AbortController();
    // a request may ask for longer than the provider's default (a whole website's files), but never for unbounded: 1 second to 5 minutes
    const budgetMs = typeof timeoutOverrideMs === 'number' && Number.isFinite(timeoutOverrideMs) ? Math.min(300_000, Math.max(1_000, Math.floor(timeoutOverrideMs))) : this.timeoutMs;
    const timeout = setTimeout(() => controller.abort(), budgetMs);
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
      let payload: unknown;
      try {
        payload = await response.json();
      } catch (parseError) {
        // A timeout while reading the body is still a timeout; anything else is a body that is not JSON.
        if (controller.signal.aborted) throw parseError;
        throw new ModelProviderError({
          provider: this.name,
          code: 'INVALID_PROVIDER_RESPONSE',
          message: `${this.name} returned a response that is not valid JSON.`,
          requestId,
          retryable: false,
        });
      }
      return { payload, responseHeaders: response.headers };
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

  protected response(text: string, startedAt: number, requestId: string, usage?: ModelUsage | null, meta?: ModelResponseMeta): ModelResponse {
    if (!text.trim()) {
      this.recordOutcome('failure', 'EMPTY_PROVIDER_RESPONSE');
      throw new ModelProviderError({ provider: this.name, code: 'EMPTY_PROVIDER_RESPONSE', message: `${this.name} returned no text.`, requestId, retryable: true });
    }
    return { text, provider: this.name, model: this.model!, latencyMs: Date.now() - startedAt, requestId, usage: usage ?? null, ...(meta ? { meta } : {}) };
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
      { model, input: request.messages, store: false, ...(request.maxOutputTokens && request.maxOutputTokens > 0 ? { max_output_tokens: Math.floor(request.maxOutputTokens) } : {}) },
      request.requestId,
      request.timeoutMs,
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
        ...(request.jsonMode || (request.maxOutputTokens && request.maxOutputTokens > 0) ? { generationConfig: { ...(request.jsonMode ? { responseMimeType: 'application/json' } : {}), ...(request.maxOutputTokens && request.maxOutputTokens > 0 ? { maxOutputTokens: Math.floor(request.maxOutputTokens) } : {}) } } : {}),
      },
      request.requestId,
      request.timeoutMs,
    ) as { candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: string }> } }>; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number } };
    const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('') ?? '';
    const usage = payload.usageMetadata
      ? { inputTokens: payload.usageMetadata.promptTokenCount ?? null, outputTokens: payload.usageMetadata.candidatesTokenCount ?? null, totalTokens: payload.usageMetadata.totalTokenCount ?? null }
      : null;
    // why the model stopped (STOP, MAX_TOKENS, SAFETY, ...): a content-free fact that tells a cut-off answer from a damaged one in the router's telemetry
    const finishReason = payload.candidates?.[0]?.finishReason;
    return this.response(text, startedAt, request.requestId, usage, typeof finishReason === 'string' ? { finishReason } : undefined);
  }
}

export const DEFAULT_NEBIUS_BASE_URL = 'https://api.tokenfactory.nebius.com/v1';
export const DEFAULT_NEBIUS_MODEL = 'nvidia/Nemotron-3_5-Lightning';
const DEFAULT_NEBIUS_TIMEOUT_MS = 60_000;     // a reasoning model legitimately thinks for a while; still strictly bounded
const DEFAULT_NEBIUS_MAX_TOKENS = 16_384;     // includes reasoning tokens (a Nemotron plan has been measured at up to ~6.7k)
const NEBIUS_MAX_RETRIES = 1;                  // network failure / 5xx only; never 429, 4xx or timeout

// The tasks NVIDIA Nemotron (through Nebius Token Factory) takes part in through automatic routing, and prefers: general conversation, planning,
// research, meeting preparation and document drafting. Everything else (strict extraction, daily brief, comparison / forecast analysis, ...) keeps its
// existing providers, and non-text creation (images) never goes through this text router at all.
export const NEBIUS_NEMOTRON_TASK_KINDS: ModelTaskKind[] = ['CHAT', 'PLAN', 'RESEARCH_SYNTHESIS', 'MEETING_PREP', 'DOCUMENT_SYNTHESIS'];

interface NebiusOptions extends ProviderOptions {
  baseUrl?: string;
  maxTokens?: number;
}

// An https URL (plain http only for a loopback address, i.e. a local test endpoint), no embedded credentials. Anything else
// is a configuration error and leaves the provider UNCONFIGURED rather than sending a credential somewhere unintended.
function nebiusEndpoint(baseUrl: string | undefined): string | null {
  try {
    const url = new URL((baseUrl?.trim() || DEFAULT_NEBIUS_BASE_URL));
    const loopback = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname);
    if (url.username || url.password) return null;
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}/chat/completions`;
  } catch {
    return null;
  }
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : '')).join('');
  }
  return '';
}

// Reasoning models may inline their thinking in <think>…</think>. That is hidden reasoning, never the answer.
function stripInlineReasoning(text: string): { text: string; hadReasoning: boolean } {
  let out = text;
  let had = false;
  out = out.replace(/<think>[\s\S]*?<\/think>/gi, () => { had = true; return ''; });
  const close = out.toLowerCase().lastIndexOf('</think>');
  if (close >= 0) { had = true; out = out.slice(close + '</think>'.length); }
  const open = out.toLowerCase().indexOf('<think>');
  if (open >= 0) { had = true; out = out.slice(0, open); }
  return { text: out.trim(), hadReasoning: had };
}

function safeRequestId(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9._:\-]{1,128}$/.test(value) ? value : null;
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export class NebiusProvider extends HttpModelProvider {
  public readonly name = 'nebius' as const;
  private readonly endpoint: string | null;
  private readonly maxTokens: number;

  constructor(options: NebiusOptions) {
    super({ ...options, timeoutMs: options.timeoutMs ?? DEFAULT_NEBIUS_TIMEOUT_MS });
    this.endpoint = nebiusEndpoint(options.baseUrl);
    this.maxTokens = options.maxTokens && options.maxTokens > 0 ? Math.floor(options.maxTokens) : DEFAULT_NEBIUS_MAX_TOKENS;
  }

  // Capability evidence is per MODEL: Token Factory hosts many. Nemotron takes part in automatic routing only for the tasks
  // above, is not offered strict structured extraction (unverified), and every capability beyond chat completion is declared
  // UNVERIFIED until a real certification run records evidence. Other Token Factory models keep the generic declaration.
  public get capabilities(): ModelProviderCapabilities {
    if (this.model && /nemotron/i.test(this.model)) {
      return {
        provider: this.name,
        supportsJsonMode: true,
        supportsGeneralChat: true,
        supportsStructuredExtraction: false,
        eligibleTaskKinds: [...NEBIUS_NEMOTRON_TASK_KINDS],
        declared: {
          CHAT_COMPLETION: 'SUPPORTED',
          REASONING: 'UNVERIFIED',
          PLANNING: 'UNVERIFIED',
          RESEARCH_SYNTHESIS: 'UNVERIFIED',
          TOOL_USE: 'UNVERIFIED',
          STRUCTURED_OUTPUT: 'UNVERIFIED',
          LONG_CONTEXT: 'UNVERIFIED',
        },
      };
    }
    return {
      provider: this.name,
      supportsJsonMode: true,
      supportsGeneralChat: true,
      supportsStructuredExtraction: true,
    };
  }

  public status() {
    const status = super.status();
    if (this.endpoint) return status;
    return { ...status, configured: false, available: false, status: 'UNCONFIGURED' as const, degradedReason: null };
  }

  protected assertConfigured(requestId: string): { apiKey: string; model: string } {
    if (!this.endpoint) {
      throw new ModelProviderError({ provider: this.name, code: 'PROVIDER_NOT_CONFIGURED', message: `${this.name} provider is not configured.`, requestId, retryable: false });
    }
    return super.assertConfigured(requestId);
  }

  private isTransient(error: unknown): boolean {
    if (!(error instanceof ModelProviderError)) return false;
    if (error.code === 'PROVIDER_NETWORK_ERROR') return true;
    const http = /^PROVIDER_HTTP_(\d{3})$/.exec(error.code);
    return Boolean(http && Number(http[1]) >= 500);
  }

  public async generate(request: ModelRequest): Promise<ModelResponse> {
    const { apiKey, model } = this.assertConfigured(request.requestId);
    const startedAt = Date.now();
    const body = {
      model,
      messages: request.messages,
      max_tokens: request.maxOutputTokens && request.maxOutputTokens > 0 ? Math.floor(request.maxOutputTokens) : this.maxTokens,
      ...(request.jsonMode ? { response_format: { type: 'json_object' } } : {}),
    };
    let detailed: { payload: unknown; responseHeaders: Headers | undefined } | undefined;
    for (let attempt = 0; !detailed; attempt++) {
      try {
        detailed = await this.postJsonDetailed(this.endpoint!, { Authorization: `Bearer ${apiKey}` }, body, request.requestId, request.timeoutMs);
      } catch (error) {
        if (attempt < NEBIUS_MAX_RETRIES && this.isTransient(error)) continue;
        throw error;
      }
    }

    const payload = detailed.payload as {
      id?: unknown;
      choices?: Array<{ message?: Record<string, unknown>; finish_reason?: unknown }>;
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown; completion_tokens_details?: { reasoning_tokens?: unknown } };
    } | null;
    const choice = payload && typeof payload === 'object' && Array.isArray(payload.choices) ? payload.choices[0] : undefined;
    const message = choice && typeof choice === 'object' && choice.message && typeof choice.message === 'object' ? choice.message : undefined;
    if (!message) {
      this.recordOutcome('failure', 'INVALID_PROVIDER_RESPONSE');
      throw new ModelProviderError({ provider: this.name, code: 'INVALID_PROVIDER_RESPONSE', message: `${this.name} returned an unexpected response shape.`, requestId: request.requestId, retryable: false });
    }

    // The ANSWER is `content` only. `reasoning_content` / `reasoning` / inline <think> are hidden provider reasoning: they are
    // reduced to a boolean here and the text is dropped — never returned, logged, audited or persisted.
    const stripped = stripInlineReasoning(contentText(message.content));
    const reasoningField = [message.reasoning_content, message.reasoning].some((value) => (typeof value === 'string' ? value.trim().length > 0 : Boolean(value)));
    const finishReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : null;
    if (finishReason === 'length') {
      // The token budget ran out (often spent on reasoning): the answer is incomplete and must not be passed off as complete. That is a fact about THIS request,
      // not about the provider: the call reached it and it answered, so it stays LIVE and other tasks are not pushed to a fallback because of it.
      this.recordOutcome('success', null);
      throw new ModelProviderError({ provider: this.name, code: 'PROVIDER_TRUNCATED_RESPONSE', message: `${this.name} stopped before completing the answer.`, requestId: request.requestId, retryable: false });
    }
    const usage = payload?.usage
      ? {
          inputTokens: count(payload.usage.prompt_tokens),
          outputTokens: count(payload.usage.completion_tokens),
          totalTokens: count(payload.usage.total_tokens),
          reasoningTokens: count(payload.usage.completion_tokens_details?.reasoning_tokens),
        }
      : null;
    return this.response(stripped.text, startedAt, request.requestId, usage, {
      finishReason,
      providerRequestId: safeRequestId(detailed.responseHeaders?.get('x-request-id')) ?? safeRequestId(payload?.id),
      reasoningAvailable: stripped.hadReasoning || reasoningField,
    });
  }
}

function positiveInt(value: string | undefined): number | undefined {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export function createProviders(env: NodeJS.ProcessEnv = process.env, fetchFn?: FetchFn, timeoutMs?: number): ModelProvider[] {
  const degradedCooldownMs = readDegradedCooldownMs(env);
  const providers = [
    new OpenAIProvider({ apiKey: env.OPENAI_API_KEY, model: env.NAGEX_OPENAI_MODEL, fetchFn, timeoutMs, degradedCooldownMs }),
    new GeminiProvider({ apiKey: env.GEMINI_API_KEY, model: env.NAGEX_GEMINI_MODEL, fetchFn, timeoutMs, degradedCooldownMs }),
    new NebiusProvider({
      degradedCooldownMs,
      apiKey: env.NEBIUS_API_KEY,
      model: env.NAGEX_NEBIUS_MODEL || DEFAULT_NEBIUS_MODEL,
      baseUrl: env.NAGEX_NEBIUS_BASE_URL,
      timeoutMs: timeoutMs ?? positiveInt(env.NAGEX_NEBIUS_TIMEOUT_MS),
      maxTokens: positiveInt(env.NAGEX_NEBIUS_MAX_TOKENS),
      fetchFn,
    }),
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
