import type { Config } from "../config";
import { ConfigError } from "../config";
import { createAnthropicProvider } from "./anthropicProvider";
import { createDeterministicProvider } from "./deterministicProvider";

/**
 * The seam between the conversation route and whatever actually produces a
 * reply. The route depends only on the `LlmProvider` interface, so providers
 * can be swapped without the route changing.
 *
 * Scope note: this interface is intentionally non-streaming, matching section
 * 10.1 of docs/ARCHITECTURE.md. Section 10.3 describes the eventual streaming
 * form (`streamTurn(request, signal)`), introduced only in the phase that
 * actually needs token streaming. Phase 3 adds a real provider behind this
 * unchanged shape.
 */

/** One turn of a conversation as the provider sees it. */
export interface LlmTurn {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface LlmRequest {
  /**
   * The conversation so far, oldest first, ending with the new user turn.
   *
   * The agent layer deliberately defines its own turn shape rather than
   * importing the session module's, so providers stay independent of how
   * history happens to be stored.
   */
  readonly messages: readonly LlmTurn[];
}

export interface LlmResult {
  /** The assistant's reply. */
  readonly message: string;
}

export interface LlmProvider {
  /** Identifier used in logs, so it is obvious which provider served a reply. */
  readonly name: string;
  generate(request: LlmRequest): Promise<LlmResult>;
}

/**
 * Single construction point for the active provider, selected by
 * `LLM_PROVIDER`. There is deliberately no fallback from a requested real
 * provider to the mock: a misconfigured "anthropic" selection fails at startup
 * rather than quietly serving fake replies.
 */
export function createLlmProvider(config: Config): LlmProvider {
  switch (config.provider) {
    case "anthropic": {
      if (config.anthropic === undefined) {
        throw new ConfigError(
          'LLM_PROVIDER is "anthropic" but its configuration is missing.',
        );
      }
      return createAnthropicProvider(config.anthropic);
    }
    case "deterministic":
      return createDeterministicProvider();
  }
}
