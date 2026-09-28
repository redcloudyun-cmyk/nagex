// R23.6M Phase D1 — canonical channel parsing belongs to the messaging
// abstraction, not the Phase C SMS route. Naming a channel here does not
// make it executable; the adapter registry remains the authority for that.
import { NagexError } from '../common/errors.js';
import type { MessagingChannel } from './send-message-action.types.js';

const MESSAGING_CHANNELS: ReadonlySet<string> = new Set<MessagingChannel>(['SMS', 'KAKAOTALK']);

export function parseOptionalMessagingChannel(value: unknown, requestId: string): MessagingChannel | undefined {
  if (typeof value !== 'string') return undefined;
  if (!MESSAGING_CHANNELS.has(value)) {
    throw new NagexError({
      code: 'MESSAGING_CHANNEL_UNSUPPORTED',
      category: 'VALIDATION',
      message: `Unknown channel: ${value}.`,
      request_id: requestId,
    });
  }
  return value as MessagingChannel;
}
