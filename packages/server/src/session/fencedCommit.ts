import type { ConversationStore } from "./conversationState";
import type { Generation } from "./generationManager";

/**
 * The single door through which a completed result may enter a conversation.
 *
 * Architecture section 7 is explicit that there must be exactly one such
 * function: "scattering the check across several call sites guarantees that one
 * is eventually missed". Every caller that has produced a result and wants it
 * to affect conversation state goes through here, and nothing else calls
 * `appendExchange` directly.
 *
 * ## Why stale work cannot commit
 *
 * The staleness check and the append happen in one synchronous block with no
 * `await` between them. JavaScript runs this to completion before any other
 * task, including any other request handler, can advance the generation. So
 * there is no window in which a result is judged current, the generation moves,
 * and the result is then written anyway.
 *
 * This holds regardless of what happened to the work itself. The provider may
 * have ignored its abort signal, may never have been sent one, may have
 * finished long after the interruption. None of that is consulted. The only
 * question asked is whether the stamp taken when the work started is still the
 * generation that is current now.
 */

export type CommitOutcome =
  | {
      readonly committed: true;
      readonly generation: Generation;
    }
  | {
      readonly committed: false;
      readonly reason: "stale";
      /** The generation the work was stamped with when it started. */
      readonly resultGeneration: Generation;
      /** The generation that is current now, which superseded it. */
      readonly currentGeneration: Generation;
    };

/**
 * Commits a completed exchange if, and only if, it still belongs to the current
 * generation.
 *
 * Both halves of the exchange are written together by `appendExchange`, so a
 * fenced result leaves no dangling user turn and no half-written state - the
 * transcript is either advanced by a whole turn or untouched.
 *
 * Must stay synchronous. Introducing an `await` between the check and the
 * append would open exactly the race this function exists to close.
 *
 * This function records no events. Observability is written by the caller from
 * the outcome it returns, so that the correctness path stays free of anything
 * that is not part of the decision.
 */
export function commitExchange(
  conversations: ConversationStore,
  conversationId: string,
  resultGeneration: Generation,
  userMessage: string,
  assistantMessage: string,
): CommitOutcome {
  const generations = conversations.generationFor(conversationId);

  if (generations.isStale(resultGeneration)) {
    return {
      committed: false,
      reason: "stale",
      resultGeneration,
      currentGeneration: generations.now(),
    };
  }

  conversations.appendExchange(
    conversationId,
    resultGeneration,
    userMessage,
    assistantMessage,
  );
  return { committed: true, generation: resultGeneration };
}
