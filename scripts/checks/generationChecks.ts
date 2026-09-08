/**
 * Throwaway verification of GenerationManager behaviour.
 * Lives in the scratchpad, NOT the repo. The real test suite is Phase 14.
 */
const base = "../../packages/server/src/session";
const gm = (await import(`${base}/generationManager.ts`)) as any;
const cs = (await import(`${base}/conversationState.ts`)) as any;

const { GenerationManager, INITIAL_GENERATION } = gm;
const { ConversationStore, isValidConversationId } = cs;

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label}` +
      (ok ? "" : `\n        expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`),
  );
}

console.log("--- 1. a fresh manager starts in a known state ---");
{
  const g = new GenerationManager();
  check("initial generation is INITIAL_GENERATION", g.now(), INITIAL_GENERATION);
  check("INITIAL_GENERATION is 0", INITIAL_GENERATION, 0);
  check("no bump reason recorded yet", g.lastBumpReason(), null);
  check("the initial value is its own current", g.isCurrent(INITIAL_GENERATION), true);
}

console.log("\n--- 2. advancing produces a new current, and the old one goes stale ---");
{
  const g = new GenerationManager();
  const first = g.bump("new-user-turn");
  check("first bump yields 1", first, 1);
  check("bump reason recorded", g.lastBumpReason(), "new-user-turn");
  check("CURRENT is recognised as current", g.isCurrent(first), true);
  check("CURRENT is not stale", g.isStale(first), false);
  check("the pre-bump value is now stale", g.isStale(0), true);

  const second = g.bump("user-interruption");
  check("second bump yields 2", second, 2);
  check("reason updated", g.lastBumpReason(), "user-interruption");
  check("PREVIOUSLY-current stamp is now STALE", g.isStale(first), true);
  check("previously-current stamp is not current", g.isCurrent(first), false);
  check("new stamp is current", g.isCurrent(second), true);
  check("a value ahead of current is treated as stale", g.isStale(999), true);
}

console.log("\n--- 3. monotonic across many advances ---");
{
  const g = new GenerationManager();
  const seen: number[] = [];
  for (let i = 0; i < 5; i++) seen.push(g.bump("new-user-turn"));
  check("strictly increasing", seen, [1, 2, 3, 4, 5]);
  check("only the newest is current", seen.filter((s) => g.isCurrent(s)), [5]);
  check("all earlier stamps are stale", seen.slice(0, 4).every((s) => g.isStale(s)), true);
}

console.log("\n--- 4. a new conversation receives generation state ---");
{
  const store = new ConversationStore({ maxConversations: 10, maxMessages: 10 });
  const id = store.resolve("conv-a");
  check("brand-new conversation starts at 0", store.generationFor(id).now(), 0);
  check("its manager is a real GenerationManager", store.generationFor(id) instanceof GenerationManager, true);
  check("repeated access returns the SAME instance", store.generationFor(id) === store.generationFor(id), true);
}

console.log("\n--- 5. isolation: advancing one conversation does not affect another ---");
{
  const store = new ConversationStore({ maxConversations: 10, maxMessages: 10 });
  const a = store.resolve("conv-a");
  const b = store.resolve("conv-b");

  const aGen1 = store.generationFor(a).bump("new-user-turn");
  const aGen2 = store.generationFor(a).bump("new-user-turn");
  const aGen3 = store.generationFor(a).bump("new-user-turn");

  check("A advanced to 3", store.generationFor(a).now(), 3);
  check("B is UNAFFECTED, still 0", store.generationFor(b).now(), 0);

  const bGen1 = store.generationFor(b).bump("new-user-turn");
  check("B's first bump is 1, not 4", bGen1, 1);
  check("A unchanged by B's bump", store.generationFor(a).now(), 3);

  check("A's old stamp is stale in A", store.generationFor(a).isStale(aGen1), true);
  check("A's current stamp is current in A", store.generationFor(a).isCurrent(aGen3), true);
  check("B judges its own stamp current", store.generationFor(b).isCurrent(bGen1), true);
  check("A's stamp 2 is stale in A", store.generationFor(a).isStale(aGen2), true);
}

console.log("\n--- 6. generation state is evicted with its conversation (no leak) ---");
{
  const store = new ConversationStore({ maxConversations: 2, maxMessages: 10 });
  store.resolve("x");
  store.generationFor("x").bump("new-user-turn");
  store.generationFor("x").bump("new-user-turn");
  check("x advanced to 2", store.generationFor("x").now(), 2);

  store.resolve("y");
  store.resolve("z"); // evicts the least recently used
  check("store still capped at 2", store.size(), 2);
  check("evicted id starts fresh at 0, not resurrected at 2", store.generationFor("x").now(), 0);
}

console.log("\n--- 7. conversation id handling stays consistent with existing behaviour ---");
{
  const store = new ConversationStore({ maxConversations: 10, maxMessages: 10 });
  check("valid id accepted", isValidConversationId("abc_DEF-123"), true);
  check("id with space rejected", isValidConversationId("has space"), false);
  check("empty id rejected", isValidConversationId(""), false);

  // resolve() ignores an unusable id and allocates a fresh uuid instead.
  const generated = store.resolve("has space");
  check("unusable id is replaced by a generated uuid", generated.length, 36);
  check("the generated conversation starts at generation 0", store.generationFor(generated).now(), 0);
  check("the rejected string was not used as a key", store.generationFor("has space").now(), 0);

  const undefinedId = store.resolve(undefined);
  check("omitted id also yields a uuid", undefinedId.length, 36);
  check("and its own independent generation", store.generationFor(undefinedId).now(), 0);
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
