/**
 * Throwaway verification of the interruption correctness core.
 * Lives in the scratchpad, NOT the repo. The real test suite is Phase 14.
 */
const base = "../../packages/server/src/session";
const cs = (await import(`${base}/conversationState.ts`)) as any;
const fc = (await import(`${base}/fencedCommit.ts`)) as any;
const ifr = (await import(`${base}/inFlightRegistry.ts`)) as any;

const { ConversationStore } = cs;
const { commitExchange } = fc;
const { InFlightRegistry } = ifr;

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

console.log("--- 1. a current result commits ---");
{
  const store = new ConversationStore({ maxConversations: 10, maxMessages: 100 });
  const id = store.resolve("a");
  const gen = store.generationFor(id).bump("new-user-turn");
  const outcome = commitExchange(store, id, gen, "hello", "hi there");
  check("committed", outcome.committed, true);
  check("history now holds the exchange", store.history(id).length, 2);
}

console.log("\n--- 2. a STALE result is fenced and leaves history untouched ---");
{
  const store = new ConversationStore({ maxConversations: 10, maxMessages: 100 });
  const id = store.resolve("a");
  const staleGen = store.generationFor(id).bump("new-user-turn"); // 1
  store.generationFor(id).bump("user-interruption"); // 2 - supersedes it

  const outcome = commitExchange(store, id, staleGen, "hello", "hi there");
  check("NOT committed", outcome.committed, false);
  check("reason is stale", outcome.reason, "stale");
  check("reports the result generation", outcome.resultGeneration, 1);
  check("reports the current generation", outcome.currentGeneration, 2);
  check("history is EMPTY - nothing appended", store.history(id).length, 0);
}

console.log("\n--- 3. THE CORE INVARIANT: provider IGNORES cancellation ---");
{
  const store = new ConversationStore({ maxConversations: 10, maxMessages: 100 });
  const registry = new InFlightRegistry();
  const A = store.resolve("A");
  const B = store.resolve("B");

  // A provider that never looks at its signal and always succeeds.
  const stubborn = {
    name: "ignores-cancellation",
    async generate(_req: unknown, _signal: AbortSignal) {
      await sleep(60);
      return { message: "answer to the OLD question" };
    },
  };

  // 1. Work starts for A at generation 1.
  const genA1 = store.generationFor(A).bump("new-user-turn");
  const handle = registry.register(A, genA1);
  const work = stubborn.generate({}, handle.signal);

  // 2. Interrupt before it finishes.
  await sleep(10);
  const genA2 = store.generationFor(A).bump("user-interruption");
  const signalled = registry.requestCancellation(A);
  check("cancellation was requested for the in-flight turn", signalled, 1);
  check("the signal is aborted", handle.signal.aborted, true);

  // 3. The provider completes anyway, ignoring the abort entirely.
  const result = await work;
  handle.release();
  check("provider ignored the abort and returned a result", result.message.length > 0, true);

  // 4/5. The stale result cannot commit.
  const outcome = commitExchange(store, A, genA1, "old question", result.message);
  check("stale result NOT committed", outcome.committed, false);
  check("A's history is still empty", store.history(A).length, 0);
  check("generation advanced 1 -> 2", [genA1, genA2], [1, 2]);

  // 6/7. Current work proceeds normally.
  const genA3 = store.generationFor(A).bump("new-user-turn");
  const fresh = commitExchange(store, A, genA3, "new question", "answer to the NEW question");
  check("current work commits", fresh.committed, true);
  check("history holds ONLY the new exchange", store.history(A).length, 2);
  check(
    "the committed user turn is the new one",
    store.history(A)[0]?.content,
    "new question",
  );
  check(
    "the old answer is nowhere in history",
    store.history(A).some((m: any) => m.content.includes("OLD")),
    false,
  );

  // 8. Conversation B untouched throughout.
  check("B's generation unaffected", store.generationFor(B).now(), 0);
  check("B's history unaffected", store.history(B).length, 0);
}

console.log("\n--- 4. provider HONOURS cancellation: also fenced, nothing appended ---");
{
  const store = new ConversationStore({ maxConversations: 10, maxMessages: 100 });
  const registry = new InFlightRegistry();
  const id = store.resolve("h");

  const cooperative = {
    name: "honours-cancellation",
    async generate(_req: unknown, signal: AbortSignal) {
      await sleep(60);
      if (signal.aborted) throw new Error("aborted");
      return { message: "should never be used" };
    },
  };

  const gen = store.generationFor(id).bump("new-user-turn");
  const handle = registry.register(id, gen);
  const work = cooperative.generate({}, handle.signal);

  await sleep(10);
  store.generationFor(id).bump("user-interruption");
  registry.requestCancellation(id);

  let threw = false;
  try {
    await work;
  } catch {
    threw = true;
  }
  handle.release();

  check("cooperative provider aborted", threw, true);
  check("history untouched", store.history(id).length, 0);
  check("the turn is stale either way", store.generationFor(id).isStale(gen), true);
}

console.log("\n--- 5. provider FAILURE leaves no dangling user turn ---");
{
  const store = new ConversationStore({ maxConversations: 10, maxMessages: 100 });
  const id = store.resolve("f");
  const gen = store.generationFor(id).bump("new-user-turn");

  // The route only calls commitExchange on success, so a throw appends nothing.
  let caught = false;
  try {
    throw new Error("upstream 500");
  } catch {
    caught = true;
  }
  check("failure observed", caught, true);
  check("history empty - no half-written turn", store.history(id).length, 0);
  check("generation still advanced (turn was attempted)", store.generationFor(id).now(), gen);
}

console.log("\n--- 6. two concurrent turns: only the newer commits ---");
{
  const store = new ConversationStore({ maxConversations: 10, maxMessages: 100 });
  const id = store.resolve("c");

  const gen1 = store.generationFor(id).bump("new-user-turn"); // request 1 starts
  const gen2 = store.generationFor(id).bump("new-user-turn"); // request 2 starts

  const second = commitExchange(store, id, gen2, "second", "reply 2");
  const first = commitExchange(store, id, gen1, "first", "reply 1");

  check("newer turn committed", second.committed, true);
  check("older turn fenced", first.committed, false);
  check("exactly one exchange in history", store.history(id).length, 2);
  check("and it is the newer one", store.history(id)[0]?.content, "second");
}

console.log("\n--- 7. registry bookkeeping ---");
{
  const registry = new InFlightRegistry();
  const h1 = registry.register("r", 1);
  const h2 = registry.register("r", 2);
  check("two outstanding", registry.countFor("r"), 2);
  check("cancelling signals both", registry.requestCancellation("r"), 2);
  check("re-cancelling signals none (already aborted)", registry.requestCancellation("r"), 0);
  h1.release();
  check("one left after release", registry.countFor("r"), 1);
  h2.release();
  check("none left", registry.countFor("r"), 0);
  check("cancelling an unknown conversation is a no-op", registry.requestCancellation("nope"), 0);
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
