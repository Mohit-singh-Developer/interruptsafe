/**
 * Throwaway verification of ConversationStore limit behaviour.
 * Lives in the scratchpad, not the repo. The real test suite is Phase 14.
 */
const mod = await import(
  "../../packages/server/src/session/conversationState.ts"
);
const { ConversationStore, isValidConversationId } = mod as {
  ConversationStore: new (limits: {
    maxConversations: number;
    maxMessages: number;
  }) => {
    resolve(id?: string): string;
    history(id: string): readonly { role: string; content: string }[];
    appendExchange(id: string, u: string, a: string): void;
    size(): number;
  };
  isValidConversationId: (v: string) => boolean;
};

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label}\n        expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`,
  );
}

console.log("--- LRU eviction (maxConversations = 3) ---");
{
  const store = new ConversationStore({ maxConversations: 3, maxMessages: 100 });
  for (const id of ["a", "b", "c"]) {
    store.resolve(id);
    store.appendExchange(id, 1, `u-${id}`, `a-${id}`);
  }
  check("three conversations held", store.size(), 3);

  store.resolve("d"); // pushes over the limit
  check("still capped at 3 after a 4th", store.size(), 3);
  check("oldest ('a') was evicted", store.history("a").length, 0);
  check("'b' survived", store.history("b").length, 2);
  check("'d' exists", store.history("d").length, 0);
}

console.log("\n--- LRU ordering: recent access protects a conversation ---");
{
  const store = new ConversationStore({ maxConversations: 3, maxMessages: 100 });
  for (const id of ["a", "b", "c"]) {
    store.resolve(id);
    store.appendExchange(id, 1, `u-${id}`, `a-${id}`);
  }
  store.resolve("a"); // touch 'a' so 'b' becomes least recently used
  store.resolve("d");
  check("'a' survived because it was touched", store.history("a").length, 2);
  check("'b' was evicted instead", store.history("b").length, 0);
}

console.log("\n--- message trimming (maxMessages = 4) ---");
{
  const store = new ConversationStore({ maxConversations: 10, maxMessages: 4 });
  const id = store.resolve("trim");
  store.appendExchange(id, 1, "u1", "a1");
  store.appendExchange(id, 1, "u2", "a2");
  check("at the cap after two exchanges", store.history(id).length, 4);

  store.appendExchange(id, 1, "u3", "a3");
  check("still capped after a third", store.history(id).length, 4);
  check(
    "oldest exchange dropped, newest kept",
    store.history(id).map((m) => m.content),
    ["u2", "a2", "u3", "a3"],
  );
  check("history starts with a user turn", store.history(id)[0]?.role, "user");
}

console.log("\n--- odd cap must not leave history starting with an assistant ---");
{
  const store = new ConversationStore({ maxConversations: 10, maxMessages: 5 });
  const id = store.resolve("odd");
  store.appendExchange(id, 1, "u1", "a1");
  store.appendExchange(id, 1, "u2", "a2");
  store.appendExchange(id, 1, "u3", "a3");
  const roles = store.history(id).map((m) => m.role);
  check("leading assistant turn was dropped", roles[0], "user");
  check("length reduced below the cap by that drop", store.history(id).length, 4);
}

console.log("\n--- unknown id and id validation ---");
{
  const store = new ConversationStore({ maxConversations: 10, maxMessages: 10 });
  check("unknown id yields empty history", store.history("never-seen").length, 0);
  check("blank requested id gets a generated uuid", store.resolve().length, 36);
  check("valid id accepted", isValidConversationId("abc_DEF-123"), true);
  check("space rejected", isValidConversationId("has space"), false);
  check("empty rejected", isValidConversationId(""), false);
  check("101 chars rejected", isValidConversationId("a".repeat(101)), false);
  check("100 chars accepted", isValidConversationId("a".repeat(100)), true);
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
