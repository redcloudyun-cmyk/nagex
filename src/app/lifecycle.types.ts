// Phase 02 — Lifecycle Manager.
//
// A ManagedResource is any process-lifetime resource (HTTP server, a timer
// handle, a browser runtime, and — later — worker/MCP/local-model runtimes)
// that needs an explicit, deterministic stop. Deliberately just two
// optional lifecycle hooks — no state machine, no phases beyond
// "not started" / "started" / "stopped", tracked by LifecycleManager itself,
// never by the resource.
export interface ManagedResource {
  readonly name: string;
  start?(): Promise<void> | void;
  stop(): Promise<void> | void;
}
