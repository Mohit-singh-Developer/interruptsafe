/**
 * Throwaway headless verification of the clause chunker and the
 * generation-stamped playback queue. Scratchpad only, NOT committed.
 */
let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label}` +
      (ok ? "" : `\n        expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`),
  );
}
const tick = () => new Promise((r) => setTimeout(r, 5));

// ---- Browser stubs -------------------------------------------------------

/** Every Audio the queue creates, so the test can end or inspect them. */
const created: StubAudio[] = [];
let revoked = 0;
let playRejectsWith: string | null = null;

class StubAudio {
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  paused = false;
  readonly src: string;

  constructor(src: string) {
    this.src = src;
    created.push(this);
  }
  async play(): Promise<void> {
    if (playRejectsWith !== null) {
      const error = new Error("blocked");
      error.name = playRejectsWith;
      throw error;
    }
  }
  pause(): void {
    this.paused = true;
  }
  /** Test helper: simulate the clip finishing. */
  end(): void {
    this.onended?.();
  }
}

(globalThis as any).Audio = StubAudio;
(globalThis as any).URL.createObjectURL = (blob: unknown) => `blob:stub/${created.length}`;
(globalThis as any).URL.revokeObjectURL = () => {
  revoked += 1;
};

const base = "../../packages/web/src/audio";
const { splitIntoClauses } = (await import(`${base}/clauseChunker.ts`)) as any;
const { AssistantSpeechQueue } = (await import(`${base}/assistantAudio.ts`)) as any;

const blob = (name: string) => ({ name }) as unknown as Blob;

console.log("--- clause chunker ---");
{
  check("empty text yields no clauses", splitIntoClauses("   "), []);
  check(
    "sentences are split",
    splitIntoClauses("One thing here. Two things there! Three?"),
    ["One thing here.", "Two things there!", "Three?"],
  );
  check("a single short sentence stays whole", splitIntoClauses("Hello there."), [
    "Hello there.",
  ]);

  const long = `${"word ".repeat(80)}end.`;
  const pieces = splitIntoClauses(long);
  check("an over-long sentence is split", pieces.length > 1, true);
  check(
    "no clause exceeds the cap",
    pieces.every((p: string) => p.length <= 150),
    true,
  );
  check(
    "splitting loses no words",
    pieces.join(" ").split(/\s+/).filter(Boolean).length,
    long.split(/\s+/).filter(Boolean).length,
  );

  // A realistic mock-tool reply.
  const reply =
    '3 mock flights from Delhi to Mumbai. (MOCK DATA from searchFlights - synthetic, not real information.)\n- IS486 Delhi to Mumbai departs 08:00\n- IS499 Delhi to Mumbai departs 15:00';
  const replyClauses = splitIntoClauses(reply);
  check("a tool reply chunks into several clauses", replyClauses.length >= 3, true);
  check("first clause is short enough to synthesise quickly", replyClauses[0].length <= 150, true);
}

console.log("\n--- playback queue: generation stamping ---");
{
  created.length = 0;
  const started: number[] = [];
  let idle = 0;
  const q = new AssistantSpeechQueue({
    onPlaybackStarted: (g: number) => started.push(g),
    onIdle: () => (idle += 1),
  });

  check("a clip for an unset generation is refused", q.enqueue(1, blob("a")), false);

  q.setGeneration(1);
  check("a clip matching the generation is accepted", q.enqueue(1, blob("a")), true);
  await tick();
  check("it started playing", created.length, 1);
  check("playback-started reported once with the generation", started, [1]);

  check("a clip from a DIFFERENT generation is refused", q.enqueue(2, blob("wrong")), false);
  check("and it never became audio", created.length, 1);
}

console.log("\n--- playback queue: advancing generation makes old audio inaudible ---");
{
  created.length = 0;
  revoked = 0;
  const q = new AssistantSpeechQueue({ onPlaybackStarted: () => {}, onIdle: () => {} });

  q.setGeneration(1);
  q.enqueue(1, blob("g1-a"));
  await tick();
  q.enqueue(1, blob("g1-b"));
  q.enqueue(1, blob("g1-c"));

  const playing = created[0];
  check("first clip is playing", created.length, 1);
  check("two more are queued behind it", q.isPlaying, true);

  // The user interrupts: generation advances.
  const dropped = q.setGeneration(2);
  check("advancing dropped the QUEUED clips", dropped, 2);
  check("the playing clip was paused", playing.paused, true);
  check("nothing is playing now", q.isPlaying, false);
  check("its object URL was revoked", revoked > 0, true);

  // Even if the old clip's 'ended' fires late, it must not resurrect the queue.
  playing.end();
  await tick();
  check("a late 'ended' from the old clip started nothing", created.length, 1);

  // Generation 2 audio plays normally.
  q.enqueue(2, blob("g2-a"));
  await tick();
  check("new-generation audio plays", created.length, 2);
  check("and it is the new clip", (created[1] as any).src !== (created[0] as any).src, true);
}

console.log("\n--- playback queue: flush() during playback ---");
{
  created.length = 0;
  const q = new AssistantSpeechQueue({ onPlaybackStarted: () => {}, onIdle: () => {} });
  q.setGeneration(5);
  q.enqueue(5, blob("x"));
  await tick();
  q.enqueue(5, blob("y"));
  q.enqueue(5, blob("z"));

  check("flush reports how many queued clips it discarded", q.flush(), 2);
  check("playback stopped", q.isPlaying, false);
  await tick();
  check("no further clips started", created.length, 1);
}

console.log("\n--- playback queue: autoplay refusal is reported, not silent ---");
{
  created.length = 0;
  playRejectsWith = "NotAllowedError";
  const q = new AssistantSpeechQueue({ onPlaybackStarted: () => {}, onIdle: () => {} });
  q.setGeneration(1);
  q.enqueue(1, blob("blocked"));
  await tick();
  check("autoplay block is surfaced", q.autoplayBlocked, true);
  check("nothing is left playing", q.isPlaying, false);
  playRejectsWith = null;
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
