/**
 * End-to-end verification of the activity timeline and reader transcript.
 *
 * REQUIRES the server started with DEV_DETERMINISTIC_DELAY_MS set (e.g. 1500),
 * so that a turn is still in flight when the interruption is sent:
 *
 *   DEV_DETERMINISTIC_DELAY_MS=1500 npm run dev:server
 */
const BASE = "http://127.0.0.1:8787";

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
  const res = await fetch(
    `${BASE}/api/conversations/${encodeURIComponent(conversationId)}/activity`,
  );
  return { status: res.status, body: (await res.json()) as any };
}

const health = await (await fetch(`${BASE}/api/health`)).json();
// Reported for context, not asserted on. Every conversation id below is unique
// to this run, so a long-lived server cannot affect the outcome - requiring a
// young process only made the suite fail for anyone who left the server up
// while reading, or ran the other suites first.
console.log(
  `server uptime ${health.uptimeSeconds}s, speech provider ${health.speech?.provider}\n`,
);

const A = `A-${Date.now()}`;
const B = `B-${Date.now()}`;

console.log("\n--- 1..3: start a turn, confirm lifecycle events appear ---");
const inFlight = chat(A, "the OLD question");
await sleep(400);

const mid = await activity(A);
const midTypes = mid.body.events.map((e: any) => e.type);
check("activity endpoint returns 200", mid.status, 200);
check("generation-advanced recorded", midTypes.includes("generation-advanced"), true);
check("turn-started (provider work started) recorded", midTypes.includes("turn-started"), true);
check("current generation is 1 while in flight", mid.body.currentGeneration, 1);

console.log("\n--- 4..6: interrupt before completion ---");
const interrupted = await interrupt(A);
check("interrupt returned 200", interrupted.status, 200);
check("generation advanced to 2", interrupted.body.generation, 2);
check("cancellation requested for the in-flight turn", interrupted.body.cancellationRequested, 1);

const afterInterrupt = await activity(A);
const afterTypes = afterInterrupt.body.events.map((e: any) => e.type);
check("interruption-requested recorded", afterTypes.includes("interruption-requested"), true);
check("cancellation-requested recorded", afterTypes.includes("cancellation-requested"), true);

console.log("\n--- 7..10: stale work completes anyway and is fenced ---");
const old = await inFlight;
check("old turn returned 409 superseded", old.status, 409);
check("no message field on a fenced turn", old.body.message, undefined);

const afterFence = await activity(A);
const fenceTypes = afterFence.body.events.map((e: any) => e.type);
check("result-fenced recorded", fenceTypes.includes("result-fenced"), true);
check("result-committed NOT recorded yet", fenceTypes.includes("result-committed"), false);

const transcript = afterFence.body.transcript;
check(
  "transcript contains an interruption marker",
  transcript.some((e: any) => e.kind === "interruption"),
  true,
);
check(
  "transcript contains NO committed exchange yet",
  transcript.some((e: any) => e.kind === "exchange"),
  false,
);

console.log("\n--- 11..12: a later generation commits normally ---");
const fresh = await chat(A, "the NEW question");
check("new turn succeeded", fresh.status, 200);
check("generation is 3", fresh.body.generation, 3);
// Proved from the transcript rather than the provider's wording, so the proof
// survives swapping the provider for a real model.
const freshTranscript = (await activity(A)).body.transcript ?? [];
const freshExchanges = freshTranscript.filter((entry: any) => entry.kind === "exchange");
check("PROOF: stale turn never entered the transcript", freshExchanges.length, 1);
check(
  "PROOF: the committed exchange is the new one",
  freshExchanges[0]?.user,
  "the NEW question",
);

const afterFresh = await activity(A);
check(
  "result-committed now recorded",
  afterFresh.body.events.some((e: any) => e.type === "result-committed"),
  true,
);
check(
  "transcript now holds exactly one committed exchange",
  afterFresh.body.transcript.filter((e: any) => e.kind === "exchange").length,
  1,
);
check(
  "the committed exchange is the NEW question",
  afterFresh.body.transcript.find((e: any) => e.kind === "exchange").user,
  "the NEW question",
);
check(
  "marker still precedes it in the transcript",
  afterFresh.body.transcript.map((e: any) => e.kind),
  ["interruption", "exchange"],
);

console.log("\n--- 13: the timeline shows both lifecycles in order ---");
const ordered = afterFresh.body.events.map((e: any) => `${e.generation}:${e.type}`);
console.log("   " + ordered.join("\n   "));
check(
  "events are chronologically non-decreasing by generation",
  afterFresh.body.events.every(
    (e: any, i: number, all: any[]) => i === 0 || all[i - 1].at <= e.at,
  ),
  true,
);
check("first event belongs to generation 1", ordered[0], "1:generation-advanced");
check("last event is the commit at generation 3", ordered.at(-1), "3:result-committed");

console.log("\n--- isolation ---");
const bTurn = await chat(B, "unrelated");
check("B starts at generation 1", bTurn.body.generation, 1);
const bActivity = await activity(B);
check(
  "B has no fenced results",
  bActivity.body.events.some((e: any) => e.type === "result-fenced"),
  false,
);
check("B transcript has exactly one exchange", bActivity.body.transcript.length, 1);
check("A's activity unchanged by B", (await activity(A)).body.currentGeneration, 3);

console.log("\n--- id handling on the activity endpoint ---");
const malformed = await activity("has space");
check("malformed id rejected with 400", malformed.status, 400);
check("malformed id returns the project's { error } shape", typeof malformed.body.error, "string");

const unknown = await activity("never-existed-but-valid");
check("unknown valid id returns 200", unknown.status, 200);
check("unknown valid id reads as generation 0", unknown.body.currentGeneration, 0);
check("unknown valid id has no events", unknown.body.events.length, 0);
check("unknown valid id has empty transcript", unknown.body.transcript.length, 0);

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
