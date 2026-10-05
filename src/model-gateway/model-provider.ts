import { NagexError } from '../common/errors.js';

export type ProviderId = string;
export type RoutingMode = string;

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ModelRequest {
  messages: ModelMessage[];
  requestId: string;
  jsonMode?: boolean;
  // Upper bound on generated tokens (reasoning tokens included for reasoning models). Optional: an adapter that has no
  // such control ignores it. There is deliberately no temperature here — no caller needs one yet.
  maxOutputTokens?: number;
}

// Real token counts only, taken directly from whatever usage object the
// provider's own API response included (R7 §10) — never computed/estimated
// locally, and never present at all for a provider whose API doesn't
// return one.
export interface ModelUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  // Only when the provider itself reports it (reasoning models). A count, never reasoning text.
  reasoningTokens?: number | null;
}

// Safe, content-free facts about how a response was produced. NEVER carries provider reasoning text, headers or prompts.
export interface ModelResponseMeta {
  finishReason?: string | null;
  providerRequestId?: string | null;
  // The provider returned hidden reasoning alongside the answer. The reasoning itself is discarded by the adapter.
  reasoningAvailable?: boolean;
}

// Why the preferred provider did not produce the answer (a fixed vocabulary — never an error message or payload).
export type ModelFailureReason =
  | 'NO_PROVIDER_CREDENTIAL'
  | 'RATE_LIMITED'
  | 'PROVIDER_REJECTION'
  | 'PROVIDER_ERROR'
  | 'NETWORK_FAILURE'
  | 'TIMEOUT'
  | 'INVALID_RESPONSE'
  | 'MODEL_UNAVAILABLE'
  | 'PROVIDER_DEGRADED'
  | 'UNKNOWN_FAILURE';

export interface ModelRoutingTrace {
  taskKind: string;
  // The provider the routing table prefers for this task (null when the task has no preference).
  preferredProvider: string | null;
  actualProvider: string;
  fallbackUsed: boolean;
  // Present only when preferredProvider is set and was not the provider that answered.
  fallbackReason: ModelFailureReason | null;
}

export interface ModelResponse {
  text: string;
  provider: ProviderId;
  model: string;
  latencyMs: number;
  requestId: string;
  usage?: ModelUsage | null;
  meta?: ModelResponseMeta;
  // Set by the router, never by an adapter.
  routing?: ModelRoutingTrace;
}

// R7 §4 — a provider's real runtime state, not just "an API key is
// present": UNCONFIGURED (no key/model), CONFIGURED (key/model present but
// no real call has been observed yet), LIVE (the most recent real call
// succeeded), DEGRADED (the most recent real call failed). Never fabricated
// — set only from an actually-observed generate() outcome (see
// HttpModelProvider.recordOutcome in providers.ts).
export type ProviderRuntimeStatus = 'UNCONFIGURED' | 'CONFIGURED' | 'LIVE' | 'DEGRADED';

export interface ProviderStatus {
  configured: boolean;
  available: boolean;
  provider: ProviderId;
  model: string | null;
  status: ProviderRuntimeStatus;
  lastCheckedAt: string | null;
  degradedReason: string | null;
}

import type { ModelProviderCapabilities } from './model-routing.types.js';

export interface ModelProvider {
  readonly name: ProviderId;
  readonly model: string | null;
  readonly capabilities?: ModelProviderCapabilities;
  status(): ProviderStatus;
  generate(request: ModelRequest): Promise<ModelResponse>;
  // R7.1 — optional so a future/custom adapter that doesn't implement one
  // still satisfies this interface; the router's healthCheck() simply
  // skips probing a provider that has none.
  probe?(): Promise<void>;
}

// The single place provider error codes become the safe, fixed failure vocabulary used in logs, traces and tests.
export function classifyModelFailure(code: string | undefined): ModelFailureReason {
  if (!code) return 'UNKNOWN_FAILURE';
  if (code === 'PROVIDER_NOT_CONFIGURED' || code === 'NO_MODEL_PROVIDER_CONFIGURED') return 'NO_PROVIDER_CREDENTIAL';
  if (code === 'PROVIDER_TIMEOUT') return 'TIMEOUT';
  if (code === 'PROVIDER_NETWORK_ERROR') return 'NETWORK_FAILURE';
  if (code === 'EMPTY_PROVIDER_RESPONSE' || code === 'INVALID_PROVIDER_RESPONSE' || code === 'PROVIDER_TRUNCATED_RESPONSE' || code === 'INVALID_MODEL_RESPONSE') return 'INVALID_RESPONSE';
  const http = /^PROVIDER_HTTP_(\d{3})$/.exec(code);
  if (http) {
    const status = Number(http[1]);
    if (status === 429) return 'RATE_LIMITED';
    if (status === 404 || status === 410) return 'MODEL_UNAVAILABLE';
    if (status >= 500) return 'PROVIDER_ERROR';
    return 'PROVIDER_REJECTION';
  }
  return 'UNKNOWN_FAILURE';
}

export class ModelProviderError extends NagexError {
  public readonly provider: ProviderId;
  public readonly retryable: boolean;

  constructor(input: {
    provider: ProviderId;
    code: string;
    message: string;
    requestId: string;
    category?: 'AUTHENTICATION' | 'RATE_LIMIT' | 'PROVIDER' | 'TIMEOUT';
    retryable: boolean;
  }) {
    super({
      code: input.code,
      category: input.category ?? 'PROVIDER',
      message: input.message,
      request_id: input.requestId,
      details: { provider: input.provider, retryable: input.retryable },
    });
    this.provider = input.provider;
    this.retryable = input.retryable;
  }
}
