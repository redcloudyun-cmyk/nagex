// JEV as ONE provider behind RouteAdvisorPort. NAgex's own validation and limits live in route-advisor.ts; nothing there knows JEV exists.
//
// WHAT IS VERIFIED ABOUT JEV, AND WHAT IS NOT. The endpoint and the System One request/answer shape are the ones the repository already uses (model-gateway/jev-provider.ts, exercised by the recorded live
// benchmark; the device-loop advisor in device-control/jev-decision.adapter.ts uses the same): POST {model, state, questions: {name: {type: 'choice' | 'noul' | 'score', instructions, choices?, criteria?}}},
// answers at answers.<name>.{choice | probability | score, confidence}. This adapter asks ONE `choice` question - which offered route to try first - and reads `answers.route.{choice, confidence}`. Nothing
// else about JEV is assumed. The question itself is NAgex's own and has NOT been run against the live service (no JEV credential is configured on this machine): it is exercised against a simulated
// service of the verified shape. A live run is a separate, explicit step.
//
// PRIVACY: only what RouteAdviceRequest can hold is sent - enumerated kinds and buckets, provider ids. No goal, no prompt, no content.
import { JEV_MODEL_ALIAS, JEV_SYSTEMONE_ENDPOINT } from '../model-gateway/jev-provider.js';
import type { RouteAdviceRequest, RouteAdvisorPort } from './route-advisor.js';

type FetchFn = typeof fetch;

export interface JevRouteAdvisorOptions { apiKey?: string; fetchFn?: FetchFn; endpoint?: string }

function criteriaFor(candidate: RouteAdviceRequest['candidates'][number]): string {
  const changes = candidate.changes.length === 0 ? 'terms unchanged' : `changes: ${candidate.changes.join(', ')}`;
  return `Provider ${candidate.provider} (${candidate.vendorId}); cost ${candidate.costBucket}; reliability ${candidate.reliability}; latency ${candidate.latency}; ${changes}; deterministic rank ${candidate.deterministicRank}.`;
}

export function buildJevRouteBody(request: RouteAdviceRequest): Record<string, unknown> {
  return {
    model: JEV_MODEL_ALIAS,
    state: {
      text: {
        task: 'route-selection-after-failure',
        capability: request.capability,
        failureClass: request.failureClass,
        attemptsSoFar: request.attemptsSoFar,
        attemptsRemaining: request.attemptsRemaining,
        candidateCount: request.candidates.length,
      },
      signals: {},
    },
    questions: {
      route: {
        type: 'choice',
        instructions: 'Choose exactly one: the route to try first, or ASK_PERSON to let the person decide, or ABORT to stop. This is advisory only. Do not include free-form reasoning.',
        criteria: {
          ...Object.fromEntries(request.candidates.map((c) => [c.routeId, criteriaFor(c)])),
          ASK_PERSON: 'None of the routes should be used without the person deciding.',
          ABORT: 'Stop: the goal looks unreachable by these routes.',
        },
        choices: [...request.candidates.map((c) => c.routeId), 'ASK_PERSON', 'ABORT'],
      },
    },
  };
}

export class JevRouteAdvisor implements RouteAdvisorPort {
  public readonly provider = 'jev';
  private readonly apiKey: string | null;
  private readonly fetchFn: FetchFn;
  private readonly endpoint: string;

  constructor(options: JevRouteAdvisorOptions = {}) {
    this.apiKey = options.apiKey?.trim() || null;
    this.fetchFn = options.fetchFn ?? fetch;
    this.endpoint = options.endpoint ?? JEV_SYSTEMONE_ENDPOINT;
  }

  public configured(): boolean {
    return Boolean(this.apiKey);
  }

  public async advise(request: RouteAdviceRequest, signal: AbortSignal): Promise<unknown> {
    if (!this.apiKey) throw new Error('JEV_NOT_CONFIGURED');
    const response = await this.fetchFn(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      signal,
      body: JSON.stringify(buildJevRouteBody(request)),
    });
    if (!response.ok) throw new Error(`JEV_HTTP_${response.status}`);
    const payload = await response.json() as { answers?: Record<string, { choice?: unknown; confidence?: unknown } | undefined> };
    const answer = payload?.answers?.route;
    return { recommendedRouteId: answer?.choice, confidence: answer?.confidence };
  }
}
