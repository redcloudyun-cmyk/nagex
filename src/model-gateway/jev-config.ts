// Where NAgex finds the JEV credential, and what that means for the JEV advisors - facts about CONFIGURATION only. Nothing here ever returns, logs or serializes the key: callers that need the key
// itself (the adapters that send it as a bearer token) take it from resolveJevApiKey(); everything that is shown or reported takes describeJevConfig(), which carries the NAME of the variable the key
// came from and a boolean, never a character of the value.
//
// Two names exist in this repository's history: NAGEX_JEV_API_KEY (the DecisionPort, route advisor and verification advisor) and JEVMODEL_API_KEY (the original System One provider and its live scripts,
// docs/hackathon/NAGEX_JEV_SHADOW_BENCHMARK_2026.md). A key registered under either name is the same credential, so both are read and nobody is asked to register it again.
export const JEV_KEY_ENV_PRIMARY = 'NAGEX_JEV_API_KEY';
export const JEV_KEY_ENV_LEGACY = 'JEVMODEL_API_KEY';
export const JEV_DECISION_ENABLED_ENV = 'NAGEX_JEV_DECISION_ENABLED';
export const JEV_ADVISORY_ENABLED_ENV = 'NAGEX_JEV_ADVISORY_ENABLED';

export type JevKeySource = typeof JEV_KEY_ENV_PRIMARY | typeof JEV_KEY_ENV_LEGACY;

export interface JevKeyResolution {
  /** The credential, for the adapters only. Never put this in a log, a report, an error or a response. */
  key: string | null;
  source: JevKeySource | null;
}

const present = (value: string | undefined): string => String(value ?? '').trim();

/** NAGEX_JEV_API_KEY wins; JEVMODEL_API_KEY is read when it is not set. An empty or whitespace value is not a key. */
export function resolveJevApiKey(env: NodeJS.ProcessEnv = process.env): JevKeyResolution {
  const primary = present(env[JEV_KEY_ENV_PRIMARY]);
  if (primary) return { key: primary, source: JEV_KEY_ENV_PRIMARY };
  const legacy = present(env[JEV_KEY_ENV_LEGACY]);
  if (legacy) return { key: legacy, source: JEV_KEY_ENV_LEGACY };
  return { key: null, source: null };
}

export type JevConfigBlocker = 'NO_API_KEY' | 'DECISION_NOT_ENABLED' | null;

export interface JevConfigStatus {
  keyConfigured: boolean;
  /** the NAME of the variable that holds the key - not the key */
  keySource: JevKeySource | null;
  /** NAGEX_JEV_DECISION_ENABLED === 'true': the switch for the device, route and verification advisors */
  decisionEnabled: boolean;
  /** NAGEX_JEV_ADVISORY_ENABLED === 'true': the router-level shadow advisory, which is a LOCAL deterministic evaluator and sends nothing to JEV */
  shadowAdvisoryEnabled: boolean;
  /** the advisors that talk to JEV exist in this process: enabled AND a key */
  advisorsActive: boolean;
  /** why they do not, in the order a person would fix it */
  blocker: JevConfigBlocker;
}

export function describeJevConfig(env: NodeJS.ProcessEnv = process.env): JevConfigStatus {
  const { key, source } = resolveJevApiKey(env);
  const decisionEnabled = present(env[JEV_DECISION_ENABLED_ENV]) === 'true';
  const keyConfigured = key !== null;
  return {
    keyConfigured,
    keySource: source,
    decisionEnabled,
    shadowAdvisoryEnabled: present(env[JEV_ADVISORY_ENABLED_ENV]) === 'true',
    advisorsActive: keyConfigured && decisionEnabled,
    blocker: !keyConfigured ? 'NO_API_KEY' : !decisionEnabled ? 'DECISION_NOT_ENABLED' : null,
  };
}
