import type { Generation } from "./generationManager";

/**
 * InFlightRegistry - tracks work that has started but not yet finished.
 *
 * It answers exactly one question: "which outstanding requests belong to
 * conversation X, and at which generation did each of them start?" That is
 * enough to ask those requests to stop when the conversation moves on.
 *
 * ## This is an optimisation, not the correctness mechanism
 *
 * Everything here is best-effort. `requestCancellation` calls `abort()` on the
 * controllers it holds, but abort is a *request*: a provider may ignore the
 * signal, may be past the point where stopping is possible, or may already have
 * produced a result that is sitting in a resolved promise. Any of those cases
 * ends with old work completing normally after the interruption.
 *
 * That is fine, and it is expected. Correctness comes from the generation
 * check applied when work tries to commit (see `fencedCommit.ts`), which holds
 * whether or not anything here succeeded. If this entire class were deleted,
 * the system would waste money and latency on doomed work but would still never
 * commit a stale result.
 *
 * Nothing in this registry is consulted when deciding whether a result may
 * commit. Keeping that separation explicit is the point.
 */

export interface InFlightHandle {
  /**
   * Passed to the provider so it *may* abandon the work early. A provider is
   * free to ignore it.
   */
  readonly signal: AbortSignal;
  /** Removes this entry. Must be called when the work settles, success or not. */
  release(): void;
}

interface Entry {
  readonly generation: Generation;
  readonly controller: AbortController;
}

export class InFlightRegistry {
  private readonly byConversation = new Map<string, Set<Entry>>();

  /**
   * Records that work has begun for a conversation at a given generation, and
   * returns the signal to hand to the provider.
   */
  register(conversationId: string, generation: Generation): InFlightHandle {
    const entry: Entry = { generation, controller: new AbortController() };

    let entries = this.byConversation.get(conversationId);
    if (entries === undefined) {
      entries = new Set<Entry>();
      this.byConversation.set(conversationId, entries);
    }
    entries.add(entry);

    return {
      signal: entry.controller.signal,
      release: () => {
        const current = this.byConversation.get(conversationId);
        if (current === undefined) return;
        current.delete(entry);
        if (current.size === 0) this.byConversation.delete(conversationId);
      },
    };
  }

  /**
   * Asks every outstanding request for this conversation to stop.
   *
   * Returns how many requests were signalled - what was *asked for*, never what
   * was achieved. Entries are not removed here; each request removes its own
   * entry when it settles, because a provider that ignores the signal will
   * still settle eventually.
   */
  requestCancellation(conversationId: string): number {
    const entries = this.byConversation.get(conversationId);
    if (entries === undefined) return 0;

    let signalled = 0;
    for (const entry of entries) {
      if (!entry.controller.signal.aborted) {
        entry.controller.abort();
        signalled += 1;
      }
    }
    return signalled;
  }

  /** Outstanding request count for a conversation. Used by logs and tests. */
  countFor(conversationId: string): number {
    return this.byConversation.get(conversationId)?.size ?? 0;
  }
}
