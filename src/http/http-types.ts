// R10.2-D — shared HTTP route-handling types. Deliberately minimal: no new
// framework, no change to the real dispatch entry points
// (handleAsyncApiRequest/handleApiRequest in server_web.ts, both still
// exported with their exact pre-existing signatures — many existing tests
// call them directly). This is only the shape a "domain route registrar"
// returns, so server_web.ts's own dispatch loop can try one after another.
export type ApiResult = { status: number; data: unknown; redirectTo?: string };

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
