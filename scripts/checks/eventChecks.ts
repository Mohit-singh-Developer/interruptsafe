/**
 * Throwaway verification of the event log and transcript model.
 * Lives in the scratchpad, NOT the repo.
 */
const base = "../../packages/server/src/session";
const cs = (await import(`${base}/conversationState.ts`)) as any;
const ce = (await import(`${base}/conversationEvents.ts`)) as any;

const { ConversationStore } = cs;
const { ConversationEventLog } = ce;

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label}` +
      (ok ? "" : `\n        expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`),
  );
}

const limits = { maxConversations: 10, maxMessages: 100, maxEvents: 50 };

console.log("--- 1. transcript markers never reach provider history ---");
{
  const store = new ConversationStore(limits);
  const id = store.resolve("a");

  store.appendExchange(id, 1, "q1", "a1");
  store.markInterruption(id, 2);
  store.appendExchange(id, 3, "q2", "a2");

  check("transcript holds 3 entries", store.transcript(id).length, 3);
  check(
    "transcript kinds in order",
    store.transcript(id).map((e: any) => e.kind),
    ["exchange", "interruption", "exchange"],
  );

  const history = store.history(id);
  check("provider history holds only the 4 exchange messages", history.length, 4);
  check(
    "PROOF: no marker leaked into provider history",
    history.some((m: any) => m.role !== "user" && m.role !== "assistant"),
    false,
  );
  check(
    "history content is exactly the committed exchanges",
    history.map((m: any) => m.content),
    ["q1", "a1", "q2", "a2"],
  );
  check("history alternates starting with user", history[0]?.role, "user");
}

console.log("\n--- 2. a marker alone contributes nothing to provider history ---");
{
  const store = new ConversationStore(limits);
  const id = store.resolve("m");
  store.markInterruption(id, 1);
  check("transcript has the marker", store.transcript(id).length, 1);
  check("provider history is EMPTY", store.history(id).length, 0);
}

console.log("\n--- 3. event log is bounded ---");
{
  const log = new ConversationEventLog("x", 5);
  for (let i = 0; i < 20; i++) log.record("turn-started", `detail ${i}`, i);
  check("capped at 5", log.size(), 5);
  check(
    "oldest dropped, newest kept",
    log.list().map((e: any) => e.generation),
    [15, 16, 17, 18, 19],
  );
  check("chronological order preserved", log.list()[0]?.detail, "detail 15");
}

console.log("\n--- 4. events carry no secrets and have required shape ---");
{
  const log = new ConversationEventLog("conv-1", 10);
  const event = log.record("result-fenced", "Reply discarded.", 7);
  check("has an id", typeof event.id, "string");
  check("scoped to the conversation", event.conversationId, "conv-1");
  check("typed", event.type, "result-fenced");
  check("generation recorded", event.generation, 7);
  check("timestamp is ISO-8601", /^\d{4}-\d{2}-\d{2}T.*Z$/.test(event.at), true);
  const noGen = log.record("interruption-requested", "no generation");
  check("generation omitted when not applicable", "generation" in noGen, false);
}

console.log("\n--- 5. activity() is read-only: no creation, no LRU disturbance ---");
{
  const store = new ConversationStore({ maxConversations: 2, maxMessages: 100, maxEvents: 50 });
  const before = store.size();
  const empty = store.activity("never-seen-before");
  check("unknown id reads as generation 0", empty.currentGeneration, 0);
  check("unknown id reads as no events", empty.events.length, 0);
  check("unknown id reads as empty transcript", empty.transcript.length, 0);
  check("PROOF: reading did NOT create a conversation", store.size(), before);

  // LRU must not be disturbed by reads.
  store.resolve("first");
  store.resolve("second");
  store.activity("first"); // a read; must NOT protect "first" from eviction
  store.resolve("third"); // pushes over the cap of 2
  check("store capped at 2", store.size(), 2);
  check(
    "the read did not protect 'first' from eviction",
    store.activity("first").currentGeneration,
    0,
  );
}

console.log("\n--- 6. events and transcript are isolated and evicted per conversation ---");
{
  const store = new ConversationStore({ maxConversations: 2, maxMessages: 100, maxEvents: 50 });
  const a = store.resolve("A");
  const b = store.resolve("B");

  store.eventsFor(a).record("turn-started", "A only", 1);
  store.appendExchange(a, 1, "qa", "aa");
  store.markInterruption(a, 2);

  check("A has events", store.activity(a).events.length, 1);
  check("B has none", store.activity(b).events.length, 0);
  check("A has transcript entries", store.activity(a).transcript.length, 2);
  check("B transcript empty", store.activity(b).transcript.length, 0);

  // Touch B so that A becomes the least recently used, then overflow.
  store.resolve("B");
  store.resolve("C"); // evicts A
  check("A evicted: events gone", store.activity(a).events.length, 0);
  check("A evicted: transcript gone", store.activity(a).transcript.length, 0);
  check("A evicted: generation reset", store.activity(a).currentGeneration, 0);
  check("B survived", store.activity(b).currentGeneration, 0);
}

console.log("\n--- 7. a conversation that is only ever interrupted stays bounded ---");
{
  const store = new ConversationStore({ maxConversations: 5, maxMessages: 10, maxEvents: 50 });
  const id = store.resolve("floods");
  for (let i = 0; i < 500; i++) store.markInterruption(id, i);
  check("markers alone cannot grow without limit", store.transcript(id).length, 10);
  check("provider history remains empty", store.history(id).length, 0);
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
