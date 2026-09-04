/**
 * ConversationState - the single owner of conversation history.
 *
 * Everything that wants to read or extend a conversation goes through this
 * store. Nothing else keeps its own copy of the transcript: the browser holds a
 * display list, but the server's copy here is authoritative and is what the
 * provider is shown.
 *
 * Concentrating ownership matters. Generation versioning and stale-result
 * fencing both work by guarding the moment something enters the conversation,
 * and that is only enforceable if there is exactly one place where entry
 * happens.
 *
 * ## Two views of one conversation
 *
 * The store holds a list of `TranscriptEntry`. An entry is either a committed
 * exchange or a marker recording that the user interrupted.
 *
 * - `transcript(id)` returns the entries, markers included. This is what a
 *   person reads.
 * - `history(id)` projects *only* the exchanges into provider messages. A
 *   marker is not a turn and can never reach the provider, so an interruption
 *   is visible to the reader without becoming input to the model.
 *
 * Because exchanges are always stored as a user/assistant pair, the projection
 * is always well-formed: it starts with a user turn and alternates.
 *
 * Storage is in memory and per process: history is lost on restart and is not
 * shared across instances. Persistence is deliberately out of scope.
 *
 * Each conversation also owns a `GenerationManager` and a
 * `ConversationEventLog`. Keeping them here means both are isolated per
 * conversation by construction, and are evicted along with the conversation
 * they belong to instead of leaking after the transcript is gone.
 */

import type { ConversationEvent, TranscriptEntry } from "@interruptsafe/shared";
import { ConversationEventLog } from "./conversationEvents";
import { GenerationManager, INITIAL_GENERATION, type Generation } from "./generationManager";

export type ConversationRole = "user" | "assistant";

export interface ConversationMessage {
  readonly role: ConversationRole;
  readonly content: string;
}

export interface ConversationLimits {
  /** Conversations retained before the least recently used one is evicted. */
  readonly maxConversations: number;
  /** Provider messages retained per conversation before oldest turns drop. */
  readonly maxMessages: number;
  /** Events retained per conversation. */
  readonly maxEvents: number;
}

export const DEFAULT_CONVERSATION_LIMITS: ConversationLimits = {
  maxConversations: 100,
  maxMessages: 100,
  maxEvents: 200,
};

/** Accepted shape for a client-supplied conversation id. */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

export function isValidConversationId(value: string): boolean {
  return ID_PATTERN.test(value);
}

interface StoredConversation {
  entries: TranscriptEntry[];
  readonly generation: GenerationManager;
  readonly events: ConversationEventLog;
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

  /**
   * The provider's view: committed exchanges only, oldest first.
   *
   * Interruption markers are projected away here. They exist for the reader,
   * never for the model.
   */
  history(id: string): readonly ConversationMessage[] {
    const entries = this.conversations.get(id)?.entries ?? [];
    const messages: ConversationMessage[] = [];

    for (const entry of entries) {
      if (entry.kind !== "exchange") continue;
      messages.push(
        { role: "user", content: entry.user },
        { role: "assistant", content: entry.assistant },
      );
    }

    return messages;
  }

  /** The reader's view: committed exchanges plus interruption markers. */
  transcript(id: string): readonly TranscriptEntry[] {
    return this.conversations.get(id)?.entries ?? [];
  }

  /**
   * The generation owner for this conversation, created with it if needed.
   *
   * Each conversation gets its own instance, so advancing one conversation's
   * generation cannot invalidate work belonging to another.
   */
  generationFor(id: string): GenerationManager {
    return this.touch(id).generation;
  }

  /** The event log for this conversation, created with it if needed. */
  eventsFor(id: string): ConversationEventLog {
    return this.touch(id).events;
  }

  /**
   * Appends a completed exchange.
   *
   * Both halves are written together so a failed or fenced reply can never
   * leave a dangling user message behind - which would produce two consecutive
   * user turns on the next request.
   *
   * Callers reach this through `fencedCommit.ts`, never directly.
   */
  appendExchange(
    id: string,
    generation: Generation,
    userMessage: string,
    assistantMessage: string,
  ): void {
    const conversation = this.touch(id);
    conversation.entries.push({
      kind: "exchange",
      generation,
      user: userMessage,
      assistant: assistantMessage,
    });
    this.trimEntries(conversation);
  }

  /**
   * Records that the user interrupted, and the generation that resulted.
   *
   * This is a transcript marker only. It carries no message content, is not an
   * assistant turn, and is excluded from `history`, so it cannot influence what
   * the provider is asked next.
   */
  markInterruption(id: string, generation: Generation): void {
    const conversation = this.touch(id);
    conversation.entries.push({
      kind: "interruption",
      generation,
      at: new Date().toISOString(),
    });
    this.trimEntries(conversation);
  }

  /**
   * Read-only snapshot for the activity endpoint.
   *
   * Deliberately does not create the conversation and does not touch LRU order:
   * a read should not be able to allocate state, nor keep a conversation alive
   * just by being polled. An unknown id reads as an empty conversation rather
   * than an error, matching how an unknown id behaves elsewhere.
   */
  activity(id: string): {
    currentGeneration: Generation;
    events: readonly ConversationEvent[];
    transcript: readonly TranscriptEntry[];
  } {
    const conversation = this.conversations.get(id);

    if (conversation === undefined) {
      return { currentGeneration: INITIAL_GENERATION, events: [], transcript: [] };
    }

    return {
      currentGeneration: conversation.generation.now(),
      events: conversation.events.list(),
      transcript: conversation.entries,
    };
  }

  /**
   * Number of conversations currently held. Not exposed by any endpoint;
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

    const created: StoredConversation = {
      entries: [],
      generation: new GenerationManager(),
      events: new ConversationEventLog(id, this.limits.maxEvents),
    };
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

  /**
   * Bounds the transcript on two axes.
   *
   * Provider messages are bounded by `maxMessages`, since that is what gets
   * sent on every turn. Markers project to no messages, so they cost nothing
   * against that budget - but a conversation that is only ever interrupted
   * would then grow without limit, so the entry count is capped as well.
   *
   * A marker left at the front after trimming is kept. It is still a true
   * record of an interruption, `history` ignores markers entirely, and dropping
   * it would discard information for tidiness alone.
   */
  private trimEntries(conversation: StoredConversation): void {
    const messageCount = (entries: readonly TranscriptEntry[]): number =>
      entries.reduce((total, entry) => total + (entry.kind === "exchange" ? 2 : 0), 0);

    while (
      conversation.entries.length > 0 &&
      (messageCount(conversation.entries) > this.limits.maxMessages ||
        conversation.entries.length > this.limits.maxMessages)
    ) {
      conversation.entries.shift();
    }
  }
}
