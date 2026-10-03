// Security Gate S2A — the authentic bytes of a request body.
//
// A signed webhook (Slack) authenticates the EXACT bytes the sender signed. The HTTP layer parses the body into an object
// before any route runs, and re-serialising that object would produce different bytes, so the verifier must be given the
// original buffer. The HTTP layer registers it here, keyed by the parsed-body object; a route that needs it asks for it.
// A body that was not produced by the HTTP layer (a direct call with a hand-built object) has no raw bytes, and a verifier
// that cannot obtain them must reject — it must never fall back to JSON.stringify(body).
const rawBodies = new WeakMap<object, Buffer>();

export function attachRawBody<T extends object>(body: T, raw: Buffer): T {
  rawBodies.set(body, raw);
  return body;
}

export function getRawBody(body: object | null | undefined): Buffer | undefined {
  return body && typeof body === 'object' ? rawBodies.get(body) : undefined;
}
