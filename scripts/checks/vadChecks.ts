/**
 * Throwaway headless verification of the local voice activity detector.
 * Stubs the browser audio APIs so the VAD logic can be exercised in Node.
 * Scratchpad only, NOT committed.
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- Browser stubs -------------------------------------------------------

/** Controls what "loudness" the fake microphone is currently producing. */
const signal = { level: 0 };
let stoppedTracks = 0;
let getUserMediaMode: "grant" | "deny" | "missing-device" = "grant";
let closedContexts = 0;

class FakeAnalyser {
  fftSize = 512;
  getByteTimeDomainData(buffer: Uint8Array): void {
    // Write a square wave whose deviation from 128 encodes the level.
    const amplitude = Math.round(signal.level * 128);
    for (let i = 0; i < buffer.length; i += 1) {
      buffer[i] = 128 + (i % 2 === 0 ? amplitude : -amplitude);
    }
  }
}

class FakeAudioContext {
  state = "running";
  async resume(): Promise<void> {}
  async close(): Promise<void> {
    closedContexts += 1;
  }
  createMediaStreamSource() {
    return { connect() {}, disconnect() {} };
  }
  createAnalyser() {
    return new FakeAnalyser();
  }
}

Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
    mediaDevices: {
      async getUserMedia() {
        if (getUserMediaMode === "deny") {
          const error = new Error("denied");
          error.name = "NotAllowedError";
          throw error;
        }
        if (getUserMediaMode === "missing-device") {
          const error = new Error("no device");
          error.name = "NotFoundError";
          throw error;
        }
        return {
          getTracks: () => [
            {
              stop() {
                stoppedTracks += 1;
              },
            },
            {
              stop() {
                stoppedTracks += 1;
              },
            },
          ],
        };
      },
    },
  },
});
(globalThis as any).AudioContext = FakeAudioContext;

// ---- Subject under test --------------------------------------------------

const mod = (await import(
  "../../packages/web/src/audio/voiceActivityDetector.ts"
)) as any;
const { VoiceActivityDetector, VOICE_ACTIVITY_THRESHOLD } = mod;

const LOUD = VOICE_ACTIVITY_THRESHOLD * 2;
const QUIET = VOICE_ACTIVITY_THRESHOLD / 4;

console.log("--- permission and availability handling ---");
{
  getUserMediaMode = "deny";
  const d = new VoiceActivityDetector({ onSpeechStart() {}, onLoudChange() {} });
  check("permission denial reported as 'denied'", await d.start(), "denied");

  getUserMediaMode = "missing-device";
  check("missing device reported as 'unavailable'", await d.start(), "unavailable");

  getUserMediaMode = "grant";
  const ok = new VoiceActivityDetector({ onSpeechStart() {}, onLoudChange() {} });
  check("granted permission reports 'listening'", await ok.start(), "listening");
  ok.stop();
}

console.log("\n--- silence must never trigger ---");
{
  getUserMediaMode = "grant";
  let fired = 0;
  const d = new VoiceActivityDetector({
    onSpeechStart: () => (fired += 1),
    onLoudChange() {},
  });
  signal.level = QUIET;
  await d.start();
  await sleep(700);
  check("ambient silence fired nothing", fired, 0);
  d.stop();
}

console.log("\n--- a brief blip below the hold time must not trigger ---");
{
  let fired = 0;
  const d = new VoiceActivityDetector({
    onSpeechStart: () => (fired += 1),
    onLoudChange() {},
  });
  signal.level = QUIET;
  await d.start();
  signal.level = LOUD;
  await sleep(100); // shorter than VOICE_ACTIVITY_HOLD_MS (250)
  signal.level = QUIET;
  await sleep(300);
  check("a short blip did not trigger", fired, 0);
  d.stop();
}

console.log("\n--- sustained speech triggers exactly once ---");
{
  let fired = 0;
  const loudChanges: boolean[] = [];
  const d = new VoiceActivityDetector({
    onSpeechStart: () => (fired += 1),
    onLoudChange: (loud: boolean) => loudChanges.push(loud),
  });
  signal.level = QUIET;
  await d.start();

  signal.level = LOUD;
  await sleep(1200); // far longer than the hold time
  check("sustained speech fired once", fired, 1);
  check("loudness change was reported for the indicator", loudChanges.includes(true), true);

  // Keep talking: still must not fire again.
  await sleep(800);
  check("continuous talking did NOT fire repeatedly", fired, 1);

  console.log("\n--- re-arms only after sustained silence ---");
  signal.level = QUIET;
  await sleep(900); // longer than VOICE_ACTIVITY_RELEASE_MS (700)
  signal.level = LOUD;
  await sleep(600);
  check("a second episode after silence fired again", fired, 2);

  d.stop();
}

console.log("\n--- stop() releases every track and closes the context ---");
{
  stoppedTracks = 0;
  closedContexts = 0;
  const d = new VoiceActivityDetector({ onSpeechStart() {}, onLoudChange() {} });
  signal.level = LOUD;
  await d.start();
  d.stop();
  await sleep(50);
  check("both microphone tracks stopped", stoppedTracks, 2);
  check("audio context closed", closedContexts, 1);

  // After stopping, analysis must not continue.
  let firedAfterStop = 0;
  const d2 = new VoiceActivityDetector({
    onSpeechStart: () => (firedAfterStop += 1),
    onLoudChange() {},
  });
  await d2.start();
  d2.stop();
  signal.level = LOUD;
  await sleep(600);
  check("no events after stop", firedAfterStop, 0);
}

console.log("\n--- rearm() allows an immediate re-trigger ---");
{
  let fired = 0;
  const d = new VoiceActivityDetector({
    onSpeechStart: () => (fired += 1),
    onLoudChange() {},
  });
  signal.level = QUIET;
  await d.start();
  signal.level = LOUD;
  await sleep(500);
  check("fired once", fired, 1);
  d.rearm();
  await sleep(500);
  check("rearm allowed another trigger without silence", fired, 2);
  d.stop();
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
