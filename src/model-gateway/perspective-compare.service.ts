import { randomUUID } from 'node:crypto';
import { NagexError } from '../common/errors.js';
import type { MemoryRecord } from '../context/memory.engine.js';
import type { EvidencePack, EvidenceSource } from '../research/evidence-pack.types.js';
import type { EvidencePackService } from '../research/evidence-pack.service.js';
import type { UnifiedModelRouter, RouterLogger } from './unified-model-router.js';
import type { ModelProvider } from './model-provider.js';

export interface ModelPerspective {
  perspectiveId: string;
  provider: string;
  model: string;
  status: 'SUCCESS' | 'FAILED';
  analysis: string | null;
  latencyMs: number | null;
  errorCode?: string;
}

export interface PerspectiveSynthesisResult {
  answer: string;
  commonGround: string[];
  differingPerspectives: Array<{
    topic: string;
    views: string[];
  }>;
  uncertainties: string[];
}

export interface PerspectiveCompareResult {
  requestId: string;
  status: 'SUCCESS' | 'PARTIAL' | 'UNAVAILABLE';
  perspectivesAttempted: number;
  perspectivesSucceeded: number;
  synthesis: PerspectiveSynthesisResult | null;
  perspectives?: ModelPerspective[];
  evidencePackId?: string;
  sources?: EvidenceSource[];
}

export interface PerspectiveCompareOptions {
  query: string;
  tenantId?: string;
  ownerId?: string;
  memories?: MemoryRecord[];
  requiresEvidenceGrounding?: boolean;
  requestId?: string;
  evidencePack?: EvidencePack;
}

const safeLogger: RouterLogger = {
  info: (event, fields) => console.info(JSON.stringify({ event, ...fields })),
  warn: (event, fields) => console.warn(JSON.stringify({ event, ...fields })),
};

function summarizeMemories(memories?: MemoryRecord[]): string {
  if (!memories || memories.length === 0) return '(No relevant saved memory)';
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

function parseSynthesisJson(text: string, requestId: string): PerspectiveSynthesisResult {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new NagexError({
      code: 'PERSPECTIVE_SYNTHESIS_FAILED',
      category: 'PROVIDER',
      message: 'The synthesis model returned invalid JSON.',
      request_id: requestId,
    });
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new NagexError({
      code: 'PERSPECTIVE_SYNTHESIS_FAILED',
      category: 'PROVIDER',
      message: 'The synthesis model output is not an object.',
      request_id: requestId,
    });
  }

  if (typeof parsed.answer !== 'string' || !parsed.answer.trim()) {
    throw new NagexError({
      code: 'PERSPECTIVE_SYNTHESIS_FAILED',
      category: 'PROVIDER',
      message: 'The synthesis model response is missing answer field.',
      request_id: requestId,
    });
  }

  if (!Array.isArray(parsed.commonGround) || !parsed.commonGround.every((x: any) => typeof x === 'string')) {
    throw new NagexError({
      code: 'PERSPECTIVE_SYNTHESIS_FAILED',
      category: 'PROVIDER',
      message: 'commonGround must be an array of strings.',
      request_id: requestId,
    });
  }

  if (!Array.isArray(parsed.uncertainties) || !parsed.uncertainties.every((x: any) => typeof x === 'string')) {
    throw new NagexError({
      code: 'PERSPECTIVE_SYNTHESIS_FAILED',
      category: 'PROVIDER',
      message: 'uncertainties must be an array of strings.',
      request_id: requestId,
    });
  }

  if (!Array.isArray(parsed.differingPerspectives)) {
    throw new NagexError({
      code: 'PERSPECTIVE_SYNTHESIS_FAILED',
      category: 'PROVIDER',
      message: 'differingPerspectives must be an array.',
      request_id: requestId,
    });
  }

  for (const item of parsed.differingPerspectives) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new NagexError({
        code: 'PERSPECTIVE_SYNTHESIS_FAILED',
        category: 'PROVIDER',
        message: 'differingPerspectives item must be an object.',
        request_id: requestId,
      });
    }
    if (typeof item.topic !== 'string' || !item.topic.trim()) {
      throw new NagexError({
        code: 'PERSPECTIVE_SYNTHESIS_FAILED',
        category: 'PROVIDER',
        message: 'differingPerspectives item topic must be a non-empty string.',
        request_id: requestId,
      });
    }
    if (!Array.isArray(item.views) || !item.views.every((v: any) => typeof v === 'string')) {
      throw new NagexError({
        code: 'PERSPECTIVE_SYNTHESIS_FAILED',
        category: 'PROVIDER',
        message: 'differingPerspectives item views must be an array of strings.',
        request_id: requestId,
      });
    }
  }

  return {
    answer: parsed.answer.trim(),
    commonGround: parsed.commonGround.map((s: string) => s.trim()),
    differingPerspectives: parsed.differingPerspectives.map((item: any) => ({
      topic: item.topic.trim(),
      views: item.views.map((v: string) => v.trim()),
    })),
    uncertainties: parsed.uncertainties.map((s: string) => s.trim()),
  };
}

export class PerspectiveCompareService {
  constructor(
    private readonly router: UnifiedModelRouter,
    private readonly evidencePackService: EvidencePackService,
    private readonly logger: RouterLogger = safeLogger
  ) {}

  public selectEligibleProviders(requestId: string = 'req_eligible'): string[] {
    return this.router.eligibleProviders({
      taskKind: 'PERSPECTIVE_ANALYSIS',
      requiresJson: false,
      requestId,
    }).slice(0, 3);
  }

  public async compare(options: PerspectiveCompareOptions): Promise<PerspectiveCompareResult> {
    const requestId = options.requestId || `cmp_${randomUUID()}`;
    const query = options.query.trim();

    if (!query) {
      throw new NagexError({
        code: 'INVALID_QUERY',
        category: 'VALIDATION',
        message: 'Perspective compare query is required.',
        request_id: requestId,
      });
    }

    this.logger.info('perspective_compare_started', {
      requestId,
      taskKind: 'PERSPECTIVE_ANALYSIS',
    });

    // 1. ONE SHARED EVIDENCE PACK (ONE_EVIDENCE_PACK_PER_COMPARE = 1)
    let evidencePack: EvidencePack | undefined = options.evidencePack;
    if (!evidencePack && options.requiresEvidenceGrounding !== false) {
      evidencePack = await this.evidencePackService.buildEvidencePack(query, {
        forceSearch: false,
        requestId,
      });
    }

    // 2. ELIGIBLE PROVIDER SELECTION
    const eligibleProviderNames = this.selectEligibleProviders();

    if (eligibleProviderNames.length === 0) {
      this.logger.warn('perspective_compare_completed', {
        requestId,
        taskKind: 'PERSPECTIVE_ANALYSIS',
        status: 'UNAVAILABLE',
        attemptedCount: 0,
        successCount: 0,
      });

      return {
        requestId,
        status: 'UNAVAILABLE',
        perspectivesAttempted: 0,
        perspectivesSucceeded: 0,
        synthesis: null,
        perspectives: [],
        evidencePackId: evidencePack?.evidencePackId,
        sources: [],
      };
    }

    // 3. INDEPENDENT PARALLEL PERSPECTIVE EXECUTION
    const perspectivePromises = eligibleProviderNames.map(async (providerName, index) => {
      const pId = `persp_${index + 1}_${providerName}`;
      const startedAt = Date.now();
      try {
        const response = await this.router.generate({
          mode: providerName,
          fallbackPolicy: 'DISALLOW', // Guaranteed NO fallback substitution
          jsonMode: false,
          routingContext: {
            taskKind: 'PERSPECTIVE_ANALYSIS',
            requiresJson: false,
            requestId: `${requestId}_${providerName}`,
          },
          messages: [
            {
              role: 'system',
              content: [
                'You are one independent analytical perspective inside NAgex.',
                'Evaluate the user\'s request using only the supplied evidence and context.',
                'Do not claim consensus. Do not speculate about what other models think. Do not rank models. Do not vote. Do not decide which model is best.',
                'Identify the most important interpretation, supporting reasoning, relevant tradeoffs, important uncertainty, and issues another analyst might reasonably view differently.',
                'Do not reveal internal provider identity inside generated prose.',
              ].join('\n'),
            },
            {
              role: 'user',
              content: [
                `=== USER REQUEST ===\n${query}`,
                `=== PERSONAL CONTEXT ===\n${summarizeMemories(options.memories)}`,
                `=== EVIDENCE PACK ===\n${summarizeEvidencePack(evidencePack)}`,
              ].join('\n\n'),
            },
          ],
        });

        const latencyMs = Date.now() - startedAt;
        this.logger.info('perspective_provider_completed', {
          requestId,
          taskKind: 'PERSPECTIVE_ANALYSIS',
          provider: response.provider,
          latencyMs,
          status: 'SUCCESS',
          evidencePackId: evidencePack?.evidencePackId,
        });

        const perspective: ModelPerspective = {
          perspectiveId: pId,
          provider: response.provider,
          model: response.model,
          status: 'SUCCESS',
          analysis: response.text,
          latencyMs,
        };
        return perspective;
      } catch (err: any) {
        const latencyMs = Date.now() - startedAt;
        const errCode = err?.code || 'PROVIDER_FAILURE';
        this.logger.warn('perspective_provider_failed', {
          requestId,
          taskKind: 'PERSPECTIVE_ANALYSIS',
          provider: providerName,
          latencyMs,
          status: 'FAILED',
          errorCode: errCode,
          evidencePackId: evidencePack?.evidencePackId,
        });

        const perspective: ModelPerspective = {
          perspectiveId: pId,
          provider: providerName,
          model: 'unknown',
          status: 'FAILED',
          analysis: null,
          latencyMs,
          errorCode: errCode,
        };
        return perspective;
      }
    });

    const results = await Promise.allSettled(perspectivePromises);
    const perspectives: ModelPerspective[] = results.map((r) =>
      r.status === 'fulfilled' ? r.value : {
        perspectiveId: `persp_err_${randomUUID()}`,
        provider: 'unknown',
        model: 'unknown',
        status: 'FAILED',
        analysis: null,
        latencyMs: null,
        errorCode: 'UNHANDLED_REJECTION',
      }
    );

    const successfulPerspectives = perspectives.filter((p) => p.status === 'SUCCESS' && p.analysis);
    const attemptedCount = eligibleProviderNames.length;
    const succeededCount = successfulPerspectives.length;

    // 4. PARTIAL / UNAVAILABLE HANDLING
    if (succeededCount === 0) {
      this.logger.warn('perspective_compare_completed', {
        requestId,
        taskKind: 'PERSPECTIVE_ANALYSIS',
        status: 'UNAVAILABLE',
        attemptedCount,
        successCount: 0,
      });

      return {
        requestId,
        status: 'UNAVAILABLE',
        perspectivesAttempted: attemptedCount,
        perspectivesSucceeded: 0,
        synthesis: null,
        perspectives,
        evidencePackId: evidencePack?.evidencePackId,
        sources: [],
      };
    }

    if (succeededCount === 1) {
      this.logger.info('perspective_compare_completed', {
        requestId,
        taskKind: 'PERSPECTIVE_ANALYSIS',
        status: 'PARTIAL',
        attemptedCount,
        successCount: 1,
      });

      return {
        requestId,
        status: 'PARTIAL',
        perspectivesAttempted: attemptedCount,
        perspectivesSucceeded: 1,
        synthesis: {
          answer: `I could only complete one independent analysis, so I couldn't reliably compare multiple perspectives. Here is the available analysis:\n\n${successfulPerspectives[0].analysis}`,
          commonGround: [],
          differingPerspectives: [],
          uncertainties: [],
        },
        perspectives,
        evidencePackId: evidencePack?.evidencePackId,
        sources: evidencePack?.sources || [],
      };
    }

    // 5. STRUCTURED PERSPECTIVE SYNTHESIS (PERSPECTIVE_SYNTHESIS)
    const formattedPerspectives = successfulPerspectives
      .map((p, i) => `=== INDEPENDENT PERSPECTIVE ${i + 1} ===\n${p.analysis}`)
      .join('\n\n');

    try {
      const synthResponse = await this.router.generate({
        mode: 'auto',
        fallbackPolicy: 'ALLOW',
        jsonMode: true,
        routingContext: {
          taskKind: 'PERSPECTIVE_SYNTHESIS',
          requiresJson: true,
          requestId: `${requestId}_synth`,
        },
        messages: [
          {
            role: 'system',
            content: [
              'You are the NAgex Perspective Synthesis model. You synthesize independent analytical perspectives into a single unified NAgex answer.',
              'You must NOT perform voting, majority rule, winner selection, model ranking, or model scoring.',
              'Identify common ground, differing perspectives/tradeoffs, and uncertainties.',
              'Do not mention raw provider or model names (e.g. GPT, Gemini, Nebius) in the synthesis output prose.',
              'Return JSON only with this exact shape:',
              '{"answer":"string","commonGround":["string"],"differingPerspectives":[{"topic":"string","views":["string"]}],"uncertainties":["string"]}',
            ].join('\n'),
          },
          {
            role: 'user',
            content: [
              `=== USER REQUEST ===\n${query}`,
              `=== PERSONAL CONTEXT ===\n${summarizeMemories(options.memories)}`,
              `=== EVIDENCE PACK ===\n${summarizeEvidencePack(evidencePack)}`,
              formattedPerspectives,
            ].join('\n\n'),
          },
        ],
      });

      const synthesis = parseSynthesisJson(synthResponse.text, requestId);

      const finalStatus = succeededCount === attemptedCount ? 'SUCCESS' : 'PARTIAL';

      this.logger.info('perspective_synthesis_completed', {
        requestId,
        taskKind: 'PERSPECTIVE_SYNTHESIS',
        provider: synthResponse.provider,
        latencyMs: synthResponse.latencyMs,
      });

      this.logger.info('perspective_compare_completed', {
        requestId,
        taskKind: 'PERSPECTIVE_ANALYSIS',
        status: finalStatus,
        attemptedCount,
        successCount: succeededCount,
        evidencePackId: evidencePack?.evidencePackId,
      });

      return {
        requestId,
        status: finalStatus,
        perspectivesAttempted: attemptedCount,
        perspectivesSucceeded: succeededCount,
        synthesis,
        perspectives,
        evidencePackId: evidencePack?.evidencePackId,
        sources: evidencePack?.sources || [],
      };
    } catch (error: any) {
      this.logger.warn('perspective_synthesis_failed', {
        requestId,
        taskKind: 'PERSPECTIVE_SYNTHESIS',
        error: error?.code || 'SYNTHESIS_FAILED',
      });

      // Truthful synthesis failure handling
      throw new NagexError({
        code: 'PERSPECTIVE_SYNTHESIS_FAILED',
        category: 'PROVIDER',
        message: 'Failed to synthesize independent perspectives.',
        request_id: requestId,
      });
    }
  }
}
