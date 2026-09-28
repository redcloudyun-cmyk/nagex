import { NagexError } from '../common/errors.js';
import type { MessagingExecutionCapability, MessagingExecutionEvidence } from './messaging-execution-contract.types.js';

export class MessagingCapabilityRegistry {
  private readonly capabilities = new Map<string, MessagingExecutionCapability>();

  public register(capability: MessagingExecutionCapability): void {
    if (capability.availabilityStatus !== 'AVAILABLE' || capability.executionMode === 'UNSUPPORTED') {
      throw new NagexError({ code: 'MESSAGING_CAPABILITY_NOT_EXECUTABLE', category: 'POLICY', message: `Capability ${capability.capabilityId} is not executable and cannot be registered.`, request_id: 'messaging_capability_registry' });
    }
    this.capabilities.set(capability.capabilityId, Object.freeze({ ...capability }));
  }

  public get(capabilityId: string): MessagingExecutionCapability | undefined {
    return this.capabilities.get(capabilityId);
  }

  public list(): MessagingExecutionCapability[] {
    return Array.from(this.capabilities.values());
  }
}

export function assertRuntimeMessagingEvidence(evidence: MessagingExecutionEvidence): void {
  if (evidence.synthetic) {
    throw new NagexError({ code: 'SYNTHETIC_MESSAGING_EVIDENCE_REJECTED', category: 'POLICY', message: 'Synthetic provider success cannot become runtime messaging evidence.', request_id: 'messaging_evidence' });
  }
}
