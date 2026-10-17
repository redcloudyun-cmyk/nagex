// Goal-driven adaptive execution - the NORMALIZED FAILURE TAXONOMY.
//
// A provider's failure is not automatically the failure of the person's goal, and a provider's own vocabulary (HTTP codes, "RESOURCE_EXHAUSTED", "PROVIDER_QUOTA_EXCEEDED", "429") is not NAgex's. Every
// failure is first reduced to one of a closed set of classes, and the rules for what may happen next (retry the same route? look for another? stop and reconcile first?) belong to the CLASS, not to
// the vendor. The classification is deterministic and pure: it is a hard-policy input, never a model's opinion.
//
// What each class forbids matters as much as what it allows:
//   * PERMISSION_DENIED never leads to another route "around" the denial (a refusal is not a provider problem);
//   * UNKNOWN_OUTCOME (a chargeable or consequential operation whose result is not known) never leads to a duplicate operation until the first one is reconciled;
//   * QUOTA_EXHAUSTED never leads to repeated calls on the exhausted account.

export const FAILURE_CLASSES = [
  'AUTHENTICATION_FAILURE',
  'PERMISSION_DENIED',
  'QUOTA_EXHAUSTED',
  'RATE_LIMITED',
  'BILLING_REQUIRED',
  'PROVIDER_UNAVAILABLE',
  'TIMEOUT',
  'INPUT_UNSUPPORTED',
  'CAPABILITY_UNAVAILABLE',
  'TRANSIENT_EXECUTION_FAILURE',
  'VERIFICATION_FAILED',
  'UNKNOWN_OUTCOME',
] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

/** What a provider adapter (or NAgex itself) can say about a failure - all of it optional, none of it free text that decides anything. */
export interface FailureEvidence {
  /** the adapter's own stable code, e.g. PROVIDER_QUOTA_EXCEEDED, UNSUPPORTED_ASPECT_RATIO, HOST_AUTH_FAILED */
  code?: string;
  httpStatus?: number;
  /** the provider's own status word, e.g. RESOURCE_EXHAUSTED, PERMISSION_DENIED */
  providerStatus?: string;
  /** a documented Retry-After, in milliseconds */
  retryAfterMs?: number;
  /** where it failed: before anything was sent, after the request left, or when the result was checked */
  phase?: 'BEFORE_SEND' | 'AFTER_SEND' | 'VERIFICATION';
  /** the operation costs money or has an external consequence */
  chargeable?: boolean;
  /** the provider de-duplicates a repeated request by an idempotency key, so a repeat cannot create a second job */
  idempotent?: boolean;
}

export type RetryRule = 'NEVER' | 'ONCE_AFTER_DELAY' | 'AFTER_DOCUMENTED_DELAY';
export type FallbackRule =
  /** another authorized route may be looked for */
  | 'ALLOWED'
  /** no other route: the denial is the answer */
  | 'FORBIDDEN'
  /** only after the earlier outcome has been reconciled (it may have happened) */
  | 'AFTER_RECONCILIATION'
  /** only a route that accepts the input - or the input transformation the person approves */
  | 'COMPATIBLE_ONLY';

export interface FailureClassification {
  failureClass: FailureClass;
  retry: RetryRule;
  fallback: FallbackRule;
  /** a documented delay, when the provider gave one */
  retryAfterMs: number | null;
  /** a short, stable explanation for the audit trail (never provider text) */
  reason: string;
}

/** Retrying is only "practical" when the documented wait is short; a long wait is a reason to use another route instead. */
export const PRACTICAL_RETRY_AFTER_MS = 20_000;

const CODE_TABLE: Record<string, FailureClass> = {
  // authentication / credential
  PROVIDER_AUTH_FAILED: 'AUTHENTICATION_FAILURE', HOST_AUTH_FAILED: 'AUTHENTICATION_FAILURE', AUTHENTICATION_FAILED: 'AUTHENTICATION_FAILURE', UNAUTHENTICATED: 'AUTHENTICATION_FAILURE',
  // denial / policy refusal: never routed around
  CONTENT_REJECTED: 'PERMISSION_DENIED', IMAGE_CONTENT_REJECTED: 'PERMISSION_DENIED', PERMISSION_DENIED: 'PERMISSION_DENIED', POLICY_DENIED: 'PERMISSION_DENIED', APPROVAL_DECLINED: 'PERMISSION_DENIED',
  USER_DECLINED: 'PERMISSION_DENIED', DOMAIN_NOT_ALLOWED: 'PERMISSION_DENIED', SPENDING_LIMIT_REACHED: 'PERMISSION_DENIED', COST_LIMIT_EXCEEDED: 'PERMISSION_DENIED',
  // quota / billing / rate
  PROVIDER_QUOTA_EXCEEDED: 'QUOTA_EXHAUSTED', IMAGE_QUOTA_EXCEEDED: 'QUOTA_EXHAUSTED', QUOTA_EXHAUSTED: 'QUOTA_EXHAUSTED', RESOURCE_EXHAUSTED: 'QUOTA_EXHAUSTED', PROVIDER_INSUFFICIENT_CREDITS: 'QUOTA_EXHAUSTED',
  PROVIDER_BILLING_REQUIRED: 'BILLING_REQUIRED', HOST_PAYMENT_REQUIRED: 'BILLING_REQUIRED', BILLING_REQUIRED: 'BILLING_REQUIRED',
  RATE_LIMITED: 'RATE_LIMITED', HOST_RATE_LIMITED: 'RATE_LIMITED', PROVIDER_RATE_LIMITED: 'RATE_LIMITED',
  // availability
  PROVIDER_UNAVAILABLE_ERROR: 'PROVIDER_UNAVAILABLE', PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE', HOST_SERVER_ERROR: 'PROVIDER_UNAVAILABLE', SERVICE_UNAVAILABLE: 'PROVIDER_UNAVAILABLE', NETWORK_ERROR: 'PROVIDER_UNAVAILABLE',
  // not configured / no such model: the capability is not there
  PROVIDER_UNCONFIGURED: 'CAPABILITY_UNAVAILABLE', IMAGE_PROVIDER_UNAVAILABLE: 'CAPABILITY_UNAVAILABLE', NO_IMAGE_PROVIDER: 'CAPABILITY_UNAVAILABLE', NO_CREATION_PROVIDER_AVAILABLE: 'CAPABILITY_UNAVAILABLE',
  PROVIDER_MODEL_NOT_FOUND: 'CAPABILITY_UNAVAILABLE', PROVIDER_NOT_FOUND: 'CAPABILITY_UNAVAILABLE', LOCAL_GPU_UNCONFIGURED: 'CAPABILITY_UNAVAILABLE', DEPLOY_NOT_CONFIGURED: 'CAPABILITY_UNAVAILABLE', NO_CODING_ENGINE: 'CAPABILITY_UNAVAILABLE',
  CAPABILITY_UNAVAILABLE: 'CAPABILITY_UNAVAILABLE',
  // the input cannot be accepted by this route
  UNSUPPORTED_ASPECT_RATIO: 'INPUT_UNSUPPORTED', IMAGE_TO_VIDEO_UNSUPPORTED: 'INPUT_UNSUPPORTED', TEXT_TO_VIDEO_UNSUPPORTED: 'INPUT_UNSUPPORTED', CAPABILITY_UNSUPPORTED: 'INPUT_UNSUPPORTED',
  INVALID_SPEC: 'INPUT_UNSUPPORTED', INPUT_UNSUPPORTED: 'INPUT_UNSUPPORTED', TOO_MANY_REFERENCES: 'INPUT_UNSUPPORTED', HOST_REQUEST_REJECTED: 'INPUT_UNSUPPORTED', PROVIDER_REJECTED_REQUEST: 'INPUT_UNSUPPORTED',
  // timeouts
  TIMEOUT: 'TIMEOUT', PROVIDER_TIMEOUT: 'TIMEOUT', DEPLOY_TIMEOUT: 'TIMEOUT', WAIT_LIMIT_REACHED: 'TIMEOUT',
  // the outcome is not known
  SUBMIT_UNCERTAIN: 'UNKNOWN_OUTCOME', DEPLOY_STATE_UNCERTAIN: 'UNKNOWN_OUTCOME', UNKNOWN_OUTCOME: 'UNKNOWN_OUTCOME', HOST_RESPONSE_UNREADABLE: 'UNKNOWN_OUTCOME', DEPLOY_NOT_READY_IN_TIME: 'UNKNOWN_OUTCOME',
  // the result did not check out
  VERIFICATION_FAILED: 'VERIFICATION_FAILED', IMAGE_VERIFICATION_FAILED: 'VERIFICATION_FAILED', EMPTY_PROVIDER_RESULT: 'VERIFICATION_FAILED', EMPTY_IMAGE_BINARY: 'VERIFICATION_FAILED', MEDIA_INVALID: 'VERIFICATION_FAILED',
  DEPLOY_NOT_VERIFIED: 'VERIFICATION_FAILED', NO_MOCKUPS_RETURNED: 'VERIFICATION_FAILED',
  // transient
  MALFORMED_RESPONSE: 'TRANSIENT_EXECUTION_FAILURE', PARSE_ERROR: 'TRANSIENT_EXECUTION_FAILURE', IMAGE_GENERATION_FAILED: 'TRANSIENT_EXECUTION_FAILURE', GOOGLE_GENERATION_FAILED: 'TRANSIENT_EXECUTION_FAILURE',
  OPENAI_GENERATION_FAILED: 'TRANSIENT_EXECUTION_FAILURE', NIM_GENERATION_FAILED: 'TRANSIENT_EXECUTION_FAILURE', GOOGLE_API_ERROR: 'TRANSIENT_EXECUTION_FAILURE', PROVIDER_JOB_FAILED: 'TRANSIENT_EXECUTION_FAILURE',
  MEDIA_DOWNLOAD_FAILED: 'TRANSIENT_EXECUTION_FAILURE', HOST_DEPLOY_FAILED: 'TRANSIENT_EXECUTION_FAILURE', DEPLOY_NETWORK_ERROR: 'UNKNOWN_OUTCOME',
};

function classOf(evidence: FailureEvidence): { failureClass: FailureClass; reason: string } {
  const code = String(evidence.code ?? '').toUpperCase();
  const status = String(evidence.providerStatus ?? '').toUpperCase();
  const http = evidence.httpStatus;

  // an outcome that is not known beats every other reading when something chargeable or consequential was sent: whatever the transport said, it may have happened
  if (evidence.chargeable && evidence.phase === 'AFTER_SEND' && !evidence.idempotent) {
    const ambiguous = code === '' || code === 'NETWORK_ERROR' || code === 'TIMEOUT' || code === 'PROVIDER_TIMEOUT' || code === 'MALFORMED_RESPONSE' || code === 'PARSE_ERROR' || (http !== undefined && http >= 500 && http !== 503);
    if (ambiguous) return { failureClass: 'UNKNOWN_OUTCOME', reason: 'a chargeable request was sent and its result is not known' };
  }
  if (code && CODE_TABLE[code]) return { failureClass: CODE_TABLE[code], reason: `the adapter reported ${code}` };

  if (status === 'RESOURCE_EXHAUSTED') return { failureClass: 'QUOTA_EXHAUSTED', reason: 'the provider reported RESOURCE_EXHAUSTED' };
  if (status === 'PERMISSION_DENIED' || status === 'UNAUTHENTICATED') return { failureClass: 'AUTHENTICATION_FAILURE', reason: `the provider reported ${status}` };
  if (http === 401) return { failureClass: 'AUTHENTICATION_FAILURE', reason: 'HTTP 401' };
  if (http === 402) return { failureClass: 'BILLING_REQUIRED', reason: 'HTTP 402' };
  if (http === 403) return { failureClass: 'AUTHENTICATION_FAILURE', reason: 'HTTP 403 on the credential NAgex holds' };
  if (http === 404) return { failureClass: 'CAPABILITY_UNAVAILABLE', reason: 'HTTP 404: the model or endpoint is not there' };
  if (http === 408 || http === 504) return { failureClass: 'TIMEOUT', reason: `HTTP ${http}` };
  if (http === 429) return { failureClass: 'RATE_LIMITED', reason: 'HTTP 429 without a quota signal' };
  if (http === 400 || http === 413 || http === 415 || http === 422) return { failureClass: 'INPUT_UNSUPPORTED', reason: `HTTP ${http}` };
  if (http === 503) return { failureClass: 'PROVIDER_UNAVAILABLE', reason: 'HTTP 503' };
  if (http !== undefined && http >= 500) return { failureClass: 'TRANSIENT_EXECUTION_FAILURE', reason: `HTTP ${http}` };
  if (evidence.phase === 'VERIFICATION') return { failureClass: 'VERIFICATION_FAILED', reason: 'the result did not pass verification' };
  return { failureClass: 'TRANSIENT_EXECUTION_FAILURE', reason: 'an unrecognised failure is treated as transient and is bounded by the retry budget' };
}

/** The rules for each class. A single table so that "what may happen after QUOTA_EXHAUSTED" is one fact, readable and tested, not scattered conditions. */
const RULES: Record<FailureClass, { retry: RetryRule; fallback: FallbackRule }> = {
  AUTHENTICATION_FAILURE: { retry: 'NEVER', fallback: 'ALLOWED' },
  PERMISSION_DENIED: { retry: 'NEVER', fallback: 'FORBIDDEN' },
  QUOTA_EXHAUSTED: { retry: 'NEVER', fallback: 'ALLOWED' },
  RATE_LIMITED: { retry: 'AFTER_DOCUMENTED_DELAY', fallback: 'ALLOWED' },
  BILLING_REQUIRED: { retry: 'NEVER', fallback: 'ALLOWED' },
  PROVIDER_UNAVAILABLE: { retry: 'ONCE_AFTER_DELAY', fallback: 'ALLOWED' },
  TIMEOUT: { retry: 'ONCE_AFTER_DELAY', fallback: 'ALLOWED' },
  INPUT_UNSUPPORTED: { retry: 'NEVER', fallback: 'COMPATIBLE_ONLY' },
  CAPABILITY_UNAVAILABLE: { retry: 'NEVER', fallback: 'ALLOWED' },
  TRANSIENT_EXECUTION_FAILURE: { retry: 'ONCE_AFTER_DELAY', fallback: 'ALLOWED' },
  VERIFICATION_FAILED: { retry: 'NEVER', fallback: 'ALLOWED' },
  UNKNOWN_OUTCOME: { retry: 'NEVER', fallback: 'AFTER_RECONCILIATION' },
};

export function classifyFailure(evidence: FailureEvidence): FailureClassification {
  const { failureClass, reason } = classOf(evidence);
  const rule = RULES[failureClass];
  let retry = rule.retry;
  const delay = typeof evidence.retryAfterMs === 'number' && Number.isFinite(evidence.retryAfterMs) && evidence.retryAfterMs >= 0 ? evidence.retryAfterMs : null;
  // a repeat of a chargeable request is only safe when the provider de-duplicates it; and a wait that is not short is not "practical": go elsewhere instead of waiting
  if (retry === 'ONCE_AFTER_DELAY' && evidence.chargeable && evidence.phase === 'AFTER_SEND' && !evidence.idempotent) retry = 'NEVER';
  if (retry === 'AFTER_DOCUMENTED_DELAY' && (delay === null || delay > PRACTICAL_RETRY_AFTER_MS)) retry = 'NEVER';
  if (failureClass === 'VERIFICATION_FAILED' && evidence.chargeable) retry = 'NEVER';
  return { failureClass, retry, fallback: rule.fallback, retryAfterMs: delay, reason };
}

/** The adapter-neutral way to read a ProviderExecutionResult-like failure (errorCode / errorMessage / metadata.customData.httpStatus). */
export function evidenceFromProviderResult(result: { status?: string; errorCode?: string; metadata?: { customData?: Record<string, unknown> } } | null | undefined, extra: Partial<FailureEvidence> = {}): FailureEvidence {
  const custom = result?.metadata?.customData ?? {};
  const http = typeof custom.httpStatus === 'number' ? custom.httpStatus : undefined;
  return {
    ...(result?.errorCode ? { code: result.errorCode } : {}),
    ...(http !== undefined ? { httpStatus: http } : {}),
    ...(result?.status === 'UNAVAILABLE' && !result?.errorCode ? { code: 'PROVIDER_UNAVAILABLE' } : {}),
    ...extra,
  };
}
