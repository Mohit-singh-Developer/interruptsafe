import type { LlmProvider, LlmRequest, LlmResult } from "./llmProvider";

/**
 * MOCK PROVIDER - retained as a selectable provider for local development and
 * testing.
 *
 * This is not a language model and makes no network call. It exists so the
 * full path from the browser to the backend and back can be exercised and
 * tested before a real provider is introduced.
 *
 * Phase 3 supplements or replaces this with a real provider. This file should
 * remain afterwards: a deterministic provider is what lets the later
 * interruption and stale-result tests run without a network dependency.
 *
 * The reply is a pure function of the input, so a given message always produces
 * the same output and assertions can be written against it.
 */

const PROVIDER_NAME = "deterministic-mock";

export function createDeterministicProvider(): LlmProvider {
  return {
    name: PROVIDER_NAME,

    async generate(request: LlmRequest): Promise<LlmResult> {
      const characters = request.message.length;
      const words = request.message.split(/\s+/).filter(Boolean).length;

      return {
        message:
          `You said: "${request.message}" ` +
          `(${words} ${words === 1 ? "word" : "words"}, ${characters} characters). ` +
          `This is a deterministic Phase 2 response - no language model was called.`,
      };
    },
  };
}
