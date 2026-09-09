import { setTimeout as delay } from "node:timers/promises";
import type { LlmProvider, LlmRequest, LlmResult } from "./llmProvider";

/**
 * MOCK PROVIDER - the zero-cost default, selectable for local development,
 * testing, and any demo that must run without a credential.
 *
 * This is NOT a language model. It makes no network call and does no
 * reasoning: every reply is a pure function of the input, which is precisely
 * what makes the interruption and stale-result tests reproducible.
 *
 * ## Why the replies are written to be spoken
 *
 * Whatever this returns is committed, then handed to Rime and read aloud to a
 * driver who cannot look at a screen. An earlier version echoed the user's
 * words back with a word count and a sentence of self-description, which was
 * honest but made the product sound like a stub and wasted several seconds of
 * the listener's attention on every turn.
 *
 * So the replies below are short, spoken-first, and state the assistant's real
 * scope rather than implying an intelligence it does not have. It answers
 * within a narrow domain - hotels, flights, weather - and says so plainly when
 * asked for anything else. That is an honest description of what it is.
 *
 * Disclosure of the mock now lives where it belongs: in the UI, in the activity
 * timeline, and in the README. The word "mock" still appears in every tool
 * summary, so a listener is told the data is synthetic without having a
 * paragraph of disclaimer read to them before every answer.
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

/** Matched in order; the first hit wins. Keeps selection deterministic. */
const REPLIES: ReadonlyArray<{ readonly match: RegExp; readonly reply: string }> = [
  {
    match: /\b(hello|hi|hey|good morning|good evening)\b/i,
    reply:
      "Hello. I can look up hotels, flights or the weather for somewhere on your route. " +
      "Say the name of a town and what you need.",
  },
  {
    match: /\b(thanks|thank you|cheers|appreciate)\b/i,
    reply: "Any time. Anything else you need on the way?",
  },
  {
    match: /\b(what can you do|what do you do|help|options)\b/i,
    reply:
      "Three things. I can find hotels in a town, look up flights between two cities, " +
      "or read out the weather. Just say the place.",
  },
  {
    match: /\b(stop|quiet|never mind|nothing|cancel)\b/i,
    reply: "Understood. I will stay quiet until you need me.",
  },
  {
    match: /\b(yes|yeah|yep|ok|okay|sure|go ahead)\b/i,
    reply: "Right. Tell me the town and I will look it up.",
  },
];

const FALLBACK =
  "I only handle hotels, flights and weather on this route, so I cannot answer that one. " +
  "Try something like: find hotels in Jaipur.";

/**
 * Picks a reply for a turn that ran no tool.
 *
 * Deterministic by construction: same input, same output, every time.
 */
function conversationalReply(text: string): string {
  for (const { match, reply } of REPLIES) {
    if (match.test(text)) return reply;
  }
  return FALLBACK;
}

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

      // When a mock tool ran for this turn, its output composes the reply. The
      // summary already contains the word "mock", so the data is disclosed as
      // synthetic in the one place a listener will actually hear it.
      if (request.toolContext !== undefined) {
        const { summary, rows } = request.toolContext;
        // A tool with no rows is asking for a missing detail rather than
        // reporting a result, so the summary stands alone - appending an empty
        // join would leave a trailing full stop hanging in the spoken output.
        return {
          message: rows.length === 0 ? summary : `${summary}. ${rows.join(". ")}`,
        };
      }

      const latest = request.messages.at(-1);
      return { message: conversationalReply(latest?.content ?? "") };
    },
  };
}
