// R23.6M Phase D1 — MessagingAdapterRegistry. The single place that knows
// which channels are actually executable. Never advertises an
// unimplemented channel: KAKAOTALK is a real value in the MessagingChannel
// taxonomy (send-message-action.types.ts), but nothing registers a
// KakaoTalk adapter until D2 provides one, so this registry — and
// therefore ExecutionRouteResolver, which only ever consults it — has no
// way to resolve KAKAOTALK in D1.
import type { MessagingChannel } from './send-message-action.types.js';
import type { MessagingExecutionAdapter } from './messaging-execution-adapter.js';

export class MessagingAdapterRegistry {
  private readonly adapters = new Map<MessagingChannel, MessagingExecutionAdapter>();

  public register(adapter: MessagingExecutionAdapter): void {
    this.adapters.set(adapter.channel, adapter);
  }

  // Returns undefined — never a fake/default adapter — for anything not
  // actually registered.
  public get(channel: MessagingChannel): MessagingExecutionAdapter | undefined {
    return this.adapters.get(channel);
  }

  public isRegistered(channel: MessagingChannel): boolean {
    return this.adapters.has(channel);
  }

  public listRegisteredChannels(): MessagingChannel[] {
    return Array.from(this.adapters.keys());
  }
}
