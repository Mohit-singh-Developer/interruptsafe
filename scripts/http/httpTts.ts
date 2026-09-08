/**
 * Throwaway end-to-end verification of the optional TTS endpoint.
 * argv[2] = "unconfigured" | "fakekey". Scratchpad only, NOT committed.
 */
const BASE = "http://127.0.0.1:8787";
const MODE = (process.argv[2] ?? "unconfigured") as "unconfigured" | "fakekey";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label}` +
      (ok ? "" : `\n        expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`),
  );
}

async function tts(body: unknown) {
  const res = await fetch(`${BASE}/api/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const type = res.headers.get("content-type") ?? "";
  return {
    status: res.status,
    contentType: type,
    body: type.includes("json") ? ((await res.json()) as any) : null,
  };
}

console.log(`### MODE: ${MODE} ###\n`);

const health = (await (await fetch(`${BASE}/api/health`)).json()) as any;

if (MODE === "unconfigured") {
  console.log("--- with NO Rime credential (the zero-cost default) ---");
  check("health reports ttsAvailable false", health.ttsAvailable, false);
  check("active speech provider is observable as 'none'", health.speech.provider, "none");
  check("no phase field leaks back in", "phase" in health, false);

  const result = await tts({ text: "hello" });
  check("POST /api/tts returns 503", result.status, 503);
  check("error is the project's { error } shape", typeof result.body.error, "string");
  check(
    "error explains how to enable it",
    result.body.error.includes("RIME_API_KEY"),
    true,
  );

  console.log("\n--- everything else must be unaffected ---");
  const chat = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "Hello", conversationId: "tts-none" }),
  });
  const chatBody = (await chat.json()) as any;
  check("text chat still returns 200", chat.status, 200);
  check("chat committed normally", chatBody.status, "ok");

  const tool = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: "Find flights from Delhi to Mumbai",
      conversationId: "tts-none",
    }),
  });
  const toolBody = (await tool.json()) as any;
  check("mock tool still works", toolBody.message.includes("MOCK DATA"), true);

  const interrupted = await fetch(`${BASE}/api/interrupt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId: "tts-none" }),
  });
  check("interrupt still works", interrupted.status, 200);
} else {
  console.log("--- with a DELIBERATELY INVALID Rime key ---");
  console.log("    (proves wiring and validation; NOT a successful synthesis)");
  check("health reports ttsAvailable true", health.ttsAvailable, true);

  console.log("\n--- the active provider and its exact config are observable ---");
  check("provider is rime", health.speech.provider, "rime");
  check("model is reported", health.speech.model, "mistv3");
  check("speaker is reported", health.speech.speaker, "luna");
  check("language is reported", health.speech.language, "eng");
  check("audio format is reported", health.speech.audioFormat, "audio/wav");
  check("endpoint is reported", health.speech.endpoint, "https://users.rime.ai/v1/rime-tts");
  check(
    "no credential is exposed in health",
    JSON.stringify(health).toLowerCase().includes("invalid-key"),
    false,
  );

  console.log("\n--- generation fencing SKIPS synthesis for a superseded turn ---");
  console.log("    (this saves Rime credits and needs no valid key to prove)");
  {
    const conv = `tts-fence-${Date.now()}`;
    const chat = await fetch(`${BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Hello", conversationId: conv }),
    });
    const chatBody = (await chat.json()) as any;
    const staleGeneration = chatBody.generation;

    // The user interrupts, so that generation is now stale.
    await fetch(`${BASE}/api/interrupt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: conv }),
    });

    const stale = await tts({
      text: "This should never be synthesised.",
      conversationId: conv,
      generation: staleGeneration,
    });
    check("stale synthesis request returns 409", stale.status, 409);
    check("marked superseded", stale.body.status, "superseded");
    check("reports the stale generation", stale.body.resultGeneration, staleGeneration);
    check("reports the current generation", stale.body.currentGeneration, staleGeneration + 1);

    const activity = (await (
      await fetch(`${BASE}/api/conversations/${conv}/activity`)
    ).json()) as any;
    check(
      "a tts-fenced event was recorded",
      activity.events.some((e: any) => e.type === "tts-fenced"),
      true,
    );
    check(
      "and NO tts-started event - Rime was never called",
      activity.events.some((e: any) => e.type === "tts-started"),
      false,
    );
  }

  console.log("\n--- input validation runs before anything is sent upstream ---");
  check("missing text -> 400", (await tts({})).status, 400);
  check("empty text -> 400", (await tts({ text: "" })).status, 400);
  check("whitespace only -> 400", (await tts({ text: "   " })).status, 400);
  check("wrong type -> 400", (await tts({ text: 123 })).status, 400);
  check("array body -> 400", (await tts([1, 2])).status, 400);
  check("over length -> 400", (await tts({ text: "a".repeat(1201) })).status, 400);
  check("at the limit is accepted for validation", (await tts({ text: "a".repeat(1200) })).status !== 400, true);

  console.log("\n--- a real upstream call is attempted and fails auth ---");
  const real = await tts({ text: "hello" });
  check("invalid key surfaces as 502, not a crash", real.status, 502);
  check("error message is generic", real.body.error, "Speech synthesis failed.");
  check(
    "no credential echoed in the error",
    JSON.stringify(real.body).toLowerCase().includes("bearer"),
    false,
  );

  console.log("\n--- text path still unaffected by TTS failure ---");
  const chat = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "Hello", conversationId: "tts-fake" }),
  });
  check("chat unaffected", chat.status, 200);
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
