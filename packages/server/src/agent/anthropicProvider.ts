import Anthropic from "@anthropic-ai/sdk";
import type { AnthropicConfig } from "../config";
import type { LlmProvider, LlmRequest, LlmResult } from "./llmProvider";

/**
 * REAL PROVIDER - Phase 3.
 *
 * Returns one complete response per call. No streaming and no tools; those
 * belong to later phases. Cancellation is forwarded to the SDK as an advisory
 * request - see `generate` below.
 *
 * The Messages API is stateless, so the whole conversation supplied by
 * `ConversationState` is sent on every turn.
 *
 * Verified against @anthropic-ai/sdk 0.123.0:
 *   - `client.messages.create({ model, max_tokens, system, thinking,
 *     output_config, messages })`
 *   - `output_config.effort` is nested, not a top-level parameter.
 *   - `thinking: { type: "adaptive" }`; `budget_tokens` is removed on current
 *     models and is rejected with a 400.
 *   - `response.content` is a discriminated union and must be narrowed on
 *     `type === "text"`.
 *   - `stop_reason` may be "refusal", returned with HTTP 200.
 */

/**
 * Documented default for non-streaming requests. This is a ceiling, not a
 * target; the system prompt is what keeps replies short.
 */
const MAX_TOKENS = 16000;

/**
 * Replies are destined to be spoken by Rime in a later phase, so they are kept
 * short and free of markup that would read badly aloud.
 */
const SYSTEM_PROMPT =
  "You are InterruptSafe, a concise voice assistant. Reply in at most three " +
  "short sentences of plain prose. Do not use markdown, lists, or headings, " +
  "because your reply will be spoken aloud.";

export function createAnthropicProvider(config: AnthropicConfig): LlmProvider {
  const client = new Anthropic({ apiKey: config.apiKey });

  return {
    name: `anthropic:${config.model}`,

    async generate(request: LlmRequest, signal: AbortSignal): Promise<LlmResult> {
      // The API is stateless, so the full conversation is sent every turn.
      const messages: Anthropic.MessageParam[] = request.messages.map((turn) => ({
        role: turn.role,
        content: turn.content,
      }));

      // The signal is forwarded as a request option so an abandoned turn can
      // stop billing tokens. This is a saving, not a guarantee: the request may
      // already have completed, and a response that arrives anyway is handled
      // by the generation check when it tries to commit.
      // Tool output is supplied as request-scoped context rather than as a
      // conversation turn, so it informs this reply without entering history.
      const system =
        request.toolContext === undefined
          ? SYSTEM_PROMPT
          : `${SYSTEM_PROMPT}\n\nA mock tool (${request.toolContext.tool}) returned ` +
            `synthetic data for this turn. Summarise it for the user and make clear ` +
            `it is mock data, not real information:\n${request.toolContext.summary}\n` +
            request.toolContext.rows.map((row) => `- ${row}`).join("\n");

      const response = await client.messages.create(
        {
          model: config.model,
          max_tokens: MAX_TOKENS,
          system,
          thinking: { type: "adaptive" },
          output_config: { effort: config.effort },
          messages,
        },
        { signal },
      );

      // A refusal arrives as a successful HTTP response, so it must be checked
      // before reading content - otherwise it looks like an empty reply.
      if (response.stop_reason === "refusal") {
        return {
          message:
            "I can't help with that request. Please try asking something else.",
        };
      }

      const text = response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("")
        .trim();

      if (text.length === 0) {
        throw new Error(
          `Model returned no text content (stop_reason: ${response.stop_reason}).`,
        );
      }

      return { message: text };
    },
  };
}
