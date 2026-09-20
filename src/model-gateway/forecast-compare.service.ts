import { randomUUID } from 'node:crypto';
import { NagexError } from '../common/errors.js';
import type { MemoryRecord } from '../context/memory.engine.js';
import type { EvidencePack, EvidenceSource } from '../research/evidence-pack.types.js';
import type { EvidencePackService } from '../research/evidence-pack.service.js';
import type { UnifiedModelRouter, RouterLogger } from './unified-model-router.js';

export interface ForecastSpecification {
  question: string;
  target: string;
  outcomeType: 'BINARY' | 'RANGE' | 'CATEGORICAL';
  horizonStart: string;
  horizonEnd: string;
  resolutionCriteria: string;
  assumptions: string[];
  createdAt: string;
}

export interface IndependentForecast {
  forecastId: string;
  provider: string;
  model: string;
  status: 'SUCCESS' | 'FAILED';
  probability: number | null;
  rationale: string | null;
  supportingFactors: string[];
  opposingFactors: string[];
  keyAssumptions: string[];
  uncertaintyDrivers: string[];
  latencyMs: number | null;
  errorCode?: string;
}

export interface ForecastDistribution {
  min: number;
  max: number;
  median: number;
  spread: number;
}

export interface ForecastSynthesis {
  probability: number;
  probabilityRange: {
    low: number;
    high: number;
  };
  summary: string;
  keyDrivers: string[];
  counterSignals: string[];
  uncertainties: string[];
  whatWouldChangeTheForecast: string[];
}

export interface ForecastCompareResult {
  requestId: string;
  status: 'SUCCESS' | 'PARTIAL' | 'UNAVAILABLE' | 'NEEDS_CLARIFICATION';
  specification: ForecastSpecification | null;
  forecastsAttempted: number;
  forecastsSucceeded: number;
  distribution: ForecastDistribution | null;
  synthesis: ForecastSynthesis | null;
  forecasts?: IndependentForecast[];
  evidencePackId?: string;
  sources?: EvidenceSource[];
  clarificationMessage?: string;
}

export interface ForecastCompareOptions {
  query: string;
  tenantId?: string;
  ownerId?: string;
  memories?: MemoryRecord[];
  requiresEvidenceGrounding?: boolean;
  requestId?: string;
  evidencePack?: EvidencePack;
  specification?: ForecastSpecification;
}

const safeLogger: RouterLogger = {
  info: (event, fields) => console.info(JSON.stringify({ event, ...fields })),
  warn: (event, fields) => console.warn(JSON.stringify({ event, ...fields })),
};

function summarizeMemories(memories?: MemoryRecord[]): string {
  if (!memories || memories.length === 0) return '(No relevant personal context)';
  return memories.slice(0, 8).map((memory) => {
    const content = memory.content;
    return `- ${content.subject} ${content.predicate}: ${String(content.value)}`;
  }).join('\n');
}

function summarizeEvidencePack(pack?: EvidencePack): string {
  if (!pack || !pack.sources || pack.sources.length === 0) {
    return '(No external evidence retrieved)';
  }
  return pack.sources
    .map((s) => `[${s.sourceId}] Title: ${s.title}\nURL: ${s.url}\nSnippet: ${s.snippet || '(no snippet)'}\nPublished: ${s.publishedAt || 'UNDATED'}`)
    .join('\n\n');
}

export function parseIndependentForecastJson(text: string, requestId: string): {
  probability: number;
  rationale: string;
  supportingFactors: string[];
  opposingFactors: string[];
  keyAssumptions: string[];
  uncertaintyDrivers: string[];
} {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new NagexError({
      code: 'FORECAST_SCHEMA_FAIL_CLOSED',
      category: 'PROVIDER',
      message: 'Independent forecast model returned invalid JSON.',
      request_id: requestId,
    });
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new NagexError({
      code: 'FORECAST_SCHEMA_FAIL_CLOSED',
      category: 'PROVIDER',
      message: 'Independent forecast output is not a JSON object.',
      request_id: requestId,
    });
  }

  if (typeof parsed.probability !== 'number' || Number.isNaN(parsed.probability) || !Number.isFinite(parsed.probability)) {
    throw new NagexError({
      code: 'FORECAST_SCHEMA_FAIL_CLOSED',
      category: 'VALIDATION',
      message: 'Independent forecast probability must be a valid finite number.',
      request_id: requestId,
    });
  }

  if (parsed.probability < 0 || parsed.probability > 1) {
    throw new NagexError({
      code: 'PROBABILITY_OUT_OF_RANGE',
      category: 'VALIDATION',
      message: `Independent forecast probability ${parsed.probability} is out of range [0, 1].`,
      request_id: requestId,
    });
  }

  if (typeof parsed.rationale !== 'string' || !parsed.rationale.trim()) {
    throw new NagexError({
      code: 'FORECAST_SCHEMA_FAIL_CLOSED',
      category: 'PROVIDER',
      message: 'Independent forecast rationale is required.',
      request_id: requestId,
    });
  }

  const parseArrayOfStrings = (field: any, name: string): string[] => {
    if (!Array.isArray(field)) {
      throw new NagexError({
        code: 'FORECAST_SCHEMA_FAIL_CLOSED',
        category: 'PROVIDER',
        message: `Field ${name} must be an array of strings.`,
        request_id: requestId,
      });
    }
    return field.map((item) => {
      if (typeof item !== 'string') {
        throw new NagexError({
          code: 'FORECAST_SCHEMA_FAIL_CLOSED',
          category: 'PROVIDER',
          message: `Elements in ${name} must be strings.`,
          request_id: requestId,
        });
      }
      return item.trim();
    });
  };

  return {
    probability: parsed.probability,
    rationale: parsed.rationale.trim(),
    supportingFactors: parseArrayOfStrings(parsed.supportingFactors, 'supportingFactors'),
    opposingFactors: parseArrayOfStrings(parsed.opposingFactors, 'opposingFactors'),
    keyAssumptions: parseArrayOfStrings(parsed.keyAssumptions, 'keyAssumptions'),
    uncertaintyDrivers: parseArrayOfStrings(parsed.uncertaintyDrivers, 'uncertaintyDrivers'),
  };
}

export function parseForecastSynthesisJson(text: string, requestId: string): ForecastSynthesis {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new NagexError({
      code: 'FORECAST_SYNTHESIS_FAILED',
      category: 'PROVIDER',
      message: 'Forecast synthesis model returned invalid JSON.',
      request_id: requestId,
    });
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new NagexError({
      code: 'FORECAST_SYNTHESIS_FAILED',
      category: 'PROVIDER',
      message: 'Forecast synthesis output is not a JSON object.',
      request_id: requestId,
    });
  }

  if (typeof parsed.probability !== 'number' || Number.isNaN(parsed.probability) || !Number.isFinite(parsed.probability)) {
    throw new NagexError({
      code: 'PROBABILITY_OUT_OF_RANGE',
      category: 'VALIDATION',
      message: 'Synthesis probability must be a valid number.',
      request_id: requestId,
    });
  }

  if (parsed.probability < 0 || parsed.probability > 1) {
    throw new NagexError({
      code: 'PROBABILITY_OUT_OF_RANGE',
      category: 'VALIDATION',
      message: `Synthesis probability ${parsed.probability} is out of range [0, 1].`,
      request_id: requestId,
    });
  }

  if (!parsed.probabilityRange || typeof parsed.probabilityRange !== 'object') {
    throw new NagexError({
      code: 'FORECAST_SYNTHESIS_FAILED',
      category: 'PROVIDER',
      message: 'Forecast synthesis missing probabilityRange.',
      request_id: requestId,
    });
  }

  const { low, high } = parsed.probabilityRange;
  if (typeof low !== 'number' || typeof high !== 'number' || Number.isNaN(low) || Number.isNaN(high)) {
    throw new NagexError({
      code: 'PROBABILITY_OUT_OF_RANGE',
      category: 'VALIDATION',
      message: 'Synthesis probabilityRange low and high must be numbers.',
      request_id: requestId,
    });
  }

  if (low < 0 || high > 1 || low > parsed.probability || parsed.probability > high) {
    throw new NagexError({
      code: 'PROBABILITY_RANGE_INVALID',
      category: 'VALIDATION',
      message: `Invalid probability range: low=${low}, probability=${parsed.probability}, high=${high}. Must satisfy 0 <= low <= probability <= high <= 1.`,
      request_id: requestId,
    });
  }

  if (typeof parsed.summary !== 'string' || !parsed.summary.trim()) {
    throw new NagexError({
      code: 'FORECAST_SYNTHESIS_FAILED',
      category: 'PROVIDER',
      message: 'Synthesis summary is required.',
      request_id: requestId,
    });
  }

  const parseStringArray = (arr: any, name: string): string[] => {
    if (!Array.isArray(arr)) {
      throw new NagexError({
        code: 'FORECAST_SYNTHESIS_FAILED',
        category: 'PROVIDER',
        message: `Synthesis field ${name} must be an array of strings.`,
        request_id: requestId,
      });
    }
    return arr.map((item) => {
      if (typeof item !== 'string') {
        throw new NagexError({
          code: 'FORECAST_SYNTHESIS_FAILED',
          category: 'PROVIDER',
          message: `Synthesis field ${name} elements must be strings.`,
          request_id: requestId,
        });
      }
      return item.trim();
    });
  };

  return {
    probability: parsed.probability,
    probabilityRange: { low, high },
    summary: parsed.summary.trim(),
    keyDrivers: parseStringArray(parsed.keyDrivers, 'keyDrivers'),
    counterSignals: parseStringArray(parsed.counterSignals, 'counterSignals'),
    uncertainties: parseStringArray(parsed.uncertainties, 'uncertainties'),
    whatWouldChangeTheForecast: parseStringArray(parsed.whatWouldChangeTheForecast, 'whatWouldChangeTheForecast'),
  };
}

export class ForecastCompareService {
  private readonly router: UnifiedModelRouter;
  private readonly evidencePackService: EvidencePackService;
  private readonly logger: RouterLogger;

  constructor(
    router: UnifiedModelRouter,
    evidencePackService: EvidencePackService,
    logger?: RouterLogger
  ) {
    this.router = router;
    this.evidencePackService = evidencePackService;
    this.logger = logger || safeLogger;
  }

  public deriveSpecification(query: string, optionsSpec?: ForecastSpecification): ForecastSpecification | null {
    if (optionsSpec) {
      if (!optionsSpec.target || !optionsSpec.resolutionCriteria) return null;
      return optionsSpec;
    }

    const q = query.trim();
    const lower = q.toLowerCase();

    // Check for ambiguous / unresolvable forecast questions without context
    const ambiguousPatterns = [
      /^will it succeed\??$/i,
      /^will sales improve\??$/i,
      /^will this be done soon\??$/i,
      /^is it going to happen\??$/i,
      /^성공할까\??$/i,
      /^매출이 오를까\??$/i,
      /^곧 끝날까\??$/i,
    ];

    if (ambiguousPatterns.some((p) => p.test(q))) {
      return null;
    }

    // Attempt target and horizon extraction
    let target = q;
    let horizonStart = new Date().toISOString();
    let horizonEnd = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
    let resolutionCriteria = `YES if the specified event occurs as stated in: "${q}"; otherwise NO.`;

    // English date horizon extraction
    const byMatchEn = q.match(/by\s+([A-Za-z]+(?:\s+\d{1,2})?(?:\s*,\s*\d{4})?|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4})/i);
    const beforeMatchEn = q.match(/before\s+([A-Za-z]+(?:\s+\d{1,2})?(?:\s*,\s*\d{4})?|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4})/i);

    // Korean date horizon extraction
    const krMonthMatch = q.match(/(\d{1,2})월\s*(?:안에|까지|전까지)?/);
    const krEndMatch = q.match(/(이번\s*달|다음\s*달|금년|내년|올해)/);

    if (byMatchEn || beforeMatchEn || krMonthMatch || krEndMatch || lower.includes('december') || lower.includes('friday') || lower.includes('within') || lower.includes('launch')) {
      target = q.replace(/^(will|can|is|what are the chances|how likely is it that|likely to|이게|이번|성공할|분석해줘|예측해줘|확률을|추정해줘)\s*/i, '').trim();
      if (byMatchEn || beforeMatchEn) {
        const timeStr = (byMatchEn ? byMatchEn[1] : beforeMatchEn![1]).trim();
        resolutionCriteria = `YES if ${target || 'the specified target event'} is verified complete before ${timeStr}; otherwise NO.`;
      } else if (krMonthMatch) {
        resolutionCriteria = `YES if ${target} is verified complete before the end of month ${krMonthMatch[1]}; otherwise NO.`;
      }
    } else {
      // If query has no target/horizon indicators and is extremely short / vague
      if (q.split(/\s+/).length < 4 && !lower.includes('launch') && !lower.includes('finish') && !lower.includes('complete')) {
        return null;
      }
    }

    return {
      question: q,
      target: target || q,
      outcomeType: 'BINARY',
      horizonStart,
      horizonEnd,
      resolutionCriteria,
      assumptions: [],
      createdAt: new Date().toISOString(),
    };
  }

  public isElectionQuery(query: string): boolean {
    const q = query.toLowerCase();
    const electionKeywords = [
      'election',
      'presidential election',
      'who will win',
      'candidate win',
      'election prediction',
      'election winner',
      '대선',
      '선거',
      '선거 예측',
      '대통령 선거',
    ];
    return electionKeywords.some((k) => q.includes(k));
  }

  public selectEligibleProviders(requestId: string): string[] {
    return this.router.eligibleProviders({
      taskKind: 'FORECAST_ANALYSIS',
      requiresJson: true,
      requiresEvidenceGrounding: true,
      requestId,
    }).slice(0, 3);
  }

  public async compare(options: ForecastCompareOptions): Promise<ForecastCompareResult> {
    const requestId = options.requestId || `fct_${randomUUID()}`;
    const query = options.query.trim();

    if (!query) {
      throw new NagexError({
        code: 'INVALID_QUERY',
        category: 'VALIDATION',
        message: 'Forecast query is required.',
        request_id: requestId,
      });
    }

    this.logger.info('forecast_compare_started', {
      requestId,
      taskKind: 'FORECAST_ANALYSIS',
    });

    // Political Election Prediction Policy Guard (§33)
    if (this.isElectionQuery(query)) {
      this.logger.warn('forecast_compare_completed', {
        requestId,
        taskKind: 'FORECAST_ANALYSIS',
        status: 'SUCCESS',
        attemptedCount: 0,
        successCount: 0,
      });
      return {
        requestId,
        status: 'SUCCESS',
        specification: null,
        forecastsAttempted: 0,
        forecastsSucceeded: 0,
        distribution: null,
        synthesis: {
          probability: 0.5,
          probabilityRange: { low: 0.5, high: 0.5 },
          summary: 'Election outcomes are subject to polling methodologies, margins of error, and population sampling. NAgex provides neutral factual reporting rather than proprietary election predictions.',
          keyDrivers: ['Documented poll measurements', 'Official election authority notices'],
          counterSignals: ['Polling margin of error'],
          uncertainties: ['Voter turnout variability'],
          whatWouldChangeTheForecast: ['Official certified election results'],
        },
      };
    }

    // 1. Forecast Specification
    const spec = this.deriveSpecification(query, options.specification);
    if (!spec) {
      this.logger.info('forecast_specification_created', {
        requestId,
        taskKind: 'FORECAST_ANALYSIS',
        outcomeType: 'BINARY',
      });
      this.logger.info('forecast_compare_completed', {
        requestId,
        taskKind: 'FORECAST_ANALYSIS',
        status: 'NEEDS_CLARIFICATION',
        attemptedCount: 0,
        successCount: 0,
      });
      return {
        requestId,
        status: 'NEEDS_CLARIFICATION',
        specification: null,
        forecastsAttempted: 0,
        forecastsSucceeded: 0,
        distribution: null,
        synthesis: null,
        clarificationMessage: 'Forecast target or horizon is ambiguous. Please specify clear criteria.',
      };
    }

    this.logger.info('forecast_specification_created', {
      requestId,
      taskKind: 'FORECAST_ANALYSIS',
      outcomeType: spec.outcomeType,
    });

    // 2. Shared Evidence Pack
    let evidencePack: EvidencePack | undefined = options.evidencePack;
    if (!evidencePack && options.requiresEvidenceGrounding !== false) {
      try {
        evidencePack = await this.evidencePackService.buildEvidencePack(query, {
          forceSearch: true,
          requestId,
        });
      } catch (err: any) {
        this.logger.warn('forecast_compare_completed', {
          requestId,
          taskKind: 'FORECAST_ANALYSIS',
          status: 'UNAVAILABLE',
          attemptedCount: 0,
          successCount: 0,
        });
        return {
          requestId,
          status: 'UNAVAILABLE',
          specification: spec,
          forecastsAttempted: 0,
          forecastsSucceeded: 0,
          distribution: null,
          synthesis: null,
        };
      }
    }

    if (evidencePack && evidencePack.status !== 'SUCCESS' && evidencePack.status !== 'NOT_REQUIRED') {
      this.logger.warn('forecast_compare_completed', {
        requestId,
        taskKind: 'FORECAST_ANALYSIS',
        status: 'UNAVAILABLE',
        attemptedCount: 0,
        successCount: 0,
        evidencePackId: evidencePack.evidencePackId,
      });
      return {
        requestId,
        status: 'UNAVAILABLE',
        specification: spec,
        forecastsAttempted: 0,
        forecastsSucceeded: 0,
        distribution: null,
        synthesis: null,
        evidencePackId: evidencePack.evidencePackId,
        sources: evidencePack.sources || [],
      };
    }

    // 3. Eligible Provider Selection
    const eligibleProviderNames = this.selectEligibleProviders(requestId);
    if (eligibleProviderNames.length === 0) {
      this.logger.warn('forecast_compare_completed', {
        requestId,
        taskKind: 'FORECAST_ANALYSIS',
        status: 'UNAVAILABLE',
        attemptedCount: 0,
        successCount: 0,
      });
      return {
        requestId,
        status: 'UNAVAILABLE',
        specification: spec,
        forecastsAttempted: 0,
        forecastsSucceeded: 0,
        distribution: null,
        synthesis: null,
        evidencePackId: evidencePack?.evidencePackId,
        sources: evidencePack?.sources,
      };
    }

    // 4. Independent Provider Execution
    const memorySummary = summarizeMemories(options.memories);
    const evidenceSummary = summarizeEvidencePack(evidencePack);

    const independentPrompt = `=== FORECAST SPECIFICATION ===
Question: ${spec.question}
Target: ${spec.target}
Outcome Type: ${spec.outcomeType}
Resolution Horizon: ${spec.horizonStart} to ${spec.horizonEnd}
Resolution Criteria: ${spec.resolutionCriteria}

=== PERSONAL CONTEXT (Not External Web Evidence) ===
${memorySummary}

=== EVIDENCE PACK ===
${evidenceSummary}

=== INSTRUCTIONS ===
You are one independent forecasting perspective inside NAgex.
Forecast the specified event using only the supplied forecast definition, personal context, and evidence.
Return a JSON object with:
- "probability": float between 0.0 and 1.0 (e.g. 0.62)
- "rationale": string explaining the reasoning
- "supportingFactors": array of strings
- "opposingFactors": array of strings
- "keyAssumptions": array of strings
- "uncertaintyDrivers": array of strings

Do not vote. Do not refer to other models. Do not claim certainty. Do not invent current facts not in Evidence Pack. Do not reveal provider identity.`;

    const forecastPromises = eligibleProviderNames.map(async (providerName): Promise<IndependentForecast> => {
      const forecastId = `fct_ind_${providerName}_${Date.now()}`;
      const providerReqId = `${requestId}_${providerName}`;
      try {
        const response = await this.router.generate({
          mode: providerName,
          fallbackPolicy: 'DISALLOW', // Guaranteed NO fallback substitution
          jsonMode: true,
          routingContext: {
            taskKind: 'FORECAST_ANALYSIS',
            requiresJson: true,
            requiresEvidenceGrounding: true,
            requestId: providerReqId,
          },
          messages: [
            { role: 'system', content: 'You are an independent AI forecast model. Output valid JSON only.' },
            { role: 'user', content: independentPrompt },
          ],
        });

        const parsed = parseIndependentForecastJson(response.text, providerReqId);

        this.logger.info('forecast_provider_completed', {
          requestId: providerReqId,
          taskKind: 'FORECAST_ANALYSIS',
          provider: providerName,
          latencyMs: response.latencyMs,
          status: 'SUCCESS',
          evidencePackId: evidencePack?.evidencePackId,
        });

        return {
          forecastId,
          provider: providerName,
          model: response.model,
          status: 'SUCCESS',
          probability: parsed.probability,
          rationale: parsed.rationale,
          supportingFactors: parsed.supportingFactors,
          opposingFactors: parsed.opposingFactors,
          keyAssumptions: parsed.keyAssumptions,
          uncertaintyDrivers: parsed.uncertaintyDrivers,
          latencyMs: response.latencyMs,
        };
      } catch (err: any) {
        const errCode = err?.code || 'FORECAST_PROVIDER_FAILED';
        this.logger.warn('forecast_provider_failed', {
          requestId: providerReqId,
          taskKind: 'FORECAST_ANALYSIS',
          provider: providerName,
          errorCode: errCode,
          status: 'FAILED',
        });
        return {
          forecastId,
          provider: providerName,
          model: 'unknown',
          status: 'FAILED',
          probability: null,
          rationale: null,
          supportingFactors: [],
          opposingFactors: [],
          keyAssumptions: [],
          uncertaintyDrivers: [],
          latencyMs: null,
          errorCode: errCode,
        };
      }
    });

    const independentForecasts = await Promise.all(forecastPromises);
    const successfulForecasts = independentForecasts.filter((f) => f.status === 'SUCCESS' && f.probability !== null);
    const successCount = successfulForecasts.length;
    const attemptedCount = independentForecasts.length;

    if (successCount === 0) {
      this.logger.warn('forecast_compare_completed', {
        requestId,
        taskKind: 'FORECAST_ANALYSIS',
        status: 'UNAVAILABLE',
        attemptedCount,
        successCount: 0,
      });
      return {
        requestId,
        status: 'UNAVAILABLE',
        specification: spec,
        forecastsAttempted: attemptedCount,
        forecastsSucceeded: 0,
        distribution: null,
        synthesis: null,
        forecasts: independentForecasts,
        evidencePackId: evidencePack?.evidencePackId,
        sources: evidencePack?.sources,
      };
    }

    // Compute Descriptive Distribution
    let distribution: ForecastDistribution | null = null;
    const probs = successfulForecasts.map((f) => f.probability!).sort((a, b) => a - b);
    if (probs.length >= 2) {
      const min = probs[0];
      const max = probs[probs.length - 1];
      const spread = max - min;
      let median = probs[0];
      if (probs.length % 2 === 1) {
        median = probs[Math.floor(probs.length / 2)];
      } else {
        const mid = probs.length / 2;
        median = (probs[mid - 1] + probs[mid]) / 2;
      }
      distribution = { min, max, median, spread };
    } else if (probs.length === 1) {
      distribution = { min: probs[0], max: probs[0], median: probs[0], spread: 0 };
    }

    // 5. Forecast Synthesis
    const synthReqId = `${requestId}_synth`;
    const successfulSummaries = successfulForecasts
      .map((f, i) => `Forecast ${i + 1}: Probability=${f.probability}\nRationale: ${f.rationale}\nSupporting: ${f.supportingFactors.join(', ')}\nOpposing: ${f.opposingFactors.join(', ')}`)
      .join('\n\n');

    const synthesisPrompt = `=== FORECAST SPECIFICATION ===
Question: ${spec.question}
Target: ${spec.target}
Resolution Criteria: ${spec.resolutionCriteria}

=== INDEPENDENT FORECAST ASSESSMENTS ===
${successfulSummaries}

=== STATISTICAL DISTRIBUTION ===
${distribution ? `Min: ${distribution.min}, Max: ${distribution.max}, Median: ${distribution.median}, Spread: ${distribution.spread}` : 'Single forecast available.'}

=== EVIDENCE PACK ===
${evidenceSummary}

=== INSTRUCTIONS ===
Synthesize one unified NAgex Forecast.
Do not simply average probabilities mechanically. Use evidence, rationale, and uncertainty to determine the overall probability and range.
Output valid JSON only:
{
  "probability": float (0.0 to 1.0),
  "probabilityRange": { "low": float, "high": float },
  "summary": "string explaining the synthesized forecast",
  "keyDrivers": ["string"],
  "counterSignals": ["string"],
  "uncertainties": ["string"],
  "whatWouldChangeTheForecast": ["string"]
}
Constraint: 0 <= low <= probability <= high <= 1.`;

    let synthesis: ForecastSynthesis | null = null;
    try {
      const synthResponse = await this.router.generate({
        mode: 'auto',
        jsonMode: true,
        routingContext: {
          taskKind: 'FORECAST_SYNTHESIS',
          requiresJson: true,
          requiresEvidenceGrounding: true,
          requestId: synthReqId,
        },
        messages: [
          { role: 'system', content: 'You are the NAgex forecast synthesis engine. Output valid JSON only.' },
          { role: 'user', content: synthesisPrompt },
        ],
      });

      synthesis = parseForecastSynthesisJson(synthResponse.text, synthReqId);

      this.logger.info('forecast_synthesis_completed', {
        requestId: synthReqId,
        taskKind: 'FORECAST_SYNTHESIS',
        status: 'SUCCESS',
      });
    } catch (err: any) {
      this.logger.warn('forecast_synthesis_failed', {
        requestId: synthReqId,
        taskKind: 'FORECAST_SYNTHESIS',
        errorCode: err?.code || 'FORECAST_SYNTHESIS_FAILED',
      });

      // Fallback synthesis from single/partial if schema failed or synthesis model error
      if (successCount === 1) {
        const f = successfulForecasts[0];
        const p = f.probability!;
        const low = Math.max(0, p - 0.1);
        const high = Math.min(1, p + 0.1);
        synthesis = {
          probability: p,
          probabilityRange: { low, high },
          summary: f.rationale || 'Single independent forecast obtained.',
          keyDrivers: f.supportingFactors,
          counterSignals: f.opposingFactors,
          uncertainties: f.uncertaintyDrivers,
          whatWouldChangeTheForecast: f.keyAssumptions,
        };
      } else {
        throw new NagexError({
          code: 'FORECAST_SYNTHESIS_FAILED',
          category: 'PROVIDER',
          message: 'Forecast synthesis failed.',
          request_id: requestId,
        });
      }
    }

    const finalStatus: 'SUCCESS' | 'PARTIAL' = successCount >= 2 ? 'SUCCESS' : 'PARTIAL';

    this.logger.info('forecast_compare_completed', {
      requestId,
      taskKind: 'FORECAST_ANALYSIS',
      status: finalStatus,
      attemptedCount,
      successCount,
      evidencePackId: evidencePack?.evidencePackId,
    });

    return {
      requestId,
      status: finalStatus,
      specification: spec,
      forecastsAttempted: attemptedCount,
      forecastsSucceeded: successCount,
      distribution,
      synthesis,
      forecasts: independentForecasts,
      evidencePackId: evidencePack?.evidencePackId,
      sources: evidencePack?.sources,
    };
  }
}
