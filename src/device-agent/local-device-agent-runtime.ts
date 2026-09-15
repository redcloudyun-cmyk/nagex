// DC3-B1-R1 — Local Device Agent lifecycle/state-machine runtime.
//
// Deliberately Electron-independent (no `electron` import anywhere in this
// file) so it is fully unit-testable under plain Node; desktop-app.ts
// wires a thin integration around it (construct once, call start()/stop()/
// suspend()/resume()/onSessionLock() from real Electron lifecycle events).
//
// "At most one active LocalDeviceAgentClient" is enforced here by
// start() being idempotent — a second call while already started is a
// pure no-op, never a second client/timer.
import { LocalDeviceAgentClient } from './local-device-agent-client.js';
import type { LocalDeviceCredentialStore } from './local-device-credential.store.js';
import type { DevicePendingCommand } from './device-agent-protocol.js';

// Section 9's required vocabulary. REVOKED is intentionally never
// auto-inferred from repeated transport rejections — DeviceTransportSecurity
// (DC3-A) deliberately makes "revoked" indistinguishable from "wrong
// signature"/"unknown device"/etc. to anyone holding the device's own key,
// by design (the whole point of revocation is that a revoked device gets
// no differentiated signal). A generic, repeated-rejection state
// (DEGRADED) is the honest, correct local observation; REVOKED exists as
// a state a future explicit local/owner action can set, not something
// this runtime concludes on its own from transport behavior alone.
export type LocalDeviceAgentConnectionState = 'UNENROLLED' | 'DISCONNECTED' | 'CONNECTING' | 'AUTHENTICATED' | 'DEGRADED' | 'REVOKED';

type TimerHandle = ReturnType<typeof setInterval>;

export interface LocalDeviceAgentRuntimeOptions {
  credentialStore: LocalDeviceCredentialStore;
  serverBaseUrl: string;
  agentVersion: string;
  capabilityInventory?: string[];
  heartbeatIntervalMs?: number;
  fetchFn?: typeof fetch;
  setIntervalFn?: (callback: () => void, ms: number) => TimerHandle;
  clearIntervalFn?: (handle: TimerHandle) => void;
  onStateChange?: (state: LocalDeviceAgentConnectionState) => void;
  onPendingCommand?: (command: DevicePendingCommand) => void;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
// After this many consecutive failures, the state is reported as DEGRADED
// rather than a transient DISCONNECTED — still safe (never AUTHENTICATED),
// just a stronger local signal that something is persistently wrong
// (possibly, but not provably, revocation).
const DEGRADED_AFTER_CONSECUTIVE_FAILURES = 3;

export class LocalDeviceAgentRuntime {
  private state: LocalDeviceAgentConnectionState = 'UNENROLLED';
  private client: LocalDeviceAgentClient | null = null;
  private heartbeatTimer: TimerHandle | null = null;
  private started = false;
  private consecutiveFailures = 0;

  constructor(private readonly options: LocalDeviceAgentRuntimeOptions) {}

  public getState(): LocalDeviceAgentConnectionState {
    return this.state;
  }

  private setState(next: LocalDeviceAgentConnectionState): void {
    this.state = next;
    this.options.onStateChange?.(next);
  }

  // Never throws — a transport/credential problem must never crash the
  // desktop shell (Section 5/12's own explicit requirement). Every
  // failure path here ends in a state transition, not an exception.
  public async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    const credential = this.options.credentialStore.load();
    if (!credential) {
      this.setState('UNENROLLED');
      return;
    }

    this.client = new LocalDeviceAgentClient({
      tenantId: credential.tenantId,
      ownerId: credential.ownerId,
      deviceId: credential.deviceId,
      privateKeyPem: credential.privateKeyPem,
      serverBaseUrl: this.options.serverBaseUrl,
      agentVersion: this.options.agentVersion,
      capabilityInventory: this.options.capabilityInventory,
      fetchFn: this.options.fetchFn,
    });

    await this.attemptConnect();
    this.startHeartbeatLoop();
  }

  private async attemptConnect(): Promise<void> {
    if (!this.client) return;
    this.setState('CONNECTING');
    try {
      await this.client.connect();
      this.consecutiveFailures = 0;
      this.setState('AUTHENTICATED');
    } catch {
      this.consecutiveFailures += 1;
      this.setState(this.consecutiveFailures >= DEGRADED_AFTER_CONSECUTIVE_FAILURES ? 'DEGRADED' : 'DISCONNECTED');
    }
  }

  private startHeartbeatLoop(): void {
    const setIntervalFn = this.options.setIntervalFn ?? setInterval;
    this.heartbeatTimer = setIntervalFn(() => {
      void this.tick();
    }, this.options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS);
    // Never keeps the Node/Electron process alive on its own — Section 6's
    // "no hanging process because of transport timers."
    const unref = (this.heartbeatTimer as unknown as { unref?: () => void })?.unref;
    if (typeof unref === 'function') unref.call(this.heartbeatTimer);
  }

  private stopHeartbeatLoop(): void {
    if (this.heartbeatTimer) {
      const clearIntervalFn = this.options.clearIntervalFn ?? clearInterval;
      clearIntervalFn(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // Exposed for tests to drive deterministically instead of waiting on a
  // real timer; production code only ever reaches this via the interval
  // above. If not currently authenticated, a "tick" is a fresh connect
  // attempt (this is what actually implements reconnect-with-recovery),
  // never an assumption that a stale session is still good.
  public async tick(): Promise<void> {
    if (!this.client) return;
    if (this.state !== 'AUTHENTICATED' && this.state !== 'DEGRADED') {
      await this.attemptConnect();
      return;
    }
    try {
      const pendingCommand = await this.client.heartbeat();
      this.consecutiveFailures = 0;
      this.setState('AUTHENTICATED');
      if (pendingCommand) this.options.onPendingCommand?.(pendingCommand);
    } catch {
      this.consecutiveFailures += 1;
      this.setState(this.consecutiveFailures >= DEGRADED_AFTER_CONSECUTIVE_FAILURES ? 'DEGRADED' : 'DISCONNECTED');
    }
  }

  // Section 7 — sleep/suspend must never assume the connection survives:
  // stop the timer and disconnect now, rather than letting a stale timer
  // fire into a suspended OS state.
  public async suspend(): Promise<void> {
    this.stopHeartbeatLoop();
    if (this.client) {
      try {
        await this.client.disconnect();
      } catch {
        /* best effort */
      }
    }
    if (this.state === 'AUTHENTICATED' || this.state === 'DEGRADED') this.setState('DISCONNECTED');
  }

  // Resume always re-authenticates from scratch — never assumes the
  // pre-suspend session is still valid.
  public async resume(): Promise<void> {
    if (!this.client) return;
    await this.attemptConnect();
    if (this.state === 'AUTHENTICATED') this.startHeartbeatLoop();
  }

  // Section 8 — a lock/logout signal is treated identically to suspend:
  // fail safe, drop the live connection, never assume continued authority
  // through a session boundary.
  public async onSessionLock(): Promise<void> {
    await this.suspend();
  }

  public async stop(): Promise<void> {
    this.stopHeartbeatLoop();
    if (this.client) {
      try {
        await this.client.disconnect();
      } catch {
        /* best effort on shutdown */
      }
    }
    this.started = false;
    this.setState(this.options.credentialStore.load() ? 'DISCONNECTED' : 'UNENROLLED');
  }
}
