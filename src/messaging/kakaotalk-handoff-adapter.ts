import type { MessagingExecutionAdapter } from './messaging-execution-adapter.js';
import type { MessagingHandoffService } from './messaging-handoff.service.js';
import type { CapabilityResult, ExecutionRoute, MessagingRouteCapabilities } from './send-message-action.types.js';

export class KakaoTalkHandoffAdapter implements MessagingExecutionAdapter {
  readonly channel = 'KAKAOTALK' as const;
  constructor(readonly handoffs: MessagingHandoffService) {}
  async checkCapability(): Promise<CapabilityResult> { return { available: true, reason: 'HUMAN_HANDOFF_ONLY' }; }
  resolveExecutionRoute(): ExecutionRoute { return 'KAKAOTALK_SHARE'; }
  getRouteCapabilities(): MessagingRouteCapabilities { return { executionMode: 'HUMAN_HANDOFF', recipientEnforced: false, messageEnforced: false, completionVerifiable: false, requiresHumanCompletion: true }; }
  async prepare(): Promise<never> { throw new Error('Use MessagingHandoffService for human handoff lifecycle.'); }
  async executeApproved(): Promise<never> { throw new Error('Use signed MESSAGING_HANDOFF_AUTHORIZE command.'); }
  async reportResult(): Promise<never> { throw new Error('KAKAOTALK_SHARE has no send-confirmation result.'); }
}
