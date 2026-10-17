// What a failed JEV request MEANS - decided from the HTTP status and the STRUCTURE of the error body, never from searching the body's text for a word.
//
//   409            -> IDEMPOTENCY_CONFLICT  an Idempotency-Key that already belongs to a different request (JEV's own fix; it used to look like a 402). Never retried: the same key will conflict again.
//   402            -> INSUFFICIENT_CREDITS  the account has no balance for the request. NOTHING else is reported as a billing problem: a key conflict is a 409.
//   401 / 403      -> KEY_REJECTED          the credential was refused
//   400 / 422      -> REQUEST_SHAPE_REJECTED, with the offending field only when the body NAMES one (INVALID_FIELD was once decided by looking for the word "input" in the message)
//   429, 408, 5xx  -> retryable
//
// Nothing here ever returns, logs or stores the API key or an Authorization header: a body is redacted of the credential (and of any bearer token) before anything keeps it.

export type JevFailureClass = 'IDEMPOTENCY_CONFLICT' | 'INSUFFICIENT_CREDITS' | 'KEY_REJECTED' | 'REQUEST_SHAPE_REJECTED' | 'RATE_LIMITED' | 'TIMEOUT' | 'SERVER_ERROR' | 'HTTP_ERROR';

export interface JevErrorBody {
  /** the machine-readable code the body carries ("idempotency_conflict", "insufficient_credits"), when it carries one */
  code: string | null;
  message: string | null;
  /** field names the body NAMES as invalid (structured: a `loc` path, a `param` / `field` entry) - empty when it names none */
  fields: string[];
}

const SAFE_NAME = /^[A-Za-z0-9_.\-[\]]{1,60}$/;
const asText = (value: unknown, max = 300): string | null => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);

export function parseJevErrorBody(text: string): JevErrorBody {
  let json: unknown;
  try { json = JSON.parse(text); } catch { return { code: null, message: null, fields: [] }; }
  if (!json || typeof json !== 'object') return { code: null, message: null, fields: [] };
  const root = json as Record<string, unknown>;
  const error = root.error && typeof root.error === 'object' ? (root.error as Record<string, unknown>) : null;
  const detail = root.detail;
  const detailObject = detail && typeof detail === 'object' && !Array.isArray(detail) ? (detail as Record<string, unknown>) : null;

  const code = asText(error?.code) ?? asText(error?.type) ?? asText(root.code) ?? asText(root.type) ?? asText(typeof root.error === 'string' ? root.error : null) ?? asText(detailObject?.code);
  const message = asText(error?.message) ?? asText(root.message) ?? asText(typeof detail === 'string' ? detail : null) ?? asText(detailObject?.message) ?? (Array.isArray(detail) ? asText((detail[0] as Record<string, unknown> | undefined)?.msg) : null);

  const found: string[] = [];
  const add = (value: unknown) => { const name = asText(value, 80); if (name && SAFE_NAME.test(name) && !found.includes(name)) found.push(name); };
  // FastAPI / pydantic: detail: [{ loc: ['body', 'questions', 'level', 'type'], msg, type }]
  if (Array.isArray(detail)) for (const item of detail) { const loc = (item as { loc?: unknown } | null)?.loc; if (Array.isArray(loc)) { const path = loc.filter((part) => typeof part === 'string' && !['body', 'query', 'header', 'path'].includes(part)); if (path.length) add(path.join('.')); } }
  add(error?.param); add(root.param); add(root.field); add(error?.field);
  for (const list of [root.fields, error?.fields, root.invalid_fields]) if (Array.isArray(list)) list.forEach(add);
  if (Array.isArray(root.errors)) for (const item of root.errors) { add((item as { field?: unknown } | null)?.field); add((item as { path?: unknown } | null)?.path); }
  return { code, message, fields: found.slice(0, 8) };
}

/** The first field the error body names as invalid, or 'UNKNOWN'. The message text is never searched. */
export const invalidFieldOf = (body: JevErrorBody): string => body.fields[0] ?? 'UNKNOWN';

export interface JevFailure {
  /** the error code NAgex raises: IDEMPOTENCY_CONFLICT, INSUFFICIENT_CREDITS, or PROVIDER_HTTP_<status> for the rest (what the rest of the gateway already understands) */
  code: string;
  failureClass: JevFailureClass;
  retryable: boolean;
  body: JevErrorBody;
}

export function classifyJevHttpFailure(status: number, bodyText: string): JevFailure {
  const body = parseJevErrorBody(bodyText);
  if (status === 409) return { code: 'IDEMPOTENCY_CONFLICT', failureClass: 'IDEMPOTENCY_CONFLICT', retryable: false, body };
  if (status === 402) return { code: 'INSUFFICIENT_CREDITS', failureClass: 'INSUFFICIENT_CREDITS', retryable: false, body };
  const generic = `PROVIDER_HTTP_${status}`;
  if (status === 401 || status === 403) return { code: generic, failureClass: 'KEY_REJECTED', retryable: false, body };
  if (status === 400 || status === 422) return { code: generic, failureClass: 'REQUEST_SHAPE_REJECTED', retryable: false, body };
  if (status === 429) return { code: generic, failureClass: 'RATE_LIMITED', retryable: true, body };
  if (status === 408) return { code: generic, failureClass: 'TIMEOUT', retryable: true, body };
  if (status >= 500) return { code: generic, failureClass: 'SERVER_ERROR', retryable: true, body };
  return { code: generic, failureClass: 'HTTP_ERROR', retryable: false, body };
}

/** Removes every secret (the API key, any bearer token, an Authorization header line) from text that is about to be kept, shown or logged. */
export function redactSecrets(text: string, secrets: Array<string | null | undefined> = []): string {
  let out = String(text);
  for (const secret of secrets) if (secret && secret.length >= 4) out = out.split(secret).join('[redacted]');
  return out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]').replace(/(authorization["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1[redacted]');
}
