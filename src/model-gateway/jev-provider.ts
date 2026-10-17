import { createHash } from 'node:crypto';
import { ModelProviderError } from './model-provider.js';
import { classifyJevHttpFailure, redactSecrets } from './jev-errors.js';
import { validateJevShadowOutput } from './jev-shadow-evaluator.js';
import type { JevReasoningLevel, JevShadowInput, JevShadowOutput } from './jev-shadow.types.js';

type FetchFn = typeof fetch;

export const JEV_SYSTEMONE_ENDPOINT = 'https://jevmodel.org/v1/systemone';
export const JEV_MODEL_ALIAS = 'jev-latest';

export interface JevProviderOptions {
  apiKey?: string;
  fetchFn?: FetchFn;
  timeoutMs?: number;
}

function nowMs(): number {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return clamp01(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? clamp01(parsed) : null;
  }
  return null;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function normalizeReasoningLevel(score: number): JevReasoningLevel {
  if (score >= 0.9) return 'VERY_COMPLEX';
  if (score >= 0.66) return 'COMPLEX';
  if (score >= 0.33) return 'MODERATE';
  return 'ROUTINE';
}

function parseChoice(value: unknown): JevShadowOutput['complexity'] {
  if (value === 'SIMPLE' || value === 'STANDARD' || value === 'HIGH_REASONING' || value === 'UNCERTAIN') return value;
  throw new Error(`Invalid JEV complexity choice: ${String(value)}`);
}

export function parseJevHighRiskProbability(answer: unknown): number | null {
  if (answer === null || answer === undefined) return null;
  if (typeof answer === 'number' || typeof answer === 'string') return numberOrNull(answer);
  if (typeof answer !== 'object') return null;
  const record = answer as Record<string, unknown>;
  for (const key of ['probability', 'value', 'score', 'noul', 'number']) {
    const parsed = numberOrNull(record[key]);
    if (parsed !== null) return parsed;
  }
  if (typeof record.answer === 'number' || typeof record.answer === 'string') return numberOrNull(record.answer);
  if (record.answer && typeof record.answer === 'object') return parseJevHighRiskProbability(record.answer);
  return null;
}

function buildState(input: JevShadowInput): unknown {
  return {
    text: input.state ?? {
      taskKind: input.taskKind,
      requiresJson: input.requiresJson,
      requiresEvidenceGrounding: Boolean(input.requiresEvidenceGrounding),
    },
    signals: input.signals ?? {},
  };
}

/** The exact JSON object the provider sends for an input. One place, so an Idempotency-Key can be derived from what is REALLY sent (jev-idempotency.ts). */
export function buildJevRequestBody(input: JevShadowInput): Record<string, unknown> {
  return {
    model: JEV_MODEL_ALIAS,
    state: buildState(input),
    questions: {
      complexity: {
        type: 'choice',
        instructions: 'Choose only one complexity label. Do not include free-form reasoning.',
        criteria: {
          SIMPLE: 'Routine direct request with little or no planning.',
          STANDARD: 'Normal task that needs some structure but not deep reasoning.',
          HIGH_REASONING: 'Multi-step planning, synthesis, meeting preparation, research or long-context reasoning.',
          UNCERTAIN: 'Ambiguous request where the safe response is to retain the current route.',
        },
        choices: ['SIMPLE', 'STANDARD', 'HIGH_REASONING', 'UNCERTAIN'],
      },
      high_risk: {
        type: 'noul',
        instructions: 'Return the probability from 0 to 1 that the request is consequential or high risk. This is advisory only and never approval authority.',
      },
      reasoning_level: {
        type: 'score',
        instructions: 'Return a 0 to 1 reasoning-complexity score. Do not include free-form reasoning.',
        criteria: [
          { max: 0.32, label: 'ROUTINE' },
          { min: 0.33, max: 0.65, label: 'MODERATE' },
          { min: 0.66, max: 0.89, label: 'COMPLEX' },
          { min: 0.9, label: 'VERY_COMPLEX' },
        ],
      },
    },
  };
}

export class JevSystemOneProvider {
  private readonly apiKey: string | null;
  private readonly fetchFn: FetchFn;
  private readonly timeoutMs: number;

  constructor(options: JevProviderOptions = {}) {
    this.apiKey = options.apiKey?.trim() || null;
    this.fetchFn = options.fetchFn ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  public configured(): boolean {
    return Boolean(this.apiKey);
  }

  // key -> fingerprint of the body it was first used with; the most recent last, bounded
  private readonly keyBodies = new Map<string, string>();
  private assertKeyNotReused(key: string, bodyText: string): void {
    const fingerprint = createHash('sha256').update(bodyText).digest('hex');
    const known = this.keyBodies.get(key);
    if (known !== undefined && known !== fingerprint) {
      throw new ModelProviderError({
        provider: 'jev',
        code: 'IDEMPOTENCY_KEY_REUSED',
        message: 'An Idempotency-Key was about to be sent with a second, different request. Nothing was sent.',
        requestId: 'jev-shadow',
        retryable: false,
        details: { reason: 'LOCAL_GUARD' },
      });
    }
    this.keyBodies.delete(key);
    this.keyBodies.set(key, fingerprint); // the same body again (a retry) is allowed and keeps the key
    if (this.keyBodies.size > 512) this.keyBodies.delete(this.keyBodies.keys().next().value as string);
  }

  public async evaluate(input: JevShadowInput): Promise<JevShadowOutput> {
    if (!this.apiKey) {
      throw new ModelProviderError({
        provider: 'jev',
        code: 'PROVIDER_NOT_CONFIGURED',
        message: 'JEV provider is not configured.',
        requestId: 'jev-shadow',
        retryable: false,
      });
    }
    const bodyText = JSON.stringify(buildJevRequestBody(input));
    // a key names ONE request: sending it with a second, different body is refused here, before anything is sent (JEV answers it 409 idempotency_conflict; it used to look like a 402)
    if (input.idempotencyKey) this.assertKeyNotReused(input.idempotencyKey, bodyText);
    const started = nowMs();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchFn(JEV_SYSTEMONE_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
          ...(input.idempotencyKey ? { 'Idempotency-Key': input.idempotencyKey } : {}),
        },
        signal: controller.signal,
        body: bodyText,
      });
      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        // decided from the status and the STRUCTURE of the body: 409 = IDEMPOTENCY_CONFLICT, 402 = INSUFFICIENT_CREDITS (only that), the rest keep PROVIDER_HTTP_<status>
        const failure = classifyJevHttpFailure(response.status, errorBody);
        throw new ModelProviderError({
          provider: 'jev',
          code: failure.code,
          message: `JEV request failed with HTTP ${response.status} (${failure.failureClass}).`,
          requestId: 'jev-shadow',
          retryable: failure.retryable,
          details: {
            status: response.status,
            failureClass: failure.failureClass,
            bodyCode: failure.body.code,
            fields: failure.body.fields,
            // the credential never travels into a stored error
            responseBody: redactSecrets(errorBody, [this.apiKey]).slice(0, 4000),
            requestFields: ['model', 'state', 'questions'],
          },
        });
      }
      const payload = await response.json() as {
        model?: unknown;
        resolved_model?: unknown;
        answers?: {
          complexity?: { choice?: unknown; confidence?: unknown };
          high_risk?: { probability?: unknown; confidence?: unknown };
          reasoning_level?: { score?: unknown; confidence?: unknown };
        };
      };
      const complexity = parseChoice(payload.answers?.complexity?.choice);
      const reasoningScore = clamp01(asNumber(payload.answers?.reasoning_level?.score, 0.5));
      return validateJevShadowOutput({
        complexity,
        complexityConfidence: clamp01(asNumber(payload.answers?.complexity?.confidence, 0)),
        highRiskProbability: parseJevHighRiskProbability(payload.answers?.high_risk),
        reasoningLevel: normalizeReasoningLevel(reasoningScore),
        reasoningConfidence: clamp01(asNumber(payload.answers?.reasoning_level?.confidence, 0)),
        resolvedModel: typeof payload.resolved_model === 'string' ? payload.resolved_model : typeof payload.model === 'string' ? payload.model : JEV_MODEL_ALIAS,
        reasonCode: 'OTHER',
        latencyMs: Math.max(0, nowMs() - started),
      });
    } catch (error) {
      if (error instanceof ModelProviderError) throw error;
      throw new ModelProviderError({
        provider: 'jev',
        code: controller.signal.aborted ? 'PROVIDER_TIMEOUT' : 'PROVIDER_NETWORK_ERROR',
        message: 'JEV request failed.',
        requestId: 'jev-shadow',
        retryable: true,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}
