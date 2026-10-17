// The Idempotency-Key of a JEV request: a key names ONE request. JEV answers a repeated key with the answer it stored for the first request that used it - so a key reused for a DIFFERENT request is a
// conflict (JEV now answers it HTTP 409 `idempotency_conflict`; before that fix it surfaced as HTTP 402, which sent a debugging effort after a billing problem that did not exist). The live scripts used
// fixed keys per fixture ("nagex-jev-live-<fixture>"), which collide the moment a fixture's request changes between runs.
//
//   key = nagex-<purpose>-<run id>-<fingerprint of the exact request body>
//
//   - a DIFFERENT request            -> a different key  (the fingerprint differs)
//   - the SAME request, retried      -> the SAME key      (same run id, same fingerprint): a retry after a timeout returns the stored answer instead of charging twice
//   - the same request in ANOTHER run -> a different key  (the run id differs): nothing from an earlier run, or an older version of the request, can ever meet this one
//
// The key is not a secret (it carries no credential and no content: a run id and a hash), but it is still never derived from the API key.
import { createHash, randomUUID } from 'node:crypto';

/** One id per RUN of a script (or process). */
export function newJevRunId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 16);
}

/** JSON with the keys of every object in sorted order: the same request always has the same text, whatever order its fields were built in. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().filter((key) => (value as Record<string, unknown>)[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function jevRequestFingerprint(requestBody: unknown): string {
  return createHash('sha256').update(canonicalJson(requestBody)).digest('hex');
}

/** The Idempotency-Key for ONE request in ONE run. `purpose` is a short label ("diagnostic", "benchmark"). */
export function jevIdempotencyKey(runId: string, purpose: string, requestBody: unknown): string {
  const label = String(purpose).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'request';
  const run = String(runId).replace(/[^A-Za-z0-9]/g, '').slice(0, 24) || 'run';
  return `nagex-${label}-${run}-${jevRequestFingerprint(requestBody).slice(0, 24)}`;
}
