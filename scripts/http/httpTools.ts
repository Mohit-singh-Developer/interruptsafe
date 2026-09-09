/**
 * End-to-end verification of tool interruption and stale-result fencing.
 *
 * REQUIRES the server started with DEV_MOCK_TOOL_DELAY_MS set (e.g. 1500) and a
 * known DEV_MOCK_TOOL_MODE. Pass the expected mode as argv[2]:
 *
 *   DEV_MOCK_TOOL_DELAY_MS=1500 DEV_MOCK_TOOL_MODE=stubborn npm run dev:server
 *   npm run verify:http
 */
const BASE = "http://127.0.0.1:8787";
const MODE = (process.argv[2] ?? "cooperative") as "cooperative" | "stubborn";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label}` +
      (ok ? "" : `\n        expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`),
  );
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function chat(conversationId: string, message: string) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, conversationId }),
  });
  return { status: res.status, body: (await res.json()) as any };
}
async function interrupt(conversationId: string) {
  const res = await fetch(`${BASE}/api/interrupt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId }),
  });
  return { status: res.status, body: (await res.json()) as any };
}
async function activity(conversationId: string) {
  const res = await fetch(`${BASE}/api/conversations/${conversationId}/activity`);
  return { status: res.status, body: (await res.json()) as any };
}

console.log(`### MODE UNDER TEST: ${MODE} ###\n`);

const P = `P-${Date.now()}`;
const T = `T-${Date.now()}`;
const I = `I-${Date.now()}`;
const B = `B-${Date.now()}`;

console.log("--- backward compatibility: a plain message still behaves as before ---");
{
  const plain = await chat(P, "Hello");
  check("plain chat returns 200", plain.status, 200);
  check(
    "plain reply is the unchanged deterministic wording",
    plain.body.message.startsWith('You said: "Hello" (1 word, 5 characters).'),
    true,
  );
  const act = await activity(P);
  check(
    "no tool events for a plain message",
    act.body.events.some((e: any) => e.type.startsWith("tool-")),
    false,
  );
}

console.log("\n--- a mock tool request completes and is committed ---");
{
  const flights = await chat(T, "Find flights from Delhi to Mumbai");
  check("tool turn returns 200", flights.status, 200);
  check("reply is labelled MOCK DATA", flights.body.message.includes("MOCK DATA"), true);
  check("reply names the tool", flights.body.message.includes("searchFlights"), true);
  check("reply mentions the parsed route", flights.body.message.includes("Delhi -> Mumbai"), true);

  const act = await activity(T);
  const types = act.body.events.map((e: any) => e.type);
  check("tool-started recorded", types.includes("tool-started"), true);
  check("tool-completed recorded", types.includes("tool-completed"), true);
  check("result-committed recorded", types.includes("result-committed"), true);
  check(
    "tool name captured on the event",
    act.body.events.find((e: any) => e.type === "tool-started").tool,
    "searchFlights",
  );
  check("transcript holds the committed exchange", act.body.transcript.length, 1);

  // Determinism: the same question returns the same rows.
  const again = await chat(T, "Find flights from Delhi to Mumbai");
  const firstRows = flights.body.message.split("\n").slice(1).join("\n");
  const againRows = again.body.message.split("\n").slice(1).join("\n");
  check("mock data is deterministic", againRows, firstRows);

  const weather = await chat(T, "Check weather in Mumbai");
  check("weather tool selected", weather.body.message.includes("checkWeather"), true);
  const hotels = await chat(T, "Find hotels in Goa");
  check("hotel tool selected", hotels.body.message.includes("searchHotels"), true);
}

console.log("\n--- THE CORE SCENARIO: interrupt while a mock tool is running ---");
{
  const inFlight = chat(I, "Find flights from Delhi to Mumbai");
  await sleep(400);

  const mid = await activity(I);
  const midTypes = mid.body.events.map((e: any) => e.type);
  check("tool-started visible while the tool runs", midTypes.includes("tool-started"), true);
  check("tool has not completed yet", midTypes.includes("tool-completed"), false);
  check("generation is 1 while running", mid.body.currentGeneration, 1);

  const interrupted = await interrupt(I);
  check("interrupt advanced generation to 2", interrupted.body.generation, 2);
  check("cancellation requested for the in-flight turn", interrupted.body.cancellationRequested, 1);

  const old = await inFlight;
  check("the interrupted tool turn returns 409", old.status, 409);
  check("status is superseded", old.body.status, "superseded");
  check("no message field - not an active result", old.body.message, undefined);

  const after = await activity(I);
  const afterTypes = after.body.events.map((e: any) => e.type);

  if (MODE === "stubborn") {
    check(
      "STUBBORN: tool ignored cancellation, finished, and was FENCED",
      afterTypes.includes("tool-result-fenced"),
      true,
    );
    check("STUBBORN: not reported as cancelled", afterTypes.includes("tool-cancelled"), false);
  } else {
    check(
      "COOPERATIVE: tool honoured cancellation and stopped early",
      afterTypes.includes("tool-cancelled"),
      true,
    );
  }

  check("either way, no tool-completed for that turn", afterTypes.includes("tool-completed"), false);
  check("either way, nothing was committed", afterTypes.includes("result-committed"), false);
  check("transcript has NO committed exchange", after.body.transcript.filter((e: any) => e.kind === "exchange").length, 0);
  check(
    "transcript has the interruption marker",
    after.body.transcript.some((e: any) => e.kind === "interruption"),
    true,
  );

  console.log("\n--- a later generation proceeds normally ---");
  const fresh = await chat(I, "Find hotels in Goa");
  check("new turn succeeds", fresh.status, 200);
  check("generation is 3", fresh.body.generation, 3);
  check("new turn used its own tool", fresh.body.message.includes("searchHotels"), true);
  check(
    "PROOF: the abandoned flight search never entered history",
    fresh.body.message.includes("Earlier user turns"),
    false,
  );

  const final = await activity(I);
  check(
    "transcript now holds exactly one committed exchange",
    final.body.transcript.filter((e: any) => e.kind === "exchange").length,
    1,
  );
  check(
    "and it is the hotels turn, not the fenced flights turn",
    final.body.transcript.find((e: any) => e.kind === "exchange").user,
    "Find hotels in Goa",
  );

  console.log("\n   timeline:");
  for (const e of final.body.events) {
    console.log(`     ${e.generation}:${e.type}${e.tool ? ` (${e.tool})` : ""}`);
  }
}

console.log("\n--- conversation isolation ---");
{
  const other = await chat(B, "Check weather in Delhi");
  check("B starts at generation 1", other.body.generation, 1);
  const act = await activity(B);
  check(
    "B has no fenced or cancelled tool events",
    act.body.events.some((e: any) =>
      ["tool-result-fenced", "tool-cancelled"].includes(e.type),
    ),
    false,
  );
  check("I unaffected", (await activity(I)).body.currentGeneration, 3);
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
