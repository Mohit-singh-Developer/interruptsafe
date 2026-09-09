/**
 * End-to-end verification of text-path interruption against a running server.
 *
 * REQUIRES the server started with DEV_DETERMINISTIC_DELAY_MS set (e.g. 1500).
 * Without it the mock replies instantly, there is no window in which to
 * interrupt, and every check in the core scenario fails for the wrong reason:
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

/**
 * Reads the server's transcript.
 *
 * Fencing is proved from this rather than from the reply text. Asserting on a
 * provider's wording ties a correctness proof to whichever provider happens to
 * be configured - switch to a real model and the proof evaporates. The
 * transcript is what the conversation actually contains, so it holds for any
 * provider.
 */
async function activity(conversationId: string) {
  const res = await fetch(
    `${BASE}/api/conversations/${encodeURIComponent(conversationId)}/activity`,
  );
  return { status: res.status, body: (await res.json()) as any };
}

/** The committed exchanges only, ignoring interruption markers. */
function exchanges(body: any): Array<{ user: string; assistant: string; generation: number }> {
  return (body.transcript ?? []).filter((entry: any) => entry.kind === "exchange");
}

async function interrupt(conversationId: string) {
  const res = await fetch(`${BASE}/api/interrupt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

// Reported for context, not asserted on. Every conversation id below is unique
// to this run, so a long-lived server cannot affect the outcome - requiring a
// young process only made the suite fail for anyone who read the instructions
// before running it.
const health = await (await fetch(`${BASE}/api/health`)).json();
console.log(
  `server uptime ${health.uptimeSeconds}s, speech provider ${health.speech?.provider}\n`,
);

const A = `A-${Date.now()}`;
const B = `B-${Date.now()}`;

console.log("\n--- THE CORE SCENARIO over HTTP ---");

// 1. Start work for A. Do not await yet - it is now in flight at generation 1.
const inFlight = chat(A, "the OLD question");
await sleep(300);

// 2. Interrupt before it completes.
const interrupted = await interrupt(A);
check("interrupt returned 200", interrupted.status, 200);
check("generation advanced to 2", interrupted.body.generation, 2);
check(
  "cancellation was requested for the in-flight turn",
  interrupted.body.cancellationRequested,
  1,
);

// 3/4. The old work completes anyway (the mock ignores its signal) and is fenced.
const old = await inFlight;
check("old turn answered with 409, not 200", old.status, 409);
check("status is superseded", old.body.status, "superseded");
check("result generation was 1", old.body.resultGeneration, 1);
check("current generation is 2", old.body.currentGeneration, 2);
check("no message field - it is not an active result", old.body.message, undefined);

// 5/6. The fenced turn never entered history. Proved from the transcript the
// server actually holds, not from anything the provider said.
const fresh = await chat(A, "the NEW question");
check("new turn succeeded", fresh.status, 200);
check("status is ok", fresh.body.status, "ok");
check("generation is 3", fresh.body.generation, 3);

const afterFresh = exchanges((await activity(A)).body);
check("PROOF: exactly one committed exchange, not two", afterFresh.length, 1);
check(
  "PROOF: and it is the NEW question, not the fenced one",
  afterFresh[0]?.user,
  "the NEW question",
);
check(
  "PROOF: the fenced question appears nowhere in the transcript",
  JSON.stringify(afterFresh).includes("the OLD question"),
  false,
);

// 7. A second normal turn appends, proving history accumulates normally.
const third = await chat(A, "a third question");
check("third turn ok", third.status, 200);

const afterThird = exchanges((await activity(A)).body);
check("history now holds exactly TWO exchanges", afterThird.length, 2);
check("the fenced turn is still absent", JSON.stringify(afterThird).includes("the OLD question"), false);

// 8. Conversation B is untouched by any of it.
const bTurn = await chat(B, "unrelated");
check("B starts at generation 1", bTurn.body.generation, 1);
check("B has exactly one exchange of its own", exchanges((await activity(B)).body).length, 1);

console.log("\n--- interrupt validation ---");
const badInterrupt = await fetch(`${BASE}/api/interrupt`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({}),
});
check("interrupt without conversationId is rejected", badInterrupt.status, 400);

const badId = await fetch(`${BASE}/api/interrupt`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ conversationId: "has space" }),
});
check("interrupt with a malformed id is rejected", badId.status, 400);

console.log("\n--- interrupting with nothing in flight still advances ---");
const idle = await interrupt(B);
check("still 200", idle.status, 200);
check("generation advanced anyway", idle.body.generation, 2);
check("no cancellations requested", idle.body.cancellationRequested, 0);

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
