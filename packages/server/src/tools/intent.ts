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

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Returns the tool a message asks for, or null for an ordinary message.
 *
 * Hotels are checked before weather so that "hotels in Goa with good weather"
 * resolves to the hotel search rather than the forecast.
 */
export function detectToolIntent(message: string): ToolIntent | null {
  const lower = message.toLowerCase();

  if (lower.includes("flight")) {
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

  if (lower.includes("hotel")) {
    return { tool: "searchHotels", input: { city: clean(CITY.exec(message)?.[1]) } };
  }

  if (lower.includes("weather")) {
    return { tool: "checkWeather", input: { city: clean(CITY.exec(message)?.[1]) } };
  }

  return null;
}
