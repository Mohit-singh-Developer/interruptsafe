import { setTimeout as delay } from "node:timers/promises";
import type { MockToolMode, Tool, ToolInput, ToolResult } from "./tool";

/**
 * MOCK TOOLS - synthetic data only.
 *
 * None of these make a network call, and none of them return real information.
 * The flights, temperatures and hotels below are invented from a hash of the
 * input so that the same question always produces the same answer. They exist
 * to give the system slow, interruptible background work to reason about, not
 * to be useful.
 *
 * Nothing here should ever be presented to a user as genuine flight, weather or
 * hotel data.
 *
 * ## Delay and cancellation behaviour
 *
 * `delayMs` is a development aid (`DEV_MOCK_TOOL_DELAY_MS`, default 0). Without
 * it these tools return instantly and there is no window in which to interrupt.
 *
 * `mode` selects how the tool reacts to its abort signal:
 *
 * - `cooperative` waits with the signal attached, so an interruption makes the
 *   wait throw and the tool stops early.
 * - `stubborn` waits without the signal, finishes its work, and returns a
 *   perfectly good result after the user has moved on.
 *
 * Both are correct as far as this system is concerned. The stubborn mode is the
 * interesting one: it proves that the result is discarded by generation
 * fencing, not by cancellation having worked.
 */

/** Deterministic small integer from a string. Not a security hash. */
function hashOf(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) % 100000;
  }
  return hash;
}

function titleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

/**
 * Performs the artificial wait.
 *
 * In cooperative mode the signal is passed to the timer, so an abort rejects.
 * In stubborn mode it is deliberately withheld.
 */
async function pretendToWork(
  delayMs: number,
  mode: MockToolMode,
  signal: AbortSignal,
): Promise<void> {
  if (delayMs <= 0) return;

  if (mode === "cooperative") {
    await delay(delayMs, undefined, { signal });
    return;
  }

  // Stubborn: the signal is ignored on purpose.
  await delay(delayMs);
}

/**
 * A result that asks for the missing detail instead of inventing one.
 *
 * These tools used to substitute a default place when none was parsed, so
 * "find some flights" answered confidently about Delhi to Mumbai - a route the
 * user never mentioned. For a product whose whole claim is that nothing the
 * user did not ask for is ever spoken as current, quietly inventing the subject
 * of the answer is the worst available failure. Asking is both honest and the
 * behaviour the situation calls for: the driver can simply say the town.
 *
 * Empty rows are deliberate - there is nothing to list yet.
 */
function needMoreDetail(question: string): ToolResult {
  return { summary: question, rows: [] };
}

export function createMockTravelTools(
  delayMs: number,
  mode: MockToolMode,
): readonly Tool[] {
  const searchFlights: Tool = {
    name: "searchFlights",
    description: "MOCK: returns invented flights between two cities.",

    async execute(input: ToolInput, signal: AbortSignal): Promise<ToolResult> {
      // Asked BEFORE the artificial delay: there is nothing to look up, so
      // there is nothing to wait for. Pausing three seconds and then asking
      // which cities looks like a fault rather than a question.
      if (input.from === undefined || input.to === undefined) {
        return needMoreDetail("Which two cities are you flying between?");
      }

      await pretendToWork(delayMs, mode, signal);

      const from = titleCase(input.from);
      const to = titleCase(input.to);
      const seed = hashOf(`${from}->${to}`);

      const rows = [0, 1, 2].map((index) => {
        const hour = 6 + ((seed + index * 7) % 12);
        const price = 3200 + ((seed + index * 311) % 4800);
        const code = `IS${100 + ((seed + index * 13) % 800)}`;
        return `${code}  ${from} -> ${to}  departs ${String(hour).padStart(2, "0")}:00  approx INR ${price}`;
      });

      return {
        summary: `3 mock flights from ${from} to ${to}`,
        rows,
      };
    },
  };

  const checkWeather: Tool = {
    name: "checkWeather",
    description: "MOCK: returns an invented forecast for a city.",

    async execute(input: ToolInput, signal: AbortSignal): Promise<ToolResult> {
      if (input.city === undefined) {
        return needMoreDetail("Which town should I check the weather for?");
      }

      await pretendToWork(delayMs, mode, signal);

      const city = titleCase(input.city);
      const seed = hashOf(city);
      const temperature = 18 + (seed % 17);
      const conditions = ["clear", "light rain", "overcast", "humid", "breezy"][seed % 5];

      return {
        summary: `Mock forecast for ${city}: ${temperature}C, ${conditions}`,
        rows: [
          `${city}  today  ${temperature}C  ${conditions}`,
          `${city}  tomorrow  ${temperature + ((seed % 3) - 1)}C  ${conditions}`,
        ],
      };
    },
  };

  const searchHotels: Tool = {
    name: "searchHotels",
    description: "MOCK: returns invented hotels in a city.",

    async execute(input: ToolInput, signal: AbortSignal): Promise<ToolResult> {
      if (input.city === undefined) {
        return needMoreDetail("Which town should I look for hotels in?");
      }

      await pretendToWork(delayMs, mode, signal);

      const city = titleCase(input.city);
      const seed = hashOf(city);
      const names = ["Harbour View", "Old Fort Residency", "Palm Court"];

      const rows = names.map((name, index) => {
        const rate = 2400 + ((seed + index * 517) % 6000);
        const rating = 3 + ((seed + index) % 3);
        return `${name}, ${city}  ${rating} star  approx INR ${rate}/night`;
      });

      return {
        summary: `3 mock hotels in ${city}`,
        rows,
      };
    },
  };

  return [searchFlights, checkWeather, searchHotels];
}
