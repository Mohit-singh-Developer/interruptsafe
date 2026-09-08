/**
 * Throwaway end-to-end verification against a running server.
 * Requires the server started with DEV_DETERMINISTIC_DELAY_MS set (e.g. 1500).
 * Lives in the scratchpad, NOT the repo.
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

// Confirm we are talking to a freshly started server, not an orphan.
const health = await (await fetch(`${BASE}/api/health`)).json();
console.log(`server uptime ${health.uptimeSeconds}s (must be small = fresh process)\n`);
check("talking to a freshly started server", health.uptimeSeconds < 60, true);

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

// 5/6. The fenced turn never entered history. If it had, the deterministic
// provider would report "Earlier user turns in this conversation: 1".
const fresh = await chat(A, "the NEW question");
check("new turn succeeded", fresh.status, 200);
check("status is ok", fresh.body.status, "ok");
check("generation is 3", fresh.body.generation, 3);
check(
  "PROOF: history has no earlier turns, so the fenced turn never committed",
  fresh.body.message.includes("Earlier user turns"),
  false,
);
check(
  "the reply is about the NEW question",
  fresh.body.message.includes("the NEW question"),
  true,
);

// 7. A second normal turn now does see one earlier turn, proving history works.
const third = await chat(A, "a third question");
check("third turn ok", third.status, 200);
check(
  "history now reports exactly ONE earlier turn (the new one, not the fenced one)",
  third.body.message.includes("Earlier user turns in this conversation: 1"),
  true,
);

// 8. Conversation B is untouched by any of it.
const bTurn = await chat(B, "unrelated");
check("B starts at generation 1", bTurn.body.generation, 1);
check("B has no earlier turns", bTurn.body.message.includes("Earlier user turns"), false);

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
