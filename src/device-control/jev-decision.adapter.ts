// JEV as a DecisionPort provider. JEV is one replaceable provider behind the port (canonical AI/Decision architecture §9: experimental, optional); NAgex's own types, validation and limits live in
// decision-port.ts and do not know JEV exists.
//
// CONTRACT, AND HOW MUCH OF IT IS VERIFIED. The endpoint and the request/answer shape are the ones the repository already uses for JEV System One (model-gateway/jev-provider.ts, exercised by the
// recorded live benchmark): POST {model, state, questions: {name: {type: 'choice' | 'noul' | 'score', instructions, choices?, criteria?}}}, answers at answers.<name>.{choice | probability | score,
// confidence}. Only those three question types and those answer fields are used here; nothing else about JEV is assumed. The four questions asked of it for the device loop (action / risk / retry /
// completion) are NAgex's own and have NOT been run against the live service (no JEV credential was available when this was written): they are exercised by tests against a simulated service of this
// shape. A live run is a separate, explicit step.
//
// PRIVACY: the only thing that is sent is what DecisionRequest can hold - enumerated kinds, counts, outcome categories. No goal, no page text, no typed text, no control names, no address.
import { JEV_MODEL_ALIAS, JEV_SYSTEMONE_ENDPOINT, parseJevHighRiskProbability } from '../model-gateway/jev-provider.js';
import type { DecisionPort, DecisionRequest } from './decision-port.js';
import { COMPLETION_ASSESSMENTS, RETRY_RECOMMENDATIONS, type DecisionReasonCode } from './decision-port.js';

type FetchFn = typeof fetch;

export interface JevDecisionOptions {
  apiKey?: string;
  fetchFn?: FetchFn;
  endpoint?: string;
}

const ACTION_CRITERIA: Record<string, string> = {
  PROCEED: 'Carry out the proposed action as it is.',
  OBSERVE: 'Look at the page again before acting; the page may not have settled.',
  WAIT: 'Wait a moment and look again; the last action may still be taking effect.',
  HANDOFF: 'Hand the task to the person: continuing is likely to be wrong or unsafe.',
};

export function buildJevDecisionBody(request: DecisionRequest): Record<string, unknown> {
  return {
    model: JEV_MODEL_ALIAS,
    state: {
      text: {
        task: 'browser-agent-next-step',
        stepNumber: request.stepNumber,
        remainingSteps: request.remainingSteps,
        proposedAction: request.proposed.action,
        targetRole: request.proposed.targetRole,
        changesAFormControl: request.proposed.formControl,
        repeatsOnTheSamePage: request.repeats,
        checksPassed: request.expectationsMet,
        checksFailed: request.expectationsNotMet,
        recentOutcomes: request.recent.map((entry) => `${entry.action}:${entry.outcome}`),
      },
      signals: {},
    },
    questions: {
      action: {
        type: 'choice',
        instructions: 'Choose exactly one. This is advisory only. Do not include free-form reasoning.',
        criteria: Object.fromEntries(request.candidates.map((id) => [id, ACTION_CRITERIA[id]])),
        choices: request.candidates,
      },
      risk: {
        type: 'noul',
        instructions: 'Return the probability from 0 to 1 that carrying out the proposed action is consequential or unsafe. Advisory only; never approval authority.',
      },
      retry: {
        type: 'choice',
        instructions: 'Choose exactly one. Do not include free-form reasoning.',
        criteria: { CONTINUE: 'Carry on.', RETRY: 'The last step probably failed; try it again.', ABORT: 'Stop: the goal looks unreachable.', TAKEOVER: 'A person should take over.' },
        choices: [...RETRY_RECOMMENDATIONS],
      },
      completion: {
        type: 'choice',
        instructions: 'Choose exactly one. Is the goal complete? Do not include free-form reasoning.',
        criteria: { COMPLETE: 'The goal appears complete.', INCOMPLETE: 'The goal is not complete yet.', UNKNOWN: 'Cannot tell.' },
        choices: [...COMPLETION_ASSESSMENTS],
      },
    },
  };
}

function reasonFor(choiceConfidence: number, risk: number | null, repeats: number, completion: unknown): DecisionReasonCode {
  if (risk !== null && risk >= 0.7) return 'HIGH_RISK';
  if (repeats >= 2) return 'LOOP_SUSPECTED';
  if (choiceConfidence < 0.5) return 'LOW_CONFIDENCE';
  if (completion === 'INCOMPLETE' && choiceConfidence >= 0.5) return 'GOAL_NOT_MET';
  return 'ROUTINE';
}

export class JevDecisionPort implements DecisionPort {
  public readonly provider = 'jev';
  private readonly apiKey: string | null;
  private readonly fetchFn: FetchFn;
  private readonly endpoint: string;

  constructor(options: JevDecisionOptions = {}) {
    this.apiKey = options.apiKey?.trim() || null;
    this.fetchFn = options.fetchFn ?? fetch;
    this.endpoint = options.endpoint ?? JEV_SYSTEMONE_ENDPOINT;
  }

  public configured(): boolean {
    return Boolean(this.apiKey);
  }

  /** Returns the raw answer mapped onto NAgex's field names; DecisionAdvisor validates it (a wrong or missing field is rejected there, never trusted here). */
  public async advise(request: DecisionRequest, signal: AbortSignal): Promise<unknown> {
    if (!this.apiKey) throw new Error('JEV_NOT_CONFIGURED');
    const response = await this.fetchFn(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      signal,
      body: JSON.stringify(buildJevDecisionBody(request)),
    });
    if (!response.ok) throw new Error(`JEV_HTTP_${response.status}`);
    const payload = await response.json() as { answers?: Record<string, { choice?: unknown; confidence?: unknown; probability?: unknown } | undefined> };
    const answers = payload?.answers ?? {};
    const confidence = typeof answers.action?.confidence === 'number' ? answers.action.confidence : NaN;
    const risk = parseJevHighRiskProbability(answers.risk);
    return {
      recommendedActionId: answers.action?.choice,
      actionConfidence: confidence,
      riskProbability: risk,
      retryRecommendation: answers.retry?.choice,
      completionAssessment: answers.completion?.choice,
      decisionReasonCode: reasonFor(Number.isFinite(confidence) ? confidence : 0, risk, request.repeats, answers.completion?.choice),
    };
  }
}
