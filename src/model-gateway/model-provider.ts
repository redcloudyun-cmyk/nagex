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
}

// Real token counts only, taken directly from whatever usage object the
// provider's own API response included (R7 §10) — never computed/estimated
// locally, and never present at all for a provider whose API doesn't
// return one.
export interface ModelUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

export interface ModelResponse {
  text: string;
  provider: ProviderId;
  model: string;
  latencyMs: number;
  requestId: string;
  usage?: ModelUsage | null;
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

export interface ModelProvider {
  readonly name: ProviderId;
  readonly model: string | null;
  status(): ProviderStatus;
  generate(request: ModelRequest): Promise<ModelResponse>;
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
