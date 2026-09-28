// R23.6M Phase D1 — ExecutionRouteResolver. Two-stage resolution
// (channel -> adapter -> that adapter's own execution route), never a
// single "channel == route" assumption. Resolves only among adapters
// that are registered AND report themselves available for this action —
// never a channel the registry has no adapter for.
import { NagexError } from '../common/errors.js';
import type { MessagingAdapterRegistry } from './messaging-adapter-registry.js';
import type { MessagingExecutionAdapter } from './messaging-execution-adapter.js';
import type { ExecutionRoute, MessagingChannel, MessagingRouteCapabilities, SendMessageAction } from './send-message-action.types.js';

export interface ResolvedRoute {
  channel: MessagingChannel;
  route: ExecutionRoute;
  adapter: MessagingExecutionAdapter;
  capabilities: MessagingRouteCapabilities;
}

export class ExecutionRouteResolver {
  constructor(private readonly registry: MessagingAdapterRegistry) {}

  public async resolve(action: SendMessageAction): Promise<ResolvedRoute> {
    if (action.preferredChannel) {
      return this.resolveExplicit(action, action.preferredChannel);
    }
    return this.resolveDefault(action);
  }

  // An explicit user-selected channel is never silently converted into a
  // different one. Unregistered or unavailable -> fail closed, truthfully.
  private async resolveExplicit(action: SendMessageAction, channel: MessagingChannel): Promise<ResolvedRoute> {
    const adapter = this.registry.get(channel);
    if (!adapter) {
      throw new NagexError({
        code: 'MESSAGING_CHANNEL_UNSUPPORTED',
        category: 'VALIDATION',
        message: `Channel ${channel} has no registered execution adapter.`,
        request_id: action.requestId,
      });
    }
    const capability = await adapter.checkCapability(action);
    if (!capability.available) {
      throw new NagexError({
        code: 'MESSAGING_CHANNEL_UNAVAILABLE',
        category: 'POLICY',
        message: `Channel ${channel} is not available${capability.reason ? `: ${capability.reason}` : '.'}`,
        request_id: action.requestId,
      });
    }
    return { channel, route: adapter.resolveExecutionRoute(action), capabilities: adapter.getRouteCapabilities(action), adapter };
  }

  // No preference specified: choose among registered/available adapters.
  // D1 has exactly one registered adapter (SMS), so this always resolves
  // SMS — not by special-casing SMS here, but because that is genuinely
  // the only entry the registry has.
  private async resolveDefault(action: SendMessageAction): Promise<ResolvedRoute> {
    for (const channel of this.registry.listRegisteredChannels()) {
      const adapter = this.registry.get(channel);
      if (!adapter) continue;
      const capability = await adapter.checkCapability(action);
      if (capability.available) {
        return { channel, route: adapter.resolveExecutionRoute(action), capabilities: adapter.getRouteCapabilities(action), adapter };
      }
    }
    throw new NagexError({
      code: 'MESSAGING_NO_CHANNEL_AVAILABLE',
      category: 'POLICY',
      message: 'No registered messaging channel is available for this action.',
      request_id: action.requestId,
    });
  }
}
