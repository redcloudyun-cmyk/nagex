import { ConversationStore } from './conversation.store.js';

export interface ConversationContextItem {
  role: 'user' | 'assistant';
  content: string;
}

export interface BuildContextOptions {
  tenantId: string;
  principalId: string;
  sessionId: string;
  maxMessages?: number;
  maxCharacters?: number;
}

export class ConversationContextService {
  constructor(private readonly store: ConversationStore) {}

  public buildContext(options: BuildContextOptions): ConversationContextItem[] {
    const maxMessages = options.maxMessages ?? 20;
    const maxCharacters = options.maxCharacters ?? 32_000;

    const messages = this.store.getRecentContext(
      options.tenantId,
      options.principalId,
      options.sessionId,
      maxMessages
    );

    // Context contains only COMMITTED messages with USER or ASSISTANT role.
    const filtered = messages.filter(
      (m) => (m.role === 'USER' || m.role === 'ASSISTANT') && m.status === 'COMMITTED'
    );

    const items: ConversationContextItem[] = filtered.map((m) => ({
      role: m.role === 'USER' ? 'user' : 'assistant',
      content: m.content,
    }));

    // Discard oldest messages first if character limit is exceeded
    let totalLength = items.reduce((sum, item) => sum + item.content.length, 0);
    while (totalLength > maxCharacters && items.length > 0) {
      const popped = items.shift();
      if (popped) {
        totalLength -= popped.content.length;
      }
    }

    return items;
  }
}
