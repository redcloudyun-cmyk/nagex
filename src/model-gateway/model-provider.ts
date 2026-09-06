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

export interface ModelResponse {
  text: string;
  provider: ProviderId;
  model: string;
  latencyMs: number;
  requestId: string;
}

export interface ProviderStatus {
  configured: boolean;
  available: boolean;
  provider: ProviderId;
  model: string | null;
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
