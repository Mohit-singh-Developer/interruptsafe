import type { GenerationManager, Generation } from "../session/generationManager";
import type { Tool, ToolInput, ToolResult } from "./tool";

/**
 * The fencing boundary for tool results.
 *
 * Architecture section 7 places this here, and its job is narrow: run a tool,
 * then decide whether what came back is still allowed to matter. Tools never
 * make that decision themselves and never touch conversation state, so there is
 * exactly one place where a stale tool result can be stopped.
 *
 * ## Relationship to `fencedCommit`
 *
 * This does not replace `session/fencedCommit.ts`, and it does not weaken it.
 * There are two distinct moments where staleness matters:
 *
 * 1. Here, when a tool result would otherwise be fed to the provider. Rejecting
 *    it early avoids paying for a reply built on abandoned work.
 * 2. In `fencedCommit`, when the finished reply would enter the transcript.
 *    That remains the guarantee, and it holds even if this check were removed
 *    entirely - a reply built from a stale tool result would still be refused
 *    at commit time, because its own stamp would be stale too.
 *
 * So this is an early exit, not a second source of truth.
 *
 * The generation is supplied by the caller and is never derived from the tool.
 */

export type ToolDispatchOutcome =
  | {
      readonly kind: "accepted";
      readonly result: ToolResult;
      readonly generation: Generation;
    }
  | {
      /** The tool finished, but the conversation had already moved on. */
      readonly kind: "stale";
      readonly resultGeneration: Generation;
      readonly currentGeneration: Generation;
    }
  | {
      /** The tool honoured its abort signal and stopped early. */
      readonly kind: "cancelled";
      readonly resultGeneration: Generation;
      readonly currentGeneration: Generation;
    }
  | {
      /** The tool threw for a reason unrelated to cancellation. */
      readonly kind: "failed";
      readonly resultGeneration: Generation;
    };

function wasAborted(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  return error instanceof Error && error.name === "AbortError";
}

export async function dispatchTool(
  tool: Tool,
  input: ToolInput,
  generation: Generation,
  generations: GenerationManager,
  signal: AbortSignal,
): Promise<ToolDispatchOutcome> {
  let result: ToolResult;

  try {
    result = await tool.execute(input, signal);
  } catch (error) {
    if (wasAborted(error, signal)) {
      return {
        kind: "cancelled",
        resultGeneration: generation,
        currentGeneration: generations.now(),
      };
    }
    return { kind: "failed", resultGeneration: generation };
  }

  // The tool produced something. Whether it may be used is decided here, and
  // has nothing to do with whether cancellation was requested or honoured.
  if (generations.isStale(generation)) {
    return {
      kind: "stale",
      resultGeneration: generation,
      currentGeneration: generations.now(),
    };
  }

  return { kind: "accepted", result, generation };
}
