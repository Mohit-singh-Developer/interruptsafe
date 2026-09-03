/**
 * ConversationState - the single owner of conversation history.
 *
 * Everything that wants to read or extend a conversation goes through this
 * store. Nothing else keeps its own copy of the transcript: the browser holds a
 * display list, but the server's copy here is authoritative and is what the
 * provider is shown.
 *
 * Concentrating ownership matters for what comes later. Generation versioning
 * and stale-result fencing both work by guarding the moment something enters
 * the conversation, and that is only enforceable if there is exactly one place
 * where entry happens.
 *
 * Storage is in memory and per process: history is lost on restart and is not
 * shared across instances. Persistence is deliberately out of scope.
 *
 * This layer holds no generation stamps yet. Generation versioning arrives in
 * the next phase and will attach to the same entry point.
 */

export type ConversationRole = "user" | "assistant";

export interface ConversationMessage {
  readonly role: ConversationRole;
  readonly content: string;
}

export interface ConversationLimits {
  /** Conversations retained before the least recently used one is evicted. */
  readonly maxConversations: number;
  /** Messages retained per conversation before the oldest turns are dropped. */
  readonly maxMessages: number;
}

export const DEFAULT_CONVERSATION_LIMITS: ConversationLimits = {
  maxConversations: 100,
  maxMessages: 100,
};

/** Accepted shape for a client-supplied conversation id. */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

export function isValidConversationId(value: string): boolean {
  return ID_PATTERN.test(value);
}

interface StoredConversation {
  messages: ConversationMessage[];
}

export class ConversationStore {
  // Map iteration order is insertion order, and every access re-inserts, so the
  // first entry is always the least recently used.
  private readonly conversations = new Map<string, StoredConversation>();

  constructor(
    private readonly limits: ConversationLimits = DEFAULT_CONVERSATION_LIMITS,
  ) {}

  /**
   * Returns the id of the conversation to use.
   *
   * An unknown id is created rather than rejected, so a client whose server
   * restarted simply continues with an empty history instead of erroring.
   */
  resolve(requestedId?: string): string {
    if (requestedId !== undefined && isValidConversationId(requestedId)) {
      this.touch(requestedId);
      return requestedId;
    }

    const id = crypto.randomUUID();
    this.touch(id);
    return id;
  }

  /** Authoritative history, oldest first. */
  history(id: string): readonly ConversationMessage[] {
    return this.conversations.get(id)?.messages ?? [];
  }

  /**
   * Appends a completed exchange.
   *
   * Both halves are written together so a failed reply can never leave a
   * dangling user message behind - which would produce two consecutive user
   * turns on the next request.
   */
  appendExchange(id: string, userMessage: string, assistantMessage: string): void {
    const conversation = this.touch(id);
    conversation.messages.push(
      { role: "user", content: userMessage },
      { role: "assistant", content: assistantMessage },
    );
    this.trimMessages(conversation);
  }

  /**
   * Number of conversations currently held. Not yet exposed by any endpoint;
   * it exists for tests and for the observability phase.
   */
  size(): number {
    return this.conversations.size;
  }

  /** Marks a conversation as most recently used, creating it if needed. */
  private touch(id: string): StoredConversation {
    const existing = this.conversations.get(id);

    if (existing !== undefined) {
      this.conversations.delete(id);
      this.conversations.set(id, existing);
      return existing;
    }

    const created: StoredConversation = { messages: [] };
    this.conversations.set(id, created);
    this.evictOverflow();
    return created;
  }

  private evictOverflow(): void {
    while (this.conversations.size > this.limits.maxConversations) {
      const oldest = this.conversations.keys().next();
      if (oldest.done === true) return;
      this.conversations.delete(oldest.value);
    }
  }

  private trimMessages(conversation: StoredConversation): void {
    if (conversation.messages.length <= this.limits.maxMessages) return;

    conversation.messages = conversation.messages.slice(-this.limits.maxMessages);

    // History must not begin with an assistant turn - a reply with nothing to
    // reply to is not a valid conversation to hand any provider.
    if (conversation.messages[0]?.role === "assistant") {
      conversation.messages.shift();
    }
  }
}
