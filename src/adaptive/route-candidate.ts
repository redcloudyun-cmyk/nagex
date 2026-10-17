// A ROUTE CANDIDATE: one way of reaching a goal - a provider (and model, agent, tool, host) that could do the work - described by VERIFIED FACTS, never by hope.
//
// This is a read-model over what already exists (the provider adapters, their statuses and capability descriptors, the outcome ledger). It does not replace the CapabilityRegistry (which governs what an
// ACTION may do and what approval it needs) or any provider router; it lets the adaptive layer ask the same questions of every kind of route:
//   can it take this input?  is it authorized and available?  what would it cost?  who would see the data?  how has it behaved lately?
//
// Rules for the facts:
//   * unknown stays unknown: a cost NAgex cannot know is `costUnknown`, an absent reliability record is `null`; nothing is estimated "to be helpful";
//   * quality is NOT a field. There is no measurement of output quality, so no ranking may claim one;
//   * data handling is NAgex's own conservative declaration about what it is willing to send where - it is not a statement about any vendor's practices.

export type CapabilityKind =
  | 'IMAGE_GENERATION'
  | 'VIDEO_GENERATION'
  | 'TEXT_REASONING'
  | 'CODE_GENERATION'
  | 'SITE_DEPLOYMENT'
  | 'BROWSER_ACTION'
  | 'DEVICE_ACTION';

/** S0 low, S1 personal, S2 sensitive, S3 secret - the Trust document's classes. */
export type SensitivityClass = 'S0' | 'S1' | 'S2' | 'S3';
const SENSITIVITY_ORDER: Record<SensitivityClass, number> = { S0: 0, S1: 1, S2: 2, S3: 3 };
export const sensitivityAtMost = (value: SensitivityClass, ceiling: SensitivityClass): boolean => SENSITIVITY_ORDER[value] <= SENSITIVITY_ORDER[ceiling];

export type AuthStatus = 'CONFIGURED' | 'UNCONFIGURED' | 'REJECTED';
export type AvailabilityStatus = 'AVAILABLE' | 'DEGRADED' | 'UNAVAILABLE' | 'UNKNOWN';
export type QuotaStatus = 'OK' | 'EXHAUSTED' | 'UNKNOWN';
export type ProcessingLocation = 'THIRD_PARTY_CLOUD' | 'LOCAL_DEVICE' | 'PRIVATE_ENDPOINT' | 'NAGEX_SERVER';
export type ExecutionRoute = 'API' | 'MCP' | 'BROWSER' | 'DEVICE' | 'LOCAL_PROCESS';

export interface RouteDataHandling {
  processing: ProcessingLocation;
  /** the company (or operator) that receives the data; two routes with the same vendor id share data-handling terms */
  vendorId: string;
  /** the highest class NAgex is willing to send to this route */
  maxSensitivity: SensitivityClass;
  /** known processing region; null = not known (it is never guessed) */
  region: string | null;
}

export interface RouteReliability {
  successes: number;
  failures: number;
  /** the class of the most recent failure, if any */
  lastFailureClass: string | null;
  lastFailureAt: string | null;
  /** median latency of recent successes, if measured */
  medianLatencyMs: number | null;
}

export interface RouteCandidate {
  /** stable: `${capability}:${provider}:${model}` */
  routeId: string;
  capability: CapabilityKind;
  provider: string;
  model: string | null;
  /** a person-facing name, e.g. "Google (gemini-image)"; never an internal id on its own */
  label: string;
  inputs: string[];
  outputs: string[];
  /** what the route can accept beyond modalities, e.g. aspect ratios, max reference images */
  limits: { aspectRatios?: string[]; maxReferenceImages?: number; textInput?: boolean; imageInput?: boolean; maxDurationSeconds?: number };
  auth: AuthStatus;
  availability: AvailabilityStatus;
  quota: QuotaStatus;
  /** when the ledger last saw the quota exhausted (the cooldown is applied from this) */
  quotaExhaustedAt: string | null;
  cost: { usd: number | null; unknown: boolean; basis: 'PROVIDER_QUOTE' | 'PRICE_TABLE' | 'UNKNOWN' };
  dataHandling: RouteDataHandling;
  approval: { required: boolean; reason: string };
  executionRoute: ExecutionRoute;
  reliability: RouteReliability | null;
}

export function routeIdOf(capability: CapabilityKind, provider: string, model: string | null): string {
  return `${capability}:${provider}:${model ?? '-'}`;
}

/** What the goal needs of a route, independent of any provider. */
export interface GoalNeeds {
  capability: CapabilityKind;
  /** modalities the route must accept, e.g. ['TEXT'] or ['TEXT', 'IMAGE'] */
  inputs: string[];
  /** the aspect ratio the output must have, when it matters */
  aspectRatio?: string;
  referenceImages?: number;
  /** the highest sensitivity class of what would be SENT to the route */
  sensitivity: SensitivityClass;
  /** the most the person has authorized for this goal, in USD (null = no spending beyond free use authorized) */
  maxCostUsd: number | null;
}

/** An explicit, person-granted standing consent that lets NAgex switch between routes WITHOUT asking each time. None exists by default. */
export interface StandingAuthorization {
  capability: CapabilityKind;
  allowedVendors: string[];
  maxCostUsd: number;
}
