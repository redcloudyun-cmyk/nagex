// Phase 02 — Lifecycle Manager.
//
// Owns start/stop orchestration for process-lifetime resources that used to
// be started and torn down by ad hoc inline code in server_web.ts (HTTP
// server, the scheduler interval, browserRuntime). This class only
// orchestrates; it never constructs, launches, or knows the implementation
// details of what it manages — server_web.ts still decides *what* a
// resource's start/stop actually does, and hands it here as a plain
// {name, start?, stop} object.
//
// Guarantees (all directly exercised by tests/lifecycle_manager.test.ts):
// - deterministic registration order, and a resource name must be unique.
// - stopAll() stops in reverse registration order by default.
// - one resource's stop() failure never skips the rest — every resource's
//   stop() is attempted regardless, and failures are aggregated and thrown
//   together at the end (fixing a real gap in the pre-Phase-02 inline
//   shutdown code, where an early throw skipped later cleanup).
// - startAll()/stopAll() are each idempotent: calling either more than
//   once runs the underlying work exactly once and duplicate callers all
//   observe the same outcome (the same resolved/rejected promise).
// - never calls process.exit() — that stays systemd's/the caller's job.
import type { ManagedResource } from './lifecycle.types.js';

export class LifecycleAggregateError extends Error {
  constructor(
    public readonly phase: 'start' | 'stop',
    public readonly failures: Array<{ name: string; error: unknown }>,
  ) {
    super(
      `LifecycleManager.${phase === 'start' ? 'startAll' : 'stopAll'}() failed for: ` +
      failures.map((f) => `${f.name} (${f.error instanceof Error ? f.error.message : String(f.error)})`).join(', '),
    );
    this.name = 'LifecycleAggregateError';
  }
}

export class LifecycleManager {
  private readonly resources: ManagedResource[] = [];
  private readonly names = new Set<string>();
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;

  public register(resource: ManagedResource): void {
    if (this.names.has(resource.name)) {
      throw new Error(`LifecycleManager: a resource named "${resource.name}" is already registered.`);
    }
    this.names.add(resource.name);
    this.resources.push(resource);
  }

  // Registration order, forward — matches the order server_web.ts registers
  // resources in, which is chosen so this already matches real current
  // start timing (scheduler before HTTP listen; see the Phase 02 pre-flight
  // report's registration-order rationale).
  public startAll(): Promise<void> {
    if (!this.startPromise) {
      this.startPromise = this.runAll('start', this.resources);
    }
    return this.startPromise;
  }

  // Reverse registration order by default — the directive's stated default,
  // used here as-is since it already reproduces the exact, already-verified
  // stop order (http-server -> task-scheduler-interval -> browser-runtime)
  // given the registration order server_web.ts uses.
  public stopAll(): Promise<void> {
    if (!this.stopPromise) {
      this.stopPromise = this.runAll('stop', [...this.resources].reverse());
    }
    return this.stopPromise;
  }

  private async runAll(phase: 'start' | 'stop', ordered: ManagedResource[]): Promise<void> {
    const failures: Array<{ name: string; error: unknown }> = [];
    for (const resource of ordered) {
      const fn = phase === 'start' ? resource.start : resource.stop;
      if (!fn) continue;
      try {
        await fn.call(resource);
      } catch (error) {
        failures.push({ name: resource.name, error });
      }
    }
    if (failures.length > 0) {
      throw new LifecycleAggregateError(phase, failures);
    }
  }
}
