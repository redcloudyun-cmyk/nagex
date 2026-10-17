// JEV as ONE advisor for HOW DEEPLY an answer should be checked. NAgex's own rules (verification-policy.ts) decide the level; JEV may only ask for MORE, only when it is confident, and never changes a check,
// a source, an approval or a status. Without it - not configured, slow, failing, malformed - the rules stand and nothing else changes.
//
// WHAT IS VERIFIED ABOUT JEV, AND WHAT IS NOT. Exactly what adaptive/jev-route-advisor.ts says (the endpoint and the System One request/answer shape are the ones the repository already uses): POST {model, state,
// questions: {name: {type: 'choice', instructions, choices, criteria}}}, answer at answers.<name>.{choice, confidence}. This adapter asks ONE `choice` question - the verification level, L0..L3 - and reads
// `answers.level.{choice, confidence}`. The question itself is NAgex's own and has NOT been run against the live service (no JEV credential is configured on this machine): it is exercised against a
// simulated service of the verified shape. A live run is a separate, explicit step.
//
// PRIVACY: only AdviceFeatures are sent - enumerated kinds and buckets. Never the question, the answer, a source or a name.
import { JEV_MODEL_ALIAS, JEV_SYSTEMONE_ENDPOINT } from '../model-gateway/jev-provider.js';
import type { AdviceFeatures, VerificationAdvisorPort } from './verification-flow.js';
import type { LevelAdvice } from './verification-policy.js';
import { VERIFICATION_LEVELS, type VerificationLevel } from './verification.types.js';

type FetchFn = typeof fetch;

export interface JevVerificationAdvisorOptions { apiKey?: string; fetchFn?: FetchFn; endpoint?: string; deadlineMs?: number; maxFailures?: number }

export function buildJevLevelBody(features: AdviceFeatures): Record<string, unknown> {
  return {
    model: JEV_MODEL_ALIAS,
    state: {
      text: {
        task: 'answer-verification-depth',
        freshness: features.freshness,
        category: features.category,
        turnKind: features.turnKind,
        comparison: features.comparison,
        research: features.research,
        highImpact: features.highImpact.join(',') || 'none',
        answerHedged: features.hedged,
        sources: features.sourcesBucket,
        ruleLevel: features.baseLevel,
      },
      signals: {},
    },
    questions: {
      level: {
        type: 'choice',
        instructions: 'Choose exactly one verification level for the answer to this request. This is advisory only: it can only ask for more checking than the rule level. Do not include free-form reasoning.',
        criteria: {
          L0: 'A simple task: one model answer, no verification.',
          L1: 'An ordinary factual task: claims checked against sources where the question needs them.',
          L2: 'Current facts, research or a comparison: the evidence is read independently by a second model and every material claim is checked.',
          L3: 'A high-impact claim or decision (health, law, money, safety): everything in L2, a primary-like source is needed, and the limits are stated.',
        },
        choices: [...VERIFICATION_LEVELS],
      },
    },
  };
}

export class JevVerificationAdvisor implements VerificationAdvisorPort {
  private readonly apiKey: string | null;
  private readonly fetchFn: FetchFn;
  private readonly endpoint: string;
  private readonly deadlineMs: number;
  private readonly maxFailures: number;
  private failures = 0;

  constructor(options: JevVerificationAdvisorOptions = {}) {
    this.apiKey = options.apiKey?.trim() || null;
    this.fetchFn = options.fetchFn ?? fetch;
    this.endpoint = options.endpoint ?? JEV_SYSTEMONE_ENDPOINT;
    this.deadlineMs = options.deadlineMs ?? 2_500;
    this.maxFailures = options.maxFailures ?? 2;
  }

  public configured(): boolean { return Boolean(this.apiKey) && this.failures < this.maxFailures; }

  public async advise(features: AdviceFeatures): Promise<LevelAdvice | null> {
    if (!this.configured()) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.deadlineMs);
    try {
      const response = await this.fetchFn(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        signal: controller.signal,
        body: JSON.stringify(buildJevLevelBody(features)),
      });
      if (!response.ok) throw new Error(`JEV_HTTP_${response.status}`);
      const payload = await response.json() as { answers?: Record<string, { choice?: unknown; confidence?: unknown } | undefined> };
      const answer = payload?.answers?.level;
      const choice = typeof answer?.choice === 'string' ? answer.choice.trim().toUpperCase() : '';
      const confidence = typeof answer?.confidence === 'number' && Number.isFinite(answer.confidence) ? answer.confidence : NaN;
      // anything but one of the four levels with a confidence in [0, 1] is no advice - and counts against the advisor
      if (!(VERIFICATION_LEVELS as readonly string[]).includes(choice) || !(confidence >= 0 && confidence <= 1)) { this.failures += 1; return null; }
      this.failures = 0;
      return { level: choice as VerificationLevel, confidence, provider: 'jev' };
    } catch {
      this.failures += 1;
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
