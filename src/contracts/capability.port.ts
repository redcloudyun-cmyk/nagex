// Phase 03 — Module Contracts.
//
// CapabilityBroker is the central gateway; task.runner.ts's
// ConditionalWatchTaskRunner is the only consumer in this repo that calls
// through it without needing anything else CapabilityBroker exposes. This
// port names exactly that one method, so the runner depends on a stable
// contract rather than the concrete CapabilityBroker class.
import type { CapabilityRequest, CapabilityBrokerResult } from '../capabilities/capability.types.js';

export interface CapabilityExecutorPort {
  execute(request: CapabilityRequest): Promise<CapabilityBrokerResult>;
}
