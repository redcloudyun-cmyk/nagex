import { randomUUID } from 'node:crypto';
import { NagexError } from '../common/errors.js';
import {
  ModelProviderError,
  type ModelMessage,
  type ModelProvider,
  type ModelResponse,
  type ProviderRuntimeStatus,
  type ProviderStatus,
  type RoutingMode,
} from './model-provider.js';
import { ModelRoutingPolicy } from './model-routing-policy.js';
import type { ModelRoutingContext, ModelRoutingDecision } from './model-routing.types.js';

export interface RouterLogger {
  info(event: string, fields: Record<string, unknown>): void;
  warn(event: string, fields: Record<string, unknown>): void;
}

const safeLogger: RouterLogger = {
  info: (event, fields) => console.info(JSON.stringify({ event, ...fields })),
  warn: (event, fields) => console.warn(JSON.stringify({ event, ...fields })),
};

export interface GenerateInput {
  messages: ModelMessage[];
  mode: RoutingMode;
  requestId?: string;
  jsonMode?: boolean;
  routingContext?: ModelRoutingContext;
  validate?: (text: string) => void;
  fallbackPolicy?: 'ALLOW' | 'DISALLOW';
}

export class UnifiedModelRouter {
  private readonly providers: Map<string, ModelProvider>;
  private readonly configuredPriority: string[];
  private readonly routingPolicy: ModelRoutingPolicy;

  constructor(
    providers: ModelProvider[],
    private readonly logger: RouterLogger = safeLogger,
    routingPolicy?: ModelRoutingPolicy
  ) {
    this.providers = new Map(providers.map((provider) => [provider.name, provider]));
    this.configuredPriority = providers.map((p) => p.name);
    this.routingPolicy = routingPolicy ?? new ModelRoutingPolicy();
  }

  public statuses(): ProviderStatus[] {
    return [...this.providers.values()].map((provider) => provider.status());
  }

  // R7/R7.1 §2/§3 — "which provider a real request would try first" is a
  // ROUTING fact (priority order among configured providers), which is NOT
  // the same claim as "this provider is currently live". R7.1's root-cause
  // fix: activeProvider must never be read as "the live provider" — it is
  // the routing candidate. activeProviderStatus is returned alongside it
  // specifically so a caller (Settings) can tell the difference and must
  // never render a CONFIGURED-but-unprobed candidate as Connected/Live.
  public activeProviderSummary(): {
    activeProvider: string | null;
    activeModel: string | null;
    activeProviderStatus: ProviderRuntimeStatus | null;
    fallbackProviders: string[];
  } {
    const configured = [...this.providers.values()]
      .map((provider) => provider.status())
      .filter((status) => status.configured);
    const [active, ...rest] = configured;
    return {
      activeProvider: active?.provider ?? null,
      activeModel: active?.model ?? null,
      activeProviderStatus: active?.status ?? null,
      fallbackProviders: rest.map((status) => status.provider),
    };
  }

  // R7.1 — the explicit, bounded probe path: GET /providers/status stays a
  // pure read (never triggers generation itself); this is the one real
  // mechanism, alongside organic generate() traffic, that can move a
  // provider from CONFIGURED to LIVE/DEGRADED. Probes every configured
  // provider in parallel (each already individually bounded by its own
  // provider-level timeoutMs — no additional retry layered on top here),
  // and never throws: a probe failure is exactly what turns a provider
  // DEGRADED, not a router-level error.
  public async healthCheck(): Promise<ProviderStatus[]> {
    const configured = [...this.providers.values()].filter((provider) => provider.status().configured);
    await Promise.all(configured.map((provider) => provider.probe?.() ?? Promise.resolve()));
    return this.statuses();
  }

  public async generate(input: GenerateInput): Promise<ModelResponse> {
    const requestId = input.requestId || input.routingContext?.requestId || `mdl_${randomUUID()}`;

    const context: ModelRoutingContext = input.routingContext || {
      taskKind: input.jsonMode ? 'STRUCTURED_EXTRACTION' : 'CHAT',
      requiresJson: Boolean(input.jsonMode),
      requestId,
    };

    const decision: ModelRoutingDecision = this.routingPolicy.select(
      input.mode,
      context,
      [...this.providers.values()],
      this.configuredPriority
    );

    const fallbackPolicy = input.fallbackPolicy ?? 'ALLOW';
    const effectiveFallbacks = fallbackPolicy === 'DISALLOW' ? [] : decision.fallbackProviders;

    // Logging model_routing_decision event — STRICT PRIVACY: zero prompt, memory, or evidence content
    this.logger.info('model_routing_decision', {
      requestId: context.requestId,
      taskKind: decision.taskKind,
      selectedProvider: decision.selectedProvider,
      fallbackProviders: effectiveFallbacks,
      reasonCodes: decision.reasonCodes,
    });

    const candidateOrder = [decision.selectedProvider, ...effectiveFallbacks];
    const candidates = candidateOrder
      .map((name) => this.providers.get(name))
      .filter((provider): provider is ModelProvider => Boolean(provider?.status().configured));

    if (candidates.length === 0) {
      throw new NagexError({
        code: 'NO_MODEL_PROVIDER_CONFIGURED',
        category: 'PROVIDER',
        message: 'No model provider is configured.',
        request_id: requestId,
      });
    }

    const failures: Array<{ provider: string; code: string }> = [];
    for (const provider of candidates) {
      try {
        const result = await provider.generate({ messages: input.messages, requestId, jsonMode: input.jsonMode });
        input.validate?.(result.text);
        this.logger.info('model_request_succeeded', {
          requestId,
          provider: result.provider,
          model: result.model,
          latencyMs: result.latencyMs,
          fallbackUsed: provider.name !== candidateOrder[0],
        });
        return result;
      } catch (error) {
        const normalized = error instanceof ModelProviderError
          ? error
          : error instanceof NagexError
            ? new ModelProviderError({ provider: provider.name, code: error.code, message: error.message, requestId, retryable: true })
            : new ModelProviderError({ provider: provider.name, code: 'PROVIDER_UNKNOWN_ERROR', message: `${provider.name} request failed.`, requestId, retryable: true });
        failures.push({ provider: provider.name, code: normalized.code });
        this.logger.warn('model_request_failed', {
          requestId,
          provider: provider.name,
          model: provider.model,
          code: normalized.code,
          retryable: normalized.retryable,
        });
      }
    }

    throw new NagexError({
      code: 'ALL_MODEL_PROVIDERS_FAILED',
      category: 'PROVIDER',
      message: 'All configured model providers failed.',
      request_id: requestId,
      details: { failures },
    });
  }
}
