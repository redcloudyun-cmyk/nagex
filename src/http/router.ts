// R10.2-D — the router itself: a deliberately tiny sequential-match engine,
// not a framework (§6 of the directive explicitly forbids adopting
// Express/Fastify/Hono/etc. here). It preserves the exact semantics of the
// pre-refactor if/else-if chain in server_web.ts: registrars are tried in
// registration order, the first one to return a real ApiResult wins, and
// route precedence is therefore determined entirely by registration order
// — the same "order matters" property the original inline chain already
// had (see tests/http_router.test.ts's collision/precedence tests).
import type { ApiResult, AsyncRouteRegistrar, SyncRouteRegistrar } from './http-types.js';

export class SyncHttpRouter<TDeps> {
  private readonly registrars: SyncRouteRegistrar<TDeps>[] = [];

  public register(registrar: SyncRouteRegistrar<TDeps>): void {
    this.registrars.push(registrar);
  }

  public handle(
    method: string,
    pathname: string,
    body: Record<string, unknown> | null,
    headers: Record<string, string | string[] | undefined>,
    query: Record<string, string>,
    deps: TDeps,
  ): ApiResult | undefined {
    for (const registrar of this.registrars) {
      const result = registrar(method, pathname, body, headers, query, deps);
      if (result) return result;
    }
    return undefined;
  }
}

export class AsyncHttpRouter<TDeps> {
  private readonly registrars: AsyncRouteRegistrar<TDeps>[] = [];

  public register(registrar: AsyncRouteRegistrar<TDeps>): void {
    this.registrars.push(registrar);
  }

  public async handle(
    method: string,
    pathname: string,
    body: Record<string, unknown> | null,
    headers: Record<string, string | string[] | undefined>,
    query: Record<string, string>,
    deps: TDeps,
  ): Promise<ApiResult | undefined> {
    for (const registrar of this.registrars) {
      const result = await registrar(method, pathname, body, headers, query, deps);
      if (result) return result;
    }
    return undefined;
  }
}
