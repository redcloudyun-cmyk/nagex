// R10.2-D — shared HTTP route-handling types. Deliberately minimal: no new
// framework, no change to the real dispatch entry points
// (handleAsyncApiRequest/handleApiRequest in server_web.ts, both still
// exported with their exact pre-existing signatures — many existing tests
// call them directly). This is only the shape a "domain route registrar"
// returns, so server_web.ts's own dispatch loop can try one after another.
export type JsonApiResult = { status: number; data: unknown; redirectTo?: string; headers?: Record<string, string>; isBinary?: false };

// R23.7C-C — the minimum explicit binary response variant. Structurally
// distinct from JsonApiResult (isBinary: true is required, data is a real
// Buffer, contentType is required) so a route can never accidentally
// return raw bytes through the JSON path or vice versa. Every existing
// route's plain `{ status, data }` object literal still satisfies
// JsonApiResult unchanged — this is additive, not a breaking change to the
// ApiResult union.
export type BinaryApiResult = { status: number; data: Buffer; contentType: string; redirectTo?: undefined; headers?: Record<string, string>; isBinary: true };

export type ApiResult = JsonApiResult | BinaryApiResult;

// A registrar handles zero or more routes for one domain. Returning
// `undefined` means "not one of mine — try the next registrar", exactly
// matching the original if/else-if fallthrough chain's semantics; this is
// why registrars are tried strictly in registration order (see router.ts).
export type SyncRouteRegistrar<TDeps> = (
  method: string,
  pathname: string,
  body: Record<string, unknown> | null,
  headers: Record<string, string | string[] | undefined>,
  query: Record<string, string>,
  deps: TDeps,
) => ApiResult | undefined;

export type AsyncRouteRegistrar<TDeps> = (
  method: string,
  pathname: string,
  body: Record<string, unknown> | null,
  headers: Record<string, string | string[] | undefined>,
  query: Record<string, string>,
  deps: TDeps,
) => Promise<ApiResult | undefined>;
