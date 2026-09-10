import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareForSpeech } from "../packages/shared/src/speechText";
import { createRimeClient } from "../packages/server/src/tts/rimeClient";

/**
 * Audio quality checks on real Rime output.
 *
 *   npm run audio:qa
 *
 * ## What this can and cannot tell you
 *
 * It cannot tell you the speech sounds *good*. Intelligibility, voice
 * suitability and whether the pacing feels natural are judgements only a
 * listener can make, and no measurement here substitutes for putting on
 * headphones - see docs/RIME_EVIDENCE.md section 8.1.
 *
 * What it can do is rule out the specific defects that make synthesised speech
 * sound wrong, each of which is visible in the waveform:
 *
 *   - clipping        distortion from samples pinned at full scale
 *   - truncation      a clip that ends mid-word because the tail was cut
 *   - dropouts        a long silence in the middle of a phrase
 *   - dead air        an excessive pause before speech begins
 *   - pacing          a speech rate far outside the natural range
 *
 * So a pass here means "no mechanical defect detected", not "this sounds
 * right". Both statements are in the evidence document, kept apart on purpose.
 *
 * It exercises the SHIPPED path: the same `RimeClient` the server uses, and the
 * same `prepareForSpeech` applied before synthesis, so what is measured is what
 * a listener would actually hear.
 *
 * Each line costs one real Rime request. The credential is never printed.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Pacing band, in estimated spoken units per minute.
 *
 * Deliberately wide, and deliberately not a word count. A naive words-per-minute
 * figure is meaningless on this vocabulary: "IS486" is one word but five spoken
 * units, and "3586" is one word but several. Measured against raw words, the
 * flight-code line reads as 80 wpm and a short phrase as 240 - both artefacts of
 * the metric rather than anything audible.
 *
 * So digits are expanded (see `spokenUnits`) and the band only catches gross
 * anomalies: speech so slow it has stalled, or so fast it has been mangled.
 * Anything inside it is reported, not judged - pacing that is merely *unpleasant*
 * is a listening question, and this file does not pretend to answer those.
 */
const PACE_MIN = 90;
const PACE_MAX = 300;

/** Below this much actual speech, instantaneous rate is too noisy to judge. */
const MIN_SPEECH_MS_FOR_PACE = 1500;

/** A sample within this fraction of full scale counts as clipped. */
const CLIP_CEILING = 0.995;
/** Clipped samples above this share of the clip indicate audible distortion. */
const MAX_CLIPPED_SHARE = 0.001;

/** Amplitude below this fraction of peak is treated as silence. */
const SILENCE_FLOOR = 0.02;
/** A gap longer than this inside a clip suggests a dropout. */
const MAX_INTERNAL_SILENCE_MS = 800;
/** Less trailing silence than this suggests the tail was cut off. */
const MIN_TRAILING_SILENCE_MS = 20;
/** More leading silence than this is dead air before the voice starts. */
const MAX_LEADING_SILENCE_MS = 700;

/**
 * The lines the demo actually speaks, plus the two that exercise pronunciation:
 * a flight code and a rupee amount are the hardest things in this vocabulary.
 */
const LINES: readonly string[] = [
  "3 mock hotels in Jaipur.",
  "Harbour View, Jaipur  4 star  approx INR 2539/night",
  "IS486  Delhi -> Mumbai  departs 08:00  approx INR 3586",
  "Which two cities are you flying between?",
  "I only handle hotels, flights and weather on this route, so I cannot answer that one.",
];

/**
 * Estimates how many units a synthesiser will actually speak.
 *
 * A token containing digits is enunciated character by character or expanded
 * into number words, so it costs far more time than one word: "IS486" is five
 * spoken units, not one. Counting raw words makes such a line look impossibly
 * slow and a plain phrase look impossibly fast.
 *
 * This is an estimate, not a phonemiser. It exists only to keep the pacing
 * check honest enough to catch a stall or a garble.
 */
function spokenUnits(text: string): number {
  let units = 0;
  for (const token of text.split(/\s+/).filter(Boolean)) {
    const alnum = token.replace(/[^a-z0-9]/gi, "");
    units += /[0-9]/.test(alnum) ? Math.max(alnum.length, 1) : 1;
  }
  return units;
}

interface Wave {
  readonly sampleRate: number;
  readonly channels: number;
  readonly bitsPerSample: number;
  readonly samples: Int16Array;
}

/**
 * Parses a RIFF/WAVE container by walking its chunks.
 *
 * The header is not assumed to be a fixed 44 bytes: encoders are free to insert
 * chunks such as LIST before the data, and skipping a fixed offset would then
 * read metadata as audio and report confident nonsense.
 */
function parseWave(bytes: Uint8Array): Wave {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number): string =>
    String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);

  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") {
    throw new Error(`not a RIFF/WAVE file (starts with "${tag(0)}")`);
  }

  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataStart = -1;
  let dataLength = 0;

  let cursor = 12;
  while (cursor + 8 <= bytes.byteLength) {
    const id = tag(cursor);
    const size = view.getUint32(cursor + 4, true);
    const body = cursor + 8;

    if (id === "fmt ") {
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
    } else if (id === "data") {
      dataStart = body;
      dataLength = Math.min(size, bytes.byteLength - body);
    }

    // Chunks are word-aligned: an odd size is followed by a pad byte.
    cursor = body + size + (size % 2);
  }

  if (dataStart < 0) throw new Error("no data chunk found");
  if (bitsPerSample !== 16) throw new Error(`expected 16-bit PCM, got ${bitsPerSample}-bit`);

  const count = Math.floor(dataLength / 2);
  const samples = new Int16Array(count);
  for (let i = 0; i < count; i += 1) {
    samples[i] = view.getInt16(dataStart + i * 2, true);
  }

  return { sampleRate, channels, bitsPerSample, samples };
}

interface Analysis {
  readonly durationMs: number;
  readonly peak: number;
  readonly rms: number;
  readonly clippedShare: number;
  readonly leadingSilenceMs: number;
  readonly trailingSilenceMs: number;
  readonly longestInternalSilenceMs: number;
  readonly unitsPerMinute: number;
  readonly speechMs: number;
}

function analyse(wave: Wave, units: number): Analysis {
  const { samples, sampleRate, channels } = wave;
  const frames = Math.floor(samples.length / Math.max(channels, 1));
  const durationMs = (frames / sampleRate) * 1000;

  let peak = 0;
  let sumSquares = 0;
  let clipped = 0;

  for (const raw of samples) {
    const amplitude = Math.abs(raw) / 32768;
    if (amplitude > peak) peak = amplitude;
    if (amplitude >= CLIP_CEILING) clipped += 1;
    sumSquares += amplitude * amplitude;
  }

  const rms = Math.sqrt(sumSquares / Math.max(samples.length, 1));

  // Silence is judged relative to this clip's own peak, so a quietly recorded
  // voice is not mistaken for silence throughout.
  const floor = peak * SILENCE_FLOOR;
  const msPerSample = 1000 / sampleRate / Math.max(channels, 1);

  let first = -1;
  let last = -1;
  let longestGap = 0;
  let gap = 0;

  for (let i = 0; i < samples.length; i += 1) {
    const loud = Math.abs(samples[i]!) / 32768 > floor;
    if (loud) {
      if (first < 0) first = i;
      last = i;
      if (gap > longestGap) longestGap = gap;
      gap = 0;
    } else if (first >= 0) {
      gap += 1;
    }
  }

  const leadingSilenceMs = first < 0 ? durationMs : first * msPerSample;
  const trailingSilenceMs = last < 0 ? durationMs : (samples.length - 1 - last) * msPerSample;
  const speechMs = last > first ? (last - first) * msPerSample : durationMs;

  return {
    durationMs,
    peak,
    rms,
    clippedShare: clipped / Math.max(samples.length, 1),
    leadingSilenceMs,
    trailingSilenceMs,
    longestInternalSilenceMs: longestGap * msPerSample,
    unitsPerMinute: speechMs > 0 ? units / (speechMs / 60000) : 0,
    speechMs,
  };
}

// ---------------------------------------------------------------------------

function loadEnv(): void {
  const envPath = join(repoRoot, ".env");
  if (!existsSync(envPath)) return;
  try {
    process.loadEnvFile(envPath);
  } catch {
    // A malformed .env surfaces as a missing credential below.
  }
}

loadEnv();

const apiKey = process.env.RIME_API_KEY?.trim();
if (apiKey === undefined || apiKey.length === 0) {
  console.log("\nSKIPPED - no RIME_API_KEY configured.");
  console.log("This check needs real audio; there is nothing to analyse without it.\n");
  process.exit(0);
}

const rime = createRimeClient({
  apiKey,
  model: process.env.RIME_MODEL?.trim() || "mistv3",
  speaker: process.env.RIME_SPEAKER?.trim() || "luna",
  language: "eng",
});

console.log(`\nAudio QA — ${rime.model} / ${rime.speaker} / ${rime.language}`);
console.log("Mechanical defects only. Whether it SOUNDS right still needs a listener.\n");

let failures = 0;
const problems: string[] = [];

function judge(label: string, ok: boolean, detail: string): void {
  if (!ok) {
    failures += 1;
    problems.push(`${label}: ${detail}`);
  }
}

for (const line of LINES) {
  const spoken = prepareForSpeech(line);
  const words = spoken.split(/\s+/).filter(Boolean).length;
  const units = spokenUnits(spoken);

  let analysis: Analysis;
  try {
    const speech = await rime.synthesize(spoken, AbortSignal.timeout(30000));
    analysis = analyse(parseWave(speech.audio), units);
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${JSON.stringify(spoken.slice(0, 46))}`);
    console.log(`      ${error instanceof Error ? error.message : "unknown error"}\n`);
    continue;
  }

  const a = analysis;
  const tag = JSON.stringify(spoken.slice(0, 46));

  judge(tag, a.clippedShare <= MAX_CLIPPED_SHARE, `clipping ${(a.clippedShare * 100).toFixed(2)}%`);
  judge(tag, a.trailingSilenceMs >= MIN_TRAILING_SILENCE_MS, `tail may be cut (${a.trailingSilenceMs.toFixed(0)} ms)`);
  judge(tag, a.leadingSilenceMs <= MAX_LEADING_SILENCE_MS, `dead air before speech (${a.leadingSilenceMs.toFixed(0)} ms)`);
  judge(tag, a.longestInternalSilenceMs <= MAX_INTERNAL_SILENCE_MS, `internal gap ${a.longestInternalSilenceMs.toFixed(0)} ms`);
  // Too short to judge instantaneous rate; reported below either way.
  if (a.speechMs >= MIN_SPEECH_MS_FOR_PACE) {
    judge(
      tag,
      a.unitsPerMinute >= PACE_MIN && a.unitsPerMinute <= PACE_MAX,
      `pace ${a.unitsPerMinute.toFixed(0)} units/min`,
    );
  }

  console.log(`  ${tag}`);
  console.log(
    `      ${(a.durationMs / 1000).toFixed(2)}s · ${words}w/${units}u · ` +
      `${a.unitsPerMinute.toFixed(0)} u/min` +
      `${a.speechMs < MIN_SPEECH_MS_FOR_PACE ? " (short, pace not judged)" : ""} · ` +
      `peak ${(a.peak * 100).toFixed(1)}% · rms ${(a.rms * 100).toFixed(1)}% · ` +
      `clip ${(a.clippedShare * 100).toFixed(2)}%`,
  );
  console.log(
    `      lead ${a.leadingSilenceMs.toFixed(0)} ms · tail ${a.trailingSilenceMs.toFixed(0)} ms · ` +
      `longest gap ${a.longestInternalSilenceMs.toFixed(0)} ms\n`,
  );
}

if (failures === 0) {
  console.log("NO MECHANICAL DEFECTS DETECTED");
  console.log("Not the same as sounding right - play the clips and judge that yourself.\n");
} else {
  console.log(`${failures} PROBLEM(S):`);
  for (const problem of problems) console.log(`  - ${problem}`);
  console.log("");
}

process.exit(failures === 0 ? 0 : 1);
