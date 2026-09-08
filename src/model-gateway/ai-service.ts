import { randomUUID } from 'node:crypto';
import { NagexError } from '../common/errors.js';
import type { MemoryRecord } from '../context/memory.engine.js';
import type { RoutingMode } from './model-provider.js';
import { UnifiedModelRouter } from './unified-model-router.js';

export type PlanStepNecessity = 'REQUIRED' | 'OPTIONAL';

export interface PlanStep {
  step: number;
  title: string;
  reasoning: string;
  skill: string;
  tool: string | null;
  requiresApproval: boolean;
  // Optional so hand-built PlanPreview literals (tests, direct API callers)
  // remain valid; PlanResolver defaults a missing value to REQUIRED/[].
  necessity?: PlanStepNecessity;
  dependsOn?: number[];
}

export interface PlanPreview {
  goal: string;
  summary: string;
  reasoningSummary: string;
  steps: PlanStep[];
  // Non-blocking ideas the model has but the user did not ask for — must
  // never become executable steps (see the scope policy in plan()).
  suggestions?: string[];
}

export interface AiServiceResponse<T> {
  data: T;
  provider: string;
  model: string;
  latencyMs: number;
  requestId: string;
}

function parseJsonObject(text: string, requestId: string, context: string = 'structured plan'): Record<string, unknown> {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const parsed: unknown = JSON.parse(cleaned);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed as Record<string, unknown>;
  } catch {
    throw new NagexError({ code: 'INVALID_MODEL_RESPONSE', category: 'PROVIDER', message: `The model returned invalid ${context} JSON.`, request_id: requestId });
  }
}

function requireString(value: unknown, field: string, requestId: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new NagexError({ code: 'INVALID_MODEL_RESPONSE', category: 'PROVIDER', message: `The model response is missing ${field}.`, request_id: requestId });
  }
  return value.trim();
}

function normalizeNecessity(value: unknown): PlanStepNecessity {
  return value === 'OPTIONAL' ? 'OPTIONAL' : 'REQUIRED';
}

function normalizeDependsOn(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((v): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1))];
}

function normalizeSuggestions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim());
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
    suggestions: normalizeSuggestions(raw.suggestions),
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
        necessity: normalizeNecessity(step.necessity),
        dependsOn: normalizeDependsOn(step.dependsOn),
      };
    }),
  };
}

// ── Real Text Understanding (Phase 1 STEP 2) ────────────────────────────────
// Structured, grounded understanding of a single piece of TEXT content.
// Candidates here are proposals only (status PROPOSED is attached by the
// caller) — this layer never persists or executes anything.

export interface TextUnderstandingEntity {
  name: string;
  type: string;
}

export interface TextUnderstandingDate {
  text: string;
  normalized: string | null;
  confidence: number;
}

export interface TextUnderstandingActionItem {
  text: string;
  confidence: number;
}

export interface TextUnderstandingTaskCandidate {
  title: string;
  description?: string;
  priorityCandidate?: 'LOW' | 'MEDIUM' | 'HIGH';
  dueDateCandidate?: string;
  confidence: number;
}

export interface TextUnderstandingCalendarCandidate {
  title: string;
  startCandidate?: string;
  endCandidate?: string;
  timezone?: string;
  location?: string;
  confidence: number;
}

export interface TextUnderstandingMemoryCandidate {
  statement: string;
  memoryType?: 'USER' | 'FACT' | 'PREFERENCE';
  confidence: number;
}

export interface TextUnderstandingKnowledgeCandidate {
  title: string;
  summary: string;
  tags?: string[];
  confidence: number;
}

export interface TextUnderstandingResult {
  title: string;
  summary: string;
  contentType: string;
  topics: string[];
  entities: TextUnderstandingEntity[];
  dates: TextUnderstandingDate[];
  actionItems: TextUnderstandingActionItem[];
  taskCandidates: TextUnderstandingTaskCandidate[];
  calendarCandidates: TextUnderstandingCalendarCandidate[];
  memoryCandidates: TextUnderstandingMemoryCandidate[];
  knowledgeCandidates: TextUnderstandingKnowledgeCandidate[];
}

function clampConfidence(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : 0.5;
  return Math.max(0, Math.min(1, n));
}

function asObjectArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v));
}

function normalizeEntities(value: unknown): TextUnderstandingEntity[] {
  return asObjectArray(value)
    .map((v) => ({ name: typeof v.name === 'string' ? v.name.trim() : '', type: typeof v.type === 'string' && v.type.trim() ? v.type.trim() : 'OTHER' }))
    .filter((e) => e.name.length > 0);
}

function normalizeDates(value: unknown): TextUnderstandingDate[] {
  return asObjectArray(value)
    .map((v) => ({
      text: typeof v.text === 'string' ? v.text.trim() : '',
      // Ambiguous/unstated dates must stay null — never a guessed resolution.
      normalized: typeof v.normalized === 'string' && v.normalized.trim() ? v.normalized.trim() : null,
      confidence: clampConfidence(v.confidence),
    }))
    .filter((d) => d.text.length > 0);
}

function normalizeActionItems(value: unknown): TextUnderstandingActionItem[] {
  return asObjectArray(value)
    .map((v) => ({ text: typeof v.text === 'string' ? v.text.trim() : '', confidence: clampConfidence(v.confidence) }))
    .filter((a) => a.text.length > 0);
}

function normalizePriority(value: unknown): 'LOW' | 'MEDIUM' | 'HIGH' {
  if (value === 'LOW') return 'LOW';
  if (value === 'HIGH') return 'HIGH';
  return 'MEDIUM';
}

function normalizeTaskCandidates(value: unknown): TextUnderstandingTaskCandidate[] {
  return asObjectArray(value)
    .map((v) => ({
      title: typeof v.title === 'string' ? v.title.trim() : '',
      description: typeof v.description === 'string' && v.description.trim() ? v.description.trim() : undefined,
      priorityCandidate: normalizePriority(v.priorityCandidate),
      dueDateCandidate: typeof v.dueDateCandidate === 'string' && v.dueDateCandidate.trim() ? v.dueDateCandidate.trim() : undefined,
      confidence: clampConfidence(v.confidence),
    }))
    .filter((t) => t.title.length > 0);
}

function normalizeCalendarCandidates(value: unknown): TextUnderstandingCalendarCandidate[] {
  return asObjectArray(value)
    .map((v) => ({
      title: typeof v.title === 'string' ? v.title.trim() : '',
      startCandidate: typeof v.startCandidate === 'string' && v.startCandidate.trim() ? v.startCandidate.trim() : undefined,
      endCandidate: typeof v.endCandidate === 'string' && v.endCandidate.trim() ? v.endCandidate.trim() : undefined,
      timezone: typeof v.timezone === 'string' && v.timezone.trim() ? v.timezone.trim() : undefined,
      location: typeof v.location === 'string' && v.location.trim() ? v.location.trim() : undefined,
      confidence: clampConfidence(v.confidence),
    }))
    .filter((c) => c.title.length > 0);
}

function normalizeMemoryType(value: unknown): 'USER' | 'FACT' | 'PREFERENCE' {
  if (value === 'FACT') return 'FACT';
  if (value === 'PREFERENCE') return 'PREFERENCE';
  return 'USER';
}

function normalizeMemoryCandidates(value: unknown): TextUnderstandingMemoryCandidate[] {
  return asObjectArray(value)
    .map((v) => ({
      statement: typeof v.statement === 'string' ? v.statement.trim() : '',
      memoryType: normalizeMemoryType(v.memoryType),
      confidence: clampConfidence(v.confidence),
    }))
    .filter((m) => m.statement.length > 0);
}

function normalizeKnowledgeCandidates(value: unknown): TextUnderstandingKnowledgeCandidate[] {
  return asObjectArray(value)
    .map((v) => ({
      title: typeof v.title === 'string' ? v.title.trim() : '',
      summary: typeof v.summary === 'string' ? v.summary.trim() : '',
      tags: Array.isArray(v.tags) ? v.tags.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).map((t) => t.trim()) : undefined,
      confidence: clampConfidence(v.confidence),
    }))
    .filter((k) => k.title.length > 0 && k.summary.length > 0);
}

function normalizeUnderstanding(text: string, requestId: string): TextUnderstandingResult {
  const raw = parseJsonObject(text, requestId, 'text understanding');
  return {
    title: requireString(raw.title, 'title', requestId),
    summary: requireString(raw.summary, 'summary', requestId),
    contentType: typeof raw.contentType === 'string' && raw.contentType.trim() ? raw.contentType.trim() : 'note',
    topics: Array.isArray(raw.topics) ? raw.topics.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).map((t) => t.trim()) : [],
    entities: normalizeEntities(raw.entities),
    dates: normalizeDates(raw.dates),
    actionItems: normalizeActionItems(raw.actionItems),
    taskCandidates: normalizeTaskCandidates(raw.taskCandidates),
    calendarCandidates: normalizeCalendarCandidates(raw.calendarCandidates),
    memoryCandidates: normalizeMemoryCandidates(raw.memoryCandidates),
    knowledgeCandidates: normalizeKnowledgeCandidates(raw.knowledgeCandidates),
  };
}

const TEXT_UNDERSTANDING_SYSTEM_PROMPT = [
  'You are the NAgex text understanding model. You analyze a single piece of captured text and extract only what is explicitly grounded in it.',
  'Never invent dates, people, organizations, or tasks that are not present in the text. Distinguish an explicit fact stated in the text from an inferred suggestion.',
  'Candidate generation must be conservative: only propose a taskCandidates/calendarCandidates/memoryCandidates/knowledgeCandidates entry when the text clearly and specifically supports it. When in doubt, omit it — an empty array is correct far more often than a proposed candidate. Never create a candidate merely to appear thorough.',
  'If a date or detail is ambiguous, relative without a clear anchor, or not stated precisely, set "normalized" to null rather than guessing a resolved date.',
  'Return JSON only with this exact shape:',
  '{"title":"string","summary":"string","contentType":"note|idea|task|document|article","topics":["string"],"entities":[{"name":"string","type":"string"}],"dates":[{"text":"string as it appears in the source","normalized":"YYYY-MM-DD or null","confidence":0.0}],"actionItems":[{"text":"string","confidence":0.0}],"taskCandidates":[{"title":"string","description":"string","priorityCandidate":"LOW|MEDIUM|HIGH","dueDateCandidate":"YYYY-MM-DD (omit if unknown)","confidence":0.0}],"calendarCandidates":[{"title":"string","startCandidate":"ISO datetime","endCandidate":"ISO datetime (omit if unknown)","location":"string (omit if unknown)","confidence":0.0}],"memoryCandidates":[{"statement":"string","memoryType":"USER|PREFERENCE|FACT","confidence":0.0}],"knowledgeCandidates":[{"title":"string","summary":"string","tags":["string"],"confidence":0.0}]}',
  'taskCandidates/calendarCandidates/memoryCandidates/knowledgeCandidates are almost always empty arrays. Only populate one when the text is unambiguous: an explicit thing the user needs to do (task), an explicit event with a date/time (calendar), a durable personal preference or fact worth remembering (memory), or substantial reference material worth indexing (knowledge).',
].join('\n');

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
            'STRICT USER-INTENT SCOPE POLICY: Do not add consequential actions, communications, research, document creation, notifications, or external tool usage that the user did not explicitly request or that are not strictly necessary to fulfill the request.',
            'Minimal-action principle: generate only the minimum number of steps necessary to fulfill the user\'s explicit request. A simple scheduling request ("schedule a meeting tomorrow at 2 PM for 30 minutes titled X") normally requires exactly one step: creating the calendar event with the best available live tool that exactly matches the request. Do not add agenda preparation, email, Slack, Notion, research, or attendee-notification steps unless the user explicitly asked for them.',
            'If an additional action could plausibly help but the user did not ask for it, do NOT add it as a plan step. Instead put a short question about it in the top-level "suggestions" array, e.g. "Would you like me to prepare an agenda?". Suggestions are informational only and must never block, gate, or replace the requested action.',
            'Every step must declare "necessity" as REQUIRED or OPTIONAL. Use REQUIRED only for steps strictly necessary to fulfill what the user explicitly asked. Prefer moving anything not explicitly requested into "suggestions" rather than adding it as an OPTIONAL step.',
            'Prefer a tool that is already connected and LIVE when it exactly satisfies the request, over any other tool, mock, or manual alternative.',
            'Prefer canonical registered IDs for "skill" and "tool" whenever one exists, instead of an arbitrary free-text identifier. For creating a calendar event, use skill "skill.scheduling" and tool "google_calendar.create_event" exactly.',
            'Ranking for what informs a step: (1) the user\'s current explicit instruction, (2) the current conversation context, (3) memory the user\'s current request itself confirms as relevant, (4) general/background memory. Memory may enrich a step. Memory must never override, replace, or expand the user\'s explicit current instruction: do not attach an unrelated prior project, client, or company (e.g. from saved memory) to the current request unless the user\'s current request itself names it or the conversation has already confirmed it applies. When a generic request (e.g. "my next client meeting") does not itself name a specific client or company, use a neutral description like "the next client meeting" — never assert a specific company, attendee, meeting title, or purpose from weak memory relevance alone.',
            'Never invent concrete scheduling details (date, time, duration, title, attendees) that are not present in the user\'s request or already-confirmed conversation context. If a calendar-creation step is required but a concrete detail is missing, do not fabricate it — say so in reasoningSummary and/or ask for it via "suggestions" instead of guessing.',
            'Each step must declare "dependsOn": an array of the 1-based step numbers (from this same steps array) it strictly requires to have executed first, or [] when it has none. Only mark a real dependency (e.g. "send the invite" depending on "create the event"); never invent a dependency between unrelated steps.',
            'Return JSON only with this exact shape:',
            '{"goal":"string","summary":"string","reasoningSummary":"brief rationale without hidden chain-of-thought","suggestions":["string", ...],"steps":[{"title":"string","reasoning":"brief justification","skill":"string","tool":"string or null","requiresApproval":true,"necessity":"REQUIRED or OPTIONAL","dependsOn":[1,2]}]}',
            'Mark any consequential tool step as requiresApproval=true.',
          ].join('\n'),
        },
        { role: 'user', content: `User intent:\n${input.prompt}\n\nRelevant memory:\n${summarizeMemories(input.memories)}` },
      ],
    });
    return { data: normalizePlan(response.text, requestId), provider: response.provider, model: response.model, latencyMs: response.latencyMs, requestId: response.requestId };
  }

  // Real, model-backed understanding of captured TEXT content (Phase 1
  // STEP 2). Throws (NO_MODEL_PROVIDER_CONFIGURED / ALL_MODEL_PROVIDERS_FAILED
  // / INVALID_MODEL_RESPONSE) when no provider actually produces a valid,
  // schema-conforming result — callers must never treat that as success.
  public async understand(input: { content: string; contentType: string; defaultTitle?: string; mode?: RoutingMode; requestId?: string }): Promise<AiServiceResponse<TextUnderstandingResult>> {
    const requestId = input.requestId || `understand_${randomUUID()}`;
    const response = await this.router.generate({
      mode: input.mode || 'auto',
      requestId,
      jsonMode: true,
      validate: (text) => { normalizeUnderstanding(text, requestId); },
      messages: [
        { role: 'system', content: TEXT_UNDERSTANDING_SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            `Content type: ${input.contentType}`,
            input.defaultTitle ? `Suggested title context (do not use unless it matches the content): ${input.defaultTitle}` : null,
            'Content:',
            '"""',
            input.content,
            '"""',
          ].filter((line): line is string => line !== null).join('\n'),
        },
      ],
    });
    return { data: normalizeUnderstanding(response.text, requestId), provider: response.provider, model: response.model, latencyMs: response.latencyMs, requestId: response.requestId };
  }
}

export function parseRoutingMode(value: unknown, fallback: string | undefined): RoutingMode {
  const mode = (typeof value === 'string' ? value : fallback || 'auto').toLowerCase();
  if (/^[a-z0-9][a-z0-9_-]*$/.test(mode)) return mode;
  throw new NagexError({ code: 'INVALID_ROUTING_MODE', category: 'VALIDATION', message: 'Routing mode must be auto or a registered provider ID.', request_id: `req_${randomUUID()}` });
}
