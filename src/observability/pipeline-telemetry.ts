export type PipelinePhase =
  | 'INTENT_ANALYSIS'
  | 'QUERY_PLANNING'
  | 'WEB_SEARCH'
  | 'EVIDENCE_FETCH'
  | 'CONTEXT_ASSEMBLY'
  | 'MODEL_ROUTING'
  | 'LLM_GENERATION'
  | 'INDEPENDENT_REVIEW'
  | 'ANSWER_REWRITE'
  | 'FINAL_RESPONSE';

export type JevRuntimeState = 'DISABLED' | 'SHADOW' | 'ADVISORY' | 'APPLIED';

export interface PipelineLogger {
  info(event: string, fields: Record<string, unknown>): void;
  warn(event: string, fields: Record<string, unknown>): void;
}

export interface ModelCostRate {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  reasoningPerMillionUsd?: number;
}

export interface PhaseCompletion {
  provider?: string | null;
  model?: string | null;
  attemptCount?: number;
  inputTokens?: number | null;
  outputTokens?: number | null;
  reasoningTokens?: number | null;
  cache?: 'HIT' | 'MISS' | 'NOT_APPLICABLE';
  errorCode?: string | null;
  details?: Record<string, string | number | boolean | null>;
}

const consoleLogger: PipelineLogger = {
  info: (event, fields) => console.info(JSON.stringify({ event, ...fields })),
  warn: (event, fields) => console.warn(JSON.stringify({ event, ...fields })),
};

const finiteToken = (value: number | null | undefined): number => Number.isFinite(value) && Number(value) > 0 ? Number(value) : 0;

export function resolveModelCostRates(env: NodeJS.ProcessEnv = process.env): Readonly<Record<string, ModelCostRate>> {
  const raw = env.NAGEX_MODEL_COST_RATES_JSON;
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, Partial<ModelCostRate>>;
    return Object.fromEntries(Object.entries(parsed).filter(([, rate]) =>
      Number.isFinite(rate.inputPerMillionUsd) && Number(rate.inputPerMillionUsd) >= 0
      && Number.isFinite(rate.outputPerMillionUsd) && Number(rate.outputPerMillionUsd) >= 0
      && (rate.reasoningPerMillionUsd === undefined || (Number.isFinite(rate.reasoningPerMillionUsd) && Number(rate.reasoningPerMillionUsd) >= 0))
    ).map(([key, rate]) => [key, {
      inputPerMillionUsd: Number(rate.inputPerMillionUsd),
      outputPerMillionUsd: Number(rate.outputPerMillionUsd),
      ...(rate.reasoningPerMillionUsd === undefined ? {} : { reasoningPerMillionUsd: Number(rate.reasoningPerMillionUsd) }),
    }]));
  } catch {
    return {};
  }
}

export class PipelineTelemetry {
  constructor(
    private readonly logger: PipelineLogger = consoleLogger,
    private readonly rates: Readonly<Record<string, ModelCostRate>> = {},
    private readonly now: () => number = Date.now
  ) {}

  public start(requestId: string, phase: PipelinePhase, details?: PhaseCompletion['details']): (completion?: PhaseCompletion) => void {
    const startedAtMs = this.now();
    this.logger.info('pipeline_phase_started', {
      requestId,
      phase,
      startedAt: new Date(startedAtMs).toISOString(),
      ...(details ? { details } : {}),
    });
    let ended = false;
    return (completion: PhaseCompletion = {}) => {
      if (ended) return;
      ended = true;
      const endedAtMs = this.now();
      const estimatedCostUsd = this.estimateCost(completion.provider, completion.model, completion);
      const fields = {
        requestId,
        phase,
        startedAt: new Date(startedAtMs).toISOString(),
        endedAt: new Date(endedAtMs).toISOString(),
        latencyMs: Math.max(0, endedAtMs - startedAtMs),
        provider: completion.provider ?? null,
        model: completion.model ?? null,
        attemptCount: completion.attemptCount ?? 0,
        inputTokens: completion.inputTokens ?? null,
        outputTokens: completion.outputTokens ?? null,
        reasoningTokens: completion.reasoningTokens ?? null,
        cache: completion.cache ?? 'NOT_APPLICABLE',
        estimatedCostUsd,
        costEstimateAvailable: estimatedCostUsd !== null,
        errorCode: completion.errorCode ?? null,
        ...(completion.details ? { details: completion.details } : {}),
      };
      (completion.errorCode ? this.logger.warn : this.logger.info)('pipeline_phase_completed', fields);
    };
  }

  public jev(input: { requestId: string; surface: string; state: JevRuntimeState; callCount: number; latencyMs: number; failed: boolean; errorCode?: string | null }): void {
    this.logger.info('pipeline_jev_observed', {
      requestId: input.requestId,
      surface: input.surface,
      state: input.state,
      callCount: input.callCount,
      latencyMs: Math.max(0, input.latencyMs),
      failed: input.failed,
      errorCode: input.errorCode ?? null,
    });
  }

  private estimateCost(provider: string | null | undefined, model: string | null | undefined, usage: PhaseCompletion): number | null {
    const rate = (model && this.rates[`${provider ?? ''}/${model}`]) || (provider && this.rates[provider]);
    if (!rate) return null;
    const input = finiteToken(usage.inputTokens) * rate.inputPerMillionUsd / 1_000_000;
    const outputTokens = finiteToken(usage.outputTokens);
    const reasoningTokens = Math.min(outputTokens, finiteToken(usage.reasoningTokens));
    const visibleOutput = Math.max(0, outputTokens - reasoningTokens);
    const output = visibleOutput * rate.outputPerMillionUsd / 1_000_000;
    const reasoning = reasoningTokens * (rate.reasoningPerMillionUsd ?? rate.outputPerMillionUsd) / 1_000_000;
    return Number((input + output + reasoning).toFixed(8));
  }
}
