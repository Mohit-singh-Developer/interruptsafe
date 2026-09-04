import type { ConversationEvent, ConversationEventType } from "@interruptsafe/shared";
import type { Generation } from "./generationManager";

/**
 * ConversationEventLog - a bounded, in-memory record of lifecycle transitions
 * for one conversation.
 *
 * ## This is observability, not correctness
 *
 * Nothing reads these events back to make a decision. `GenerationManager`
 * remains the authority on whether work is current, and `fencedCommit` remains
 * the only gate on what may enter the transcript. Events are written *after*
 * those decisions have already been made, and describe them.
 *
 * The practical consequence is that this log can drop entries, be read stale,
 * or be removed entirely without affecting whether a stale result can commit.
 * That separation is deliberate: an observability channel that could change
 * behaviour would be a second source of truth.
 *
 * Storage is per process and bounded. One log is owned by each conversation in
 * `ConversationState`, so it is evicted along with the conversation rather than
 * accumulating for conversations that no longer exist.
 */

/** Retained events per conversation. Oldest are dropped once full. */
export const DEFAULT_MAX_EVENTS = 200;

export class ConversationEventLog {
  private readonly events: ConversationEvent[] = [];

  constructor(
    private readonly conversationId: string,
    private readonly maxEvents: number = DEFAULT_MAX_EVENTS,
  ) {}

  /**
   * Appends an event.
   *
   * `detail` is a short human-readable summary written by the call site. It
   * must never carry provider internals, credentials, or anything beyond what
   * the conversation already contains.
   */
  record(
    type: ConversationEventType,
    detail: string,
    generation?: Generation,
  ): ConversationEvent {
    const event: ConversationEvent = {
      id: crypto.randomUUID(),
      conversationId: this.conversationId,
      type,
      at: new Date().toISOString(),
      detail,
      ...(generation === undefined ? {} : { generation }),
    };

    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }

    return event;
  }

  /** Chronological, oldest first. */
  list(): readonly ConversationEvent[] {
    return this.events;
  }

  /** Retained event count. Used by tests. */
  size(): number {
    return this.events.length;
  }
}
