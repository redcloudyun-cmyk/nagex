import { randomUUID } from 'node:crypto';
import { NagexError } from '../common/errors.js';
import type { MemoryRecord } from '../context/memory.engine.js';
import type { RoutingMode } from './model-provider.js';
import { UnifiedModelRouter } from './unified-model-router.js';

export interface PlanStep {
  step: number;
  title: string;
  reasoning: string;
  skill: string;
  tool: string | null;
  requiresApproval: boolean;
}

export interface PlanPreview {
  goal: string;
  summary: string;
  reasoningSummary: string;
  steps: PlanStep[];
}

export interface AiServiceResponse<T> {
  data: T;
  provider: string;
  model: string;
  latencyMs: number;
  requestId: string;
}

function parseJsonObject(text: string, requestId: string): Record<string, unknown> {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const parsed: unknown = JSON.parse(cleaned);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed as Record<string, unknown>;
  } catch {
    throw new NagexError({ code: 'INVALID_MODEL_RESPONSE', category: 'PROVIDER', message: 'The model returned invalid structured plan JSON.', request_id: requestId });
  }
}

function requireString(value: unknown, field: string, requestId: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new NagexError({ code: 'INVALID_MODEL_RESPONSE', category: 'PROVIDER', message: `The model response is missing ${field}.`, request_id: requestId });
  }
  return value.trim();
}

function normalizePlan(text: string, requestId: string): PlanPreview {
  const raw = parseJsonObject(text, requestId);
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
    throw new NagexError({ code: 'INVALID_MODEL_RESPONSE', category: 'PROVIDER', message: 'The model response contains no plan steps.', request_id: requestId });
  }
  return {
    goal: requireString(raw.goal, 'goal', requestId),
    summary: requireString(raw.summary, 'summary', requestId),
    reasoningSummary: requireString(raw.reasoningSummary, 'reasoningSummary', requestId),
    steps: raw.steps.map((value, index) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new NagexError({ code: 'INVALID_MODEL_RESPONSE', category: 'PROVIDER', message: `Plan step ${index + 1} is invalid.`, request_id: requestId });
      }
      const step = value as Record<string, unknown>;
      return {
        step: index + 1,
        title: requireString(step.title, `steps[${index}].title`, requestId),
        reasoning: requireString(step.reasoning, `steps[${index}].reasoning`, requestId),
        skill: requireString(step.skill, `steps[${index}].skill`, requestId),
        tool: typeof step.tool === 'string' && step.tool.trim() ? step.tool.trim() : null,
        requiresApproval: step.requiresApproval === true,
      };
    }),
  };
}

function summarizeMemories(memories: MemoryRecord[]): string {
  if (memories.length === 0) return 'No relevant saved memory.';
  return memories.slice(0, 8).map((memory) => {
    const content = memory.content;
    return `- ${content.subject} ${content.predicate}: ${String(content.value)}`;
  }).join('\n');
}

export class AiService {
  constructor(private readonly router: UnifiedModelRouter) {}

  public statuses() {
    return this.router.statuses();
  }

  public async chat(input: { message: string; mode: RoutingMode; requestId?: string }): Promise<AiServiceResponse<{ message: string }>> {
    const requestId = input.requestId || `chat_${randomUUID()}`;
    const response = await this.router.generate({
      mode: input.mode,
      requestId,
      messages: [
        { role: 'system', content: 'You are NAgex, a personal AI assistant. Be concise and do not claim that tools were executed.' },
        { role: 'user', content: input.message },
      ],
    });
    return { data: { message: response.text }, provider: response.provider, model: response.model, latencyMs: response.latencyMs, requestId: response.requestId };
  }

  public async plan(input: { prompt: string; memories: MemoryRecord[]; mode: RoutingMode; requestId?: string }): Promise<AiServiceResponse<PlanPreview>> {
    const requestId = input.requestId || `plan_${randomUUID()}`;
    const response = await this.router.generate({
      mode: input.mode,
      requestId,
      jsonMode: true,
      validate: (text) => { normalizePlan(text, requestId); },
      messages: [
        {
          role: 'system',
          content: [
            'You are the NAgex planning model. Produce a plan preview only. Never claim to execute tools, send messages, schedule events, or modify data.',
            'Return JSON only with this exact shape:',
            '{"goal":"string","summary":"string","reasoningSummary":"brief rationale without hidden chain-of-thought","steps":[{"title":"string","reasoning":"brief justification","skill":"string","tool":"string or null","requiresApproval":true}]}',
            'Mark any consequential tool step as requiresApproval=true.',
          ].join('\n'),
        },
        { role: 'user', content: `User intent:\n${input.prompt}\n\nRelevant memory:\n${summarizeMemories(input.memories)}` },
      ],
    });
    return { data: normalizePlan(response.text, requestId), provider: response.provider, model: response.model, latencyMs: response.latencyMs, requestId: response.requestId };
  }
}

export function parseRoutingMode(value: unknown, fallback: string | undefined): RoutingMode {
  const mode = (typeof value === 'string' ? value : fallback || 'auto').toLowerCase();
  if (/^[a-z0-9][a-z0-9_-]*$/.test(mode)) return mode;
  throw new NagexError({ code: 'INVALID_ROUTING_MODE', category: 'VALIDATION', message: 'Routing mode must be auto or a registered provider ID.', request_id: `req_${randomUUID()}` });
}
