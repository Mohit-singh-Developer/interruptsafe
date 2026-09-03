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
 */

const PROVIDER_NAME = "deterministic-mock";

export function createDeterministicProvider(): LlmProvider {
  return {
    name: PROVIDER_NAME,

    async generate(request: LlmRequest): Promise<LlmResult> {
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
