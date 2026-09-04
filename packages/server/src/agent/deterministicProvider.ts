import { setTimeout as delay } from "node:timers/promises";
import type { LlmProvider, LlmRequest, LlmResult } from "./llmProvider";

/**
 * MOCK PROVIDER - retained as a selectable provider for local development and
 * testing.
 *
 * This is not a language model and makes no network call. It exists so the
 * full path from the browser to the backend and back can be exercised and
 * tested without a network dependency, which is what will let the later
 * interruption and stale-result tests run deterministically.
 *
 * The reply is a pure function of the input, so a given conversation always
 * produces the same output and assertions can be written against it.
 *
 * ## It deliberately ignores its abort signal
 *
 * The `signal` argument is accepted and then not used. This is intentional, not
 * an oversight. It makes this provider a faithful stand-in for the hard case
 * the whole project exists to handle: a provider that cannot or will not stop,
 * and returns a complete result after the user has already moved on.
 *
 * Because the result is fenced by its generation stamp when it tries to commit,
 * that work is discarded correctly anyway. A provider that honours the signal
 * would only save time and money; it would not change the outcome.
 */

const PROVIDER_NAME = "deterministic-mock";

/**
 * Optional artificial latency, in milliseconds.
 *
 * DEVELOPMENT AID ONLY. The mock is otherwise instantaneous, which leaves no
 * window in which to press Interrupt by hand. Configured by
 * `DEV_DETERMINISTIC_DELAY_MS` and defaulting to 0, so it is inert unless
 * explicitly switched on. It is not part of the correctness model, and the
 * delay is deliberately not abortable - see the note above.
 */
export function createDeterministicProvider(delayMs = 0): LlmProvider {
  return {
    name: PROVIDER_NAME,

    async generate(request: LlmRequest, _signal: AbortSignal): Promise<LlmResult> {
      if (delayMs > 0) {
        // Not passed the signal on purpose: this wait is uninterruptible.
        await delay(delayMs);
      }

      const latest = request.messages.at(-1);
      const text = latest?.content ?? "";

      const characters = text.length;
      const words = text.split(/\s+/).filter(Boolean).length;

      // The new user turn is included in the list, so earlier turns exclude it.
      const earlierUserTurns =
        request.messages.filter((turn) => turn.role === "user").length - 1;

      // The first-turn wording is unchanged from before history existed, so a
      // single-turn request still produces byte-identical output.
      const base =
        `You said: "${text}" ` +
        `(${words} ${words === 1 ? "word" : "words"}, ${characters} characters). ` +
        `This is a deterministic Phase 2 response - no language model was called.`;

      return {
        message:
          earlierUserTurns > 0
            ? `${base} Earlier user turns in this conversation: ${earlierUserTurns}.`
            : base,
      };
    },
  };
}
