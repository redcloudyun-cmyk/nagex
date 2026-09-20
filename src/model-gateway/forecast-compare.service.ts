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

export type ForecastCompareStatus =
  | 'SUCCESS'
  | 'PARTIAL'
  | 'UNAVAILABLE'
  | 'NEEDS_CLARIFICATION'
  | 'INFORMATIONAL';

export interface ForecastCompareResult {
  requestId: string;
  status: ForecastCompareStatus;
  specification: ForecastSpecification | null;
  forecastsAttempted: number;
  forecastsSucceeded: number;
  distribution: ForecastDistribution | null;
  synthesis: ForecastSynthesis | null;
  forecasts?: IndependentForecast[];
  evidencePackId?: string;
  sources?: EvidenceSource[];
  clarificationMessage?: string;
  informationalMessage?: string;
}

export interface ForecastCompareOptions {
  query: string;
  tenantId?: string;
  ownerId?: string;
  memories?: MemoryRecord[];
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

export function parseHorizonEnd(query: string, now: Date = new Date()): string | null {
  const q = query.trim();
  const lower = q.toLowerCase();

  // 1. Explicit ISO date in query: e.g. "by 2026-11-30", "2026-12-15"
  const isoMatch = q.match(/(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) {
    const [_, ymd] = isoMatch;
    return `${ymd}T23:59:59+09:00`;
  }

  const monthNames = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

  // Pattern: "before December 15, 2026" or "by December 15, 2026"
  const monthDayYearMatch = lower.match(/(?:before|by|until)\s+([a-z]+)\s+(\d{1,2})(?:\s*,\s*|\s+)(\d{4})/i);
  if (monthDayYearMatch) {
    const mIdx = monthNames.indexOf(monthDayYearMatch[1].toLowerCase());
    if (mIdx !== -1) {
      const year = parseInt(monthDayYearMatch[3], 10);
      const day = parseInt(monthDayYearMatch[2], 10);
      const mm = String(mIdx + 1).padStart(2, '0');
      const dd = String(day).padStart(2, '0');
      return `${year}-${mm}-${dd}T23:59:59+09:00`;
    }
  }

  // Pattern: "before December 2026" / "before December" / "by December 2026" / "by December"
  const monthYearMatch = lower.match(/(?:before|by|until)\s+([a-z]+)(?:\s+(\d{4}))?/i);
  if (monthYearMatch) {
    const mIdx = monthNames.indexOf(monthYearMatch[1].toLowerCase());
    if (mIdx !== -1) {
      const year = monthYearMatch[2] ? parseInt(monthYearMatch[2], 10) : now.getFullYear();
      if (lower.includes('before')) {
        // "before December" means before Dec 1 -> last day of November
        const lastOfPrevMonthDay = new Date(year, mIdx, 0).getDate();
        const prevMonth = mIdx === 0 ? 12 : mIdx;
        const prevYear = mIdx === 0 ? year - 1 : year;
        const mm = String(prevMonth).padStart(2, '0');
        const dd = String(lastOfPrevMonthDay).padStart(2, '0');
        return `${prevYear}-${mm}-${dd}T23:59:59+09:00`;
      } else {
        // "by December" means by end of December -> last day of December
        const lastDay = new Date(year, mIdx + 1, 0).getDate();
        const mm = String(mIdx + 1).padStart(2, '0');
        const dd = String(lastDay).padStart(2, '0');
        return `${year}-${mm}-${dd}T23:59:59+09:00`;
      }
    }
  }

  // Korean month / duration patterns:
  // "이번 달 안에" -> end of current month
  if (q.includes('이번 달') || q.includes('이번달')) {
    const y = now.getFullYear();
    const m = now.getMonth();
    const lastDay = new Date(y, m + 1, 0).getDate();
    const mm = String(m + 1).padStart(2, '0');
    const dd = String(lastDay).padStart(2, '0');
    return `${y}-${mm}-${dd}T23:59:59+09:00`;
  }

  // "10월까지" / "10월 안에" / "10월 전까지"
  const krMonthMatch = q.match(/(\d{1,2})월\s*(?:안에|까지|전까지)?/);
  if (krMonthMatch) {
    const targetMonth = parseInt(krMonthMatch[1], 10); // 1-12
    const currentMonth = now.getMonth() + 1;
    let year = now.getFullYear();
    if (targetMonth < currentMonth) {
      year += 1;
    }
    const lastDay = new Date(year, targetMonth, 0).getDate();
    const mm = String(targetMonth).padStart(2, '0');
    const dd = String(lastDay).padStart(2, '0');
    return `${year}-${mm}-${dd}T23:59:59+09:00`;
  }

  // Relative English: "within two weeks", "in 2 weeks", "by Friday"
  const weeksMatch = lower.match(/(?:within|in)\s+(\d+|two|three|four)\s+weeks?/i);
  if (weeksMatch) {
    let numWeeks = 2;
    if (weeksMatch[1] === 'one') numWeeks = 1;
    if (weeksMatch[1] === 'two') numWeeks = 2;
    if (weeksMatch[1] === 'three') numWeeks = 3;
    if (weeksMatch[1] === 'four') numWeeks = 4;
    if (!isNaN(parseInt(weeksMatch[1], 10))) numWeeks = parseInt(weeksMatch[1], 10);
    const targetDate = new Date(now.getTime() + numWeeks * 7 * 24 * 60 * 60 * 1000);
    const y = targetDate.getFullYear();
    const m = String(targetDate.getMonth() + 1).padStart(2, '0');
    const d = String(targetDate.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}T23:59:59+09:00`;
  }

  // Check for standalone English month name without "before" / "by"
  for (let idx = 0; idx < monthNames.length; idx++) {
    const monthName = monthNames[idx];
    if (lower.includes(monthName)) {
      const yearMatch = lower.match(/\b(20\d{2})\b/);
      const year = yearMatch ? parseInt(yearMatch[1], 10) : now.getFullYear();
      if (lower.includes('before')) {
        const lastOfPrevMonthDay = new Date(year, idx, 0).getDate();
        const prevMonth = idx === 0 ? 12 : idx;
        const prevYear = idx === 0 ? year - 1 : year;
        const mm = String(prevMonth).padStart(2, '0');
        const dd = String(lastOfPrevMonthDay).padStart(2, '0');
        return `${prevYear}-${mm}-${dd}T23:59:59+09:00`;
      } else {
        const lastDay = new Date(year, idx + 1, 0).getDate();
        const mm = String(idx + 1).padStart(2, '0');
        const dd = String(lastDay).padStart(2, '0');
        return `${year}-${mm}-${dd}T23:59:59+09:00`;
      }
    }
  }

  return null;
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
      message: 'Field rationale must be a non-empty string.',
      request_id: requestId,
    });
  }

  const parseStringArray = (arr: any, name: string): string[] => {
    if (!Array.isArray(arr)) {
      throw new NagexError({
        code: 'FORECAST_SCHEMA_FAIL_CLOSED',
        category: 'PROVIDER',
        message: `Field ${name} must be an array of strings.`,
        request_id: requestId,
      });
    }
    return arr.map((item) => {
      if (typeof item !== 'string') {
        throw new NagexError({
          code: 'FORECAST_SCHEMA_FAIL_CLOSED',
          category: 'PROVIDER',
          message: `Elements of ${name} must be strings.`,
          request_id: requestId,
        });
      }
      return item.trim();
    });
  };

  return {
    probability: parsed.probability,
    rationale: parsed.rationale.trim(),
    supportingFactors: parseStringArray(parsed.supportingFactors, 'supportingFactors'),
    opposingFactors: parseStringArray(parsed.opposingFactors, 'opposingFactors'),
    keyAssumptions: parseStringArray(parsed.keyAssumptions, 'keyAssumptions'),
    uncertaintyDrivers: parseStringArray(parsed.uncertaintyDrivers, 'uncertaintyDrivers'),
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
        message: `Field ${name} in synthesis must be an array of strings.`,
        request_id: requestId,
      });
    }
    return arr.map((item) => {
      if (typeof item !== 'string') {
        throw new NagexError({
          code: 'FORECAST_SYNTHESIS_FAILED',
          category: 'PROVIDER',
          message: `Elements of ${name} in synthesis must be strings.`,
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
      if (!optionsSpec.target || !optionsSpec.resolutionCriteria || !optionsSpec.horizonEnd) return null;
      return optionsSpec;
    }

    const q = query.trim();

    // Parse real date horizon — NO synthetic 90-day guessing
    const horizonEnd = parseHorizonEnd(q);
    if (!horizonEnd) {
      return null;
    }

    const horizonStart = new Date().toISOString();
    let target = q.replace(/^(will|can|is|what are the chances|how likely is it that|likely to|이게|이번|성공할|분석해줘|예측해줘|확률을|추정해줘)\s*/i, '').trim();
    if (!target) target = q;

    const resolutionCriteria = `YES if ${target} is verified complete before ${horizonEnd}; otherwise NO.`;

    return {
      question: q,
      target,
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
      this.logger.info('forecast_compare_completed', {
        requestId,
        taskKind: 'FORECAST_ANALYSIS',
        status: 'INFORMATIONAL',
        attemptedCount: 0,
        successCount: 0,
      });
      return {
        requestId,
        status: 'INFORMATIONAL',
        specification: null,
        forecastsAttempted: 0,
        forecastsSucceeded: 0,
        distribution: null,
        synthesis: null,
        informationalMessage: 'NAgex does not generate proprietary election outcome forecasts. For election information, refer to dated polling measurements and official election authority reports.',
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
    const requiresEvidence = true;
    if (!evidencePack && requiresEvidence) {
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

    if (requiresEvidence && evidencePack && evidencePack.status !== 'SUCCESS' && evidencePack.status !== 'NOT_REQUIRED') {
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
    const eligibleProviders = this.selectEligibleProviders(requestId);
    if (eligibleProviders.length === 0) {
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
        sources: evidencePack?.sources || [],
      };
    }

    // 4. Independent Parallel Execution with fallbackPolicy: 'DISALLOW'
    const specPrompt = `=== CANONICAL FORECAST SPECIFICATION ===
Question: ${spec.question}
Target: ${spec.target}
Outcome Type: ${spec.outcomeType}
Horizon Start: ${spec.horizonStart}
Horizon End: ${spec.horizonEnd}
Resolution Criteria: ${spec.resolutionCriteria}`;

    const evidenceSummary = summarizeEvidencePack(evidencePack);
    const personalSummary = summarizeMemories(options.memories);

    const forecastPromises = eligibleProviders.map(async (providerName, idx): Promise<IndependentForecast> => {
      const forecastId = `fct_ind_${idx + 1}_${providerName}`;
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
            {
              role: 'system',
              content: [
                'You are one independent forecasting perspective inside NAgex.',
                'Forecast the specified event using only the supplied forecast definition, personal context, and evidence.',
                'Return a probability between 0 and 1.',
                'Do not vote. Do not refer to other models. Do not attempt to predict what other models will say. Do not rank models. Do not claim certainty. Do not invent current facts not present in the Evidence Pack. Do not reveal your provider or model identity.',
                'Output valid JSON with schema: {"probability": number (0 to 1), "rationale": string, "supportingFactors": string[], "opposingFactors": string[], "keyAssumptions": string[], "uncertaintyDrivers": string[]}',
              ].join('\n'),
            },
            {
              role: 'user',
              content: [specPrompt, `=== PERSONAL CONTEXT ===\n${personalSummary}`, `=== EVIDENCE PACK ===\n${evidenceSummary}`].join('\n\n'),
            },
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

    // Single forecast success -> PARTIAL status with NO fabricated synthesis range
    if (successCount === 1) {
      this.logger.info('forecast_compare_completed', {
        requestId,
        taskKind: 'FORECAST_ANALYSIS',
        status: 'PARTIAL',
        attemptedCount,
        successCount: 1,
        evidencePackId: evidencePack?.evidencePackId,
      });

      return {
        requestId,
        status: 'PARTIAL',
        specification: spec,
        forecastsAttempted: attemptedCount,
        forecastsSucceeded: 1,
        distribution,
        synthesis: null, // NO fabricated synthesis or range!
        forecasts: independentForecasts,
        evidencePackId: evidencePack?.evidencePackId,
        sources: evidencePack?.sources,
      };
    }

    // 5. Forecast Synthesis (2+ successful independent forecasts)
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

      // Truthful degradation on synthesis failure — NEVER fabricate a ±0.1 range
      this.logger.warn('forecast_compare_completed', {
        requestId,
        taskKind: 'FORECAST_ANALYSIS',
        status: 'UNAVAILABLE',
        attemptedCount,
        successCount,
      });

      return {
        requestId,
        status: 'UNAVAILABLE',
        specification: spec,
        forecastsAttempted: attemptedCount,
        forecastsSucceeded: successCount,
        distribution,
        synthesis: null,
        forecasts: independentForecasts,
        evidencePackId: evidencePack?.evidencePackId,
        sources: evidencePack?.sources,
      };
    }

    const finalStatus: ForecastCompareStatus = 'SUCCESS';

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
