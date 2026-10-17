// How a failed JEV request is reported by the live scripts: structured facts only. The class comes from the status and the STRUCTURE of the error body (src/model-gateway/jev-errors.ts), the offending
// field only when the body names one, and the body itself only after the API key and any bearer token were removed. Never the key, never an Authorization header.
import { redactSecrets } from '../dist/src/model-gateway/jev-errors.js';

const HINTS = {
  INSUFFICIENT_CREDITS: 'HTTP 402: the account has no balance for this request.',
  IDEMPOTENCY_CONFLICT: 'HTTP 409: an Idempotency-Key was reused for a DIFFERENT request. A key problem, not a billing problem.',
  IDEMPOTENCY_KEY_REUSED: 'Refused before sending: the same Idempotency-Key was about to carry a second, different request.',
  KEY_REJECTED: 'The credential was refused.',
  REQUEST_SHAPE_REJECTED: 'The request was refused as malformed; INVALID_FIELD is set only when the response names a field.',
  RATE_LIMITED: 'Too many requests.',
};

/** The lines a script prints for a failed request. `error` is what JevSystemOneProvider throws. */
export function failureLines(error, apiKey) {
  const details = error?.details ?? {};
  const failureClass = details.failureClass ?? (error?.code === 'IDEMPOTENCY_KEY_REUSED' ? 'IDEMPOTENCY_KEY_REUSED' : 'UNKNOWN');
  const body = redactSecrets(String(details.responseBody ?? ''), [apiKey]).replace(/\s+/g, ' ').slice(0, 300);
  return [
    `HTTP_STATUS=${details.status ?? 'NOT_SENT'}`,
    `ERROR_CODE=${error?.code ?? 'UNKNOWN'}`,
    `ERROR_CLASS=${failureClass}`,
    `JEV_ERROR_CODE=${details.bodyCode ?? 'UNKNOWN'}`,
    `JEV_ERROR_RESPONSE=${body || 'UNAVAILABLE'}`,
    `INVALID_FIELD=${Array.isArray(details.fields) && details.fields[0] ? details.fields[0] : 'UNKNOWN'}`,
    ...(HINTS[failureClass] ? [`HINT=${HINTS[failureClass]}`] : []),
  ];
}
