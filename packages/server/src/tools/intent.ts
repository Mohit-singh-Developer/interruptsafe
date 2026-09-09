import type { ToolInput } from "./tool";

/**
 * Deterministic tool triggering.
 *
 * There is no model in this path. A message is matched against a small set of
 * documented keyword rules, so the same sentence always selects the same tool
 * with the same arguments, and the whole tool demonstration runs with no API
 * key and no network.
 *
 * Real model-driven tool selection is a later concern. This exists so the
 * interruption behaviour around slow tools can be exercised now, at zero cost.
 *
 * The rules, in order:
 *
 *   "flight"  -> searchFlights   ("from <a> to <b>", or "<a> to <b>")
 *   "hotel"   -> searchHotels    ("in <city>")
 *   "weather" -> checkWeather    ("in <city>")
 *
 * Anything else is an ordinary message and behaves exactly as before.
 */

export interface ToolIntent {
  readonly tool: string;
  readonly input: ToolInput;
}

const ROUTE_WITH_FROM = /from\s+([a-z][a-z\s]*?)\s+to\s+([a-z][a-z\s]*?)\s*(?:[.?!,]|$)/i;
const ROUTE_BARE = /([a-z][a-z\s]*?)\s+to\s+([a-z][a-z\s]*?)\s*(?:[.?!,]|$)/i;
const CITY = /\bin\s+([a-z][a-z\s]*?)\s*(?:[.?!,]|$)/i;

/**
 * Words that end a place name in ordinary speech.
 *
 * A place is matched as consecutive words, which is what lets "New Delhi" work.
 * Without a stop list that run continues to the end of the sentence, so
 * "hotels in Udaipur instead" yields the city "Udaipur instead" - and because
 * the reply is synthesised, the assistant then says that aloud. This matters
 * more for speech than for typing: the user does not choose the transcript,
 * the recogniser does, and trailing words like these are exactly what a person
 * appends when they change their mind mid-sentence.
 *
 * Kept deliberately small. Every entry risks truncating a genuine place name,
 * so a word earns its place here only by being far more likely to follow a
 * place than to be part of one.
 */
const PLACE_STOP_WORDS = new Set([
  "instead",
  "please",
  "now",
  "tonight",
  "today",
  "tomorrow",
  "then",
  "again",
  "actually",
  "rather",
  "maybe",
  "for",
  "with",
  "near",
  "around",
  "about",
  "and",
  "or",
  "but",
  "this",
  "next",
  "at",
  "on",
  "by",
  "before",
  "after",
]);

/**
 * Trims a captured place name to the part that is actually a place.
 *
 * Returns undefined when nothing usable remains, which callers treat the same
 * as an absent argument.
 */
function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0) return undefined;

  const words: string[] = [];
  for (const word of trimmed.split(/\s+/)) {
    if (PLACE_STOP_WORDS.has(word.toLowerCase())) break;
    words.push(word);
  }

  const place = words.join(" ");
  return place.length === 0 ? undefined : place;
}

/**
 * Words that mark a message as an actual request rather than a mention.
 *
 * Matching a bare keyword is not enough. "why are you just asking me about
 * hotels" contains "hotels" but is a complaint, and answering it with a hotel
 * search - which is what happened before this existed - makes the assistant
 * look like it is not listening. That is worse than saying nothing useful,
 * because the user is told, out loud, an answer to a question they did not ask.
 */
const REQUEST_CUES =
  /\b(find|show|search|look|looking|get|give|list|need|want|book|check|suggest|recommend|nearest|closest|any|where|what|which|make it|change|switch)\b/i;

/** How far into a message a keyword can appear and still lead the request. */
const KEYWORD_LEAD_WORDS = 2;

/**
 * True when the message is asking for something, not merely mentioning it.
 *
 * Either an explicit request cue, or the keyword leading the message the way a
 * spoken request does - "hotels in Goa" is a request; "I hate hotels in
 * general" is not.
 */
function looksLikeRequest(message: string, keyword: string): boolean {
  if (REQUEST_CUES.test(message)) return true;

  const words = message.toLowerCase().split(/\s+/).filter(Boolean);
  const position = words.findIndex((word) => word.includes(keyword));
  return position >= 0 && position < KEYWORD_LEAD_WORDS;
}

/**
 * Returns the tool a message asks for, or null for an ordinary message.
 *
 * Hotels are checked before weather so that "hotels in Goa with good weather"
 * resolves to the hotel search rather than the forecast.
 */
export function detectToolIntent(message: string): ToolIntent | null {
  const lower = message.toLowerCase();

  if (lower.includes("flight") && looksLikeRequest(message, "flight")) {
    const withFrom = ROUTE_WITH_FROM.exec(message);
    const bare = withFrom ?? ROUTE_BARE.exec(message);

    return {
      tool: "searchFlights",
      input: {
        from: clean(bare?.[1]),
        to: clean(bare?.[2]),
      },
    };
  }

  if (lower.includes("hotel") && looksLikeRequest(message, "hotel")) {
    return { tool: "searchHotels", input: { city: clean(CITY.exec(message)?.[1]) } };
  }

  if (lower.includes("weather") && looksLikeRequest(message, "weather")) {
    return { tool: "checkWeather", input: { city: clean(CITY.exec(message)?.[1]) } };
  }

  return null;
}
