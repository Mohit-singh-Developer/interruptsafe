/**
 * Verification of deterministic tool intent detection.
 *
 * The arguments this parser extracts are spoken aloud by the assistant, so a
 * sloppy capture is not a cosmetic bug: "hotels in Udaipur instead" once
 * yielded the city "Udaipur instead", which Rime would then have pronounced.
 * These checks pin the demo utterances and the trailing-word behaviour.
 */
const { detectToolIntent } = (await import(
  "../../packages/server/src/tools/intent.ts"
)) as any;

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label}` +
      (ok
        ? ""
        : `\n        expected=${JSON.stringify(expected)}\n        actual  =${JSON.stringify(actual)}`),
  );
}

/** Asserts the tool selected and the arguments extracted for one utterance. */
function intent(label: string, message: string, tool: string | null, input?: unknown): void {
  const result = detectToolIntent(message);
  if (tool === null) {
    check(label, result, null);
    return;
  }
  check(label, result === null ? null : { tool: result.tool, input: result.input }, {
    tool,
    input,
  });
}

console.log("--- tool selection by keyword ---");
{
  intent("flight keyword selects the flight search", "Find flights from Delhi to Mumbai", "searchFlights", {
    from: "Delhi",
    to: "Mumbai",
  });
  intent("hotel keyword selects the hotel search", "Find hotels in Jaipur", "searchHotels", {
    city: "Jaipur",
  });
  intent("weather keyword selects the forecast", "What is the weather in Jaipur", "checkWeather", {
    city: "Jaipur",
  });
  intent("an ordinary message selects no tool", "Hello there", null);
  // Documented precedence: hotels are checked before weather.
  intent(
    "hotels win over weather in one sentence",
    "hotels in Goa with good weather",
    "searchHotels",
    { city: "Goa" },
  );
}

console.log("\n--- the demo utterances, exactly as scripted ---");
{
  intent("opening request", "Find hotels in Jaipur", "searchHotels", { city: "Jaipur" });
  intent(
    "the mid-sentence change of mind",
    "Actually, make it hotels in Udaipur",
    "searchHotels",
    { city: "Udaipur" },
  );
}

console.log("\n--- trailing words must not become part of the place ---");
{
  // The regression this suite exists for. Each of these once produced a place
  // name with the trailing word attached, which was then spoken aloud.
  intent("'instead' is not part of the city", "Actually, find hotels in Udaipur instead", "searchHotels", {
    city: "Udaipur",
  });
  intent("'for tonight' is not part of the city", "Find me a hotel in Jaipur for tonight", "searchHotels", {
    city: "Jaipur",
  });
  intent("'please' is not part of the city", "Find hotels in Udaipur please", "searchHotels", {
    city: "Udaipur",
  });
  intent("'tomorrow' is not part of the destination", "Find flights from Delhi to Mumbai tomorrow", "searchFlights", {
    from: "Delhi",
    to: "Mumbai",
  });
  intent("'now' is not part of the city", "Check the weather in Udaipur now", "checkWeather", {
    city: "Udaipur",
  });
}

console.log("\n--- a keyword must be a request, not a mention ---");
{
  // REGRESSION, seen in a real browser session: complaining ABOUT hotels ran a
  // hotel search and read three invented hotels aloud. Answering a question the
  // user did not ask is worse than answering nothing, because they hear it.
  intent(
    "complaining about hotels is not a hotel search",
    "why are you just asking me about hotels and droughts",
    null,
  );
  intent("a mention mid-sentence does not fire", "I hate hotels in general", null);
  intent(
    "talking about the weather in passing does not fire",
    "my friend was talking about the weather yesterday",
    null,
  );

  // ...but genuine requests still work, with or without a cue word.
  intent("a keyword-led request fires", "hotels in Goa", "searchHotels", { city: "Goa" });
  intent("a cue word anywhere fires", "I need hotels in Jaipur", "searchHotels", {
    city: "Jaipur",
  });
}

console.log("\n--- multi-word places still survive ---");
{
  intent("a two-word city is kept whole", "Find hotels in New Delhi", "searchHotels", {
    city: "New Delhi",
  });
  intent("a two-word city followed by a stop word", "Find hotels in New Delhi instead", "searchHotels", {
    city: "New Delhi",
  });
  intent("two-word route endpoints", "Find flights from New Delhi to Navi Mumbai", "searchFlights", {
    from: "New Delhi",
    to: "Navi Mumbai",
  });
}

console.log("\n--- a place that is only a stop word yields no argument ---");
{
  // Better to hand the tool nothing than to hand it a filler word: an absent
  // argument is a case the tools already handle.
  intent("bare stop word is dropped entirely", "Find hotels in please", "searchHotels", {
    city: undefined,
  });
  intent("no city at all", "Find hotels", "searchHotels", { city: undefined });
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
