import { createDeterministicProvider } from "./deterministicProvider";

/**
 * The seam between the conversation route and whatever actually produces a
 * reply. The route depends only on the `LlmProvider` interface, so a real
 * provider can be added without the route changing.
 *
 * Scope note: this interface is intentionally non-streaming for Phase 2, which
 * forbids both streaming and cancellation. Section 10 of docs/ARCHITECTURE.md
 * describes the eventual streaming form (`streamTurn(request, signal)`); that
 * shape is introduced in the phase that actually needs token streaming, rather
 * than being built speculatively now.
 */

export interface LlmRequest {
  /** The user's message for this turn. */
  readonly message: string;
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
 * Single construction point for the active provider.
 *
 * Phase 3 adds a real implementation and selects it here - for example from an
 * environment variable. Nothing outside this function needs to change.
 */
export function createLlmProvider(): LlmProvider {
  return createDeterministicProvider();
}
