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
 * form (`streamTurn(request, signal)`); the `signal` half of that shape is
 * present now because interruption gives it something to do, while streaming
 * still waits for the phase that actually needs token-level output.
 */

/** One turn of a conversation as the provider sees it. */
export interface LlmTurn {
  readonly role: "user" | "assistant";
  readonly content: string;
}

/**
 * Output of a MOCK tool that ran for this turn and passed its fence.
 *
 * Supplied as context for composing the reply. It is not part of the
 * conversation: it is never stored, and a later turn will not see it unless the
 * tool runs again.
 */
export interface LlmToolContext {
  readonly tool: string;
  readonly summary: string;
  readonly rows: readonly string[];
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
  /** Present only when a tool ran for this turn and its result was current. */
  readonly toolContext?: LlmToolContext;
}

export interface LlmResult {
  /** The assistant's reply. */
  readonly message: string;
}

export interface LlmProvider {
  /** Identifier used in logs, so it is obvious which provider served a reply. */
  readonly name: string;

  /**
   * Produces one complete reply.
   *
   * `signal` is **advisory**. A provider may honour it and abandon the work
   * early, or may ignore it entirely and return a perfectly good result after
   * the caller has moved on. Neither behaviour affects correctness: whether the
   * result is allowed to touch the conversation is decided afterwards by the
   * generation check in `session/fencedCommit.ts`, not here.
   *
   * A provider that ignores the signal is therefore a legitimate provider, not
   * a broken one - it simply forfeits the latency and cost saving.
   */
  generate(request: LlmRequest, signal: AbortSignal): Promise<LlmResult>;
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
      return createDeterministicProvider(config.deterministicDelayMs);
  }
}
