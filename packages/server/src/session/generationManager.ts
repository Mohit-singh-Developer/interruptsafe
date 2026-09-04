/**
 * GenerationManager - the dedicated owner of one conversation's version.
 *
 * A generation is a single monotonically increasing integer per conversation.
 * Not a UUID, not a vector clock: the whole point is that the staleness test is
 * an integer comparison anyone can verify by eye.
 *
 * ## Why this is the correctness mechanism
 *
 * Every unit of asynchronous work is stamped with the generation that was
 * current when the work began. When the work finishes, its stamp is compared
 * against the generation that is current *now*. If they differ, the work
 * belongs to a conversation the user has already moved on from, and its result
 * must not be allowed to affect current state.
 *
 * This test is deliberately independent of cancellation. Cancelling an
 * in-flight request is best-effort: a third-party SDK may ignore an abort
 * signal, a network call may already have committed a side effect, and work
 * that has passed its point of no return cannot be recalled. If correctness
 * depended on cancellation succeeding, correctness would depend on the
 * cooperation of code we do not control.
 *
 * Advancing the generation, by contrast, is a local synchronous state change
 * that cannot fail partway. That is why it - and not cancellation - is what the
 * design rests on. Cancellation is an optimisation that saves latency and
 * money; the generation check is the guarantee.
 *
 * Consequently this class deliberately holds no `AbortController`. It stays
 * useful even when nothing can be cancelled at all.
 *
 * ## Scope
 *
 * `docs/ARCHITECTURE.md` section 6 also sketches `signalFor(g): AbortSignal`.
 * That is not implemented here: there is no in-flight cancellable work in the
 * system yet, so it would be a speculative API. It arrives with the phase that
 * introduces work worth cancelling, and when it does it must remain an
 * optimisation layered on top of this check, never a replacement for it.
 *
 * Enforcement of the check at the point where results enter the conversation -
 * the fencing choke point and its event log - is a later phase. This class
 * provides the primitive; it does not police its callers.
 */

export type Generation = number;

/**
 * Why a generation was advanced. Recorded so logs and, later, the event log can
 * explain what invalidated the previous generation.
 */
export type BumpReason = "new-user-turn" | "user-interruption";

/**
 * The value before any turn has been taken. The first user turn advances to 1,
 * so the generation always equals the number of turns that have started.
 */
export const INITIAL_GENERATION: Generation = 0;

export class GenerationManager {
  private current: Generation = INITIAL_GENERATION;
  private reason: BumpReason | null = null;

  /** The generation that new work should be stamped with. */
  now(): Generation {
    return this.current;
  }

  /** Why the current generation was entered, or null if none has been. */
  lastBumpReason(): BumpReason | null {
    return this.reason;
  }

  /**
   * Advances to a new generation, invalidating every outstanding stamp.
   *
   * This is the single act that makes older work obsolete. It is synchronous
   * and total: once it returns, no previously issued stamp is current any more.
   */
  bump(reason: BumpReason): Generation {
    this.current += 1;
    this.reason = reason;
    return this.current;
  }

  /** True when work stamped `generation` still belongs to the live conversation. */
  isCurrent(generation: Generation): boolean {
    return generation === this.current;
  }

  /**
   * True when work stamped `generation` must not affect current state.
   *
   * A value ahead of the current generation is also treated as stale. Such a
   * stamp should be impossible, so honouring it would mean trusting a number
   * this manager never issued.
   */
  isStale(generation: Generation): boolean {
    return !this.isCurrent(generation);
  }
}
