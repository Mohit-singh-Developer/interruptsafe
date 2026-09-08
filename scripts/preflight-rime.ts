import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Rime configuration and secret preflight.
 *
 *   npm run preflight:rime
 *
 * Three groups of checks, in increasing order of what they require:
 *
 *  1. Secret hygiene - no credential is committed, `.env` is ignored, and the
 *     environment example carries placeholders only. Needs nothing.
 *  2. Configuration - the model, language and speaker actually exist together
 *     in Rime's live catalogue. Needs network, no credential.
 *  3. Live synthesis - one real request, verified to return non-silent WAVE
 *     audio rather than JSON. Needs a credential; skipped cleanly without one.
 *
 * The API key is never printed, never logged, and never written anywhere.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CATALOG_URL = "https://users.rime.ai/data/voices/all-v2.json";
const TTS_URL = "https://users.rime.ai/v1/rime-tts";

const DEFAULT_MODEL = "mistv3";
const DEFAULT_SPEAKER = "luna";
const DEFAULT_LANGUAGE = "eng";

let failures = 0;
let skipped = 0;

function pass(label: string, detail = ""): void {
  console.log(`  PASS  ${label}${detail === "" ? "" : ` — ${detail}`}`);
}
function fail(label: string, detail = ""): void {
  failures += 1;
  console.log(`  FAIL  ${label}${detail === "" ? "" : ` — ${detail}`}`);
}
function skip(label: string, detail = ""): void {
  skipped += 1;
  console.log(`  SKIP  ${label}${detail === "" ? "" : ` — ${detail}`}`);
}

/** Reads .env without printing anything from it. */
function loadEnv(): void {
  const envPath = join(repoRoot, ".env");
  if (!existsSync(envPath)) return;
  try {
    process.loadEnvFile(envPath);
  } catch {
    // A malformed .env is reported by the checks below, not here.
  }
}

function git(args: string[]): { ok: boolean; out: string } {
  try {
    // stderr is ignored: a non-match from `check-ignore` or `ls-files` is an
    // expected outcome here, not something to print at the user.
    const out = execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { ok: true, out };
  } catch (error) {
    const out = (error as { stdout?: string }).stdout ?? "";
    return { ok: false, out };
  }
}

// Loaded before any check runs: the secret-hygiene scan needs to know the
// credential in order to prove it appears nowhere it shouldn't.
loadEnv();

// ---------------------------------------------------------------------------
console.log("\n1. Secret hygiene");
// ---------------------------------------------------------------------------

{
  const ignored = git(["check-ignore", "-q", ".env"]).ok;
  ignored ? pass(".env is gitignored") : fail(".env is NOT gitignored");

  const tracked = git(["ls-files", "--error-unmatch", ".env"]).ok;
  tracked ? fail(".env is TRACKED by git") : pass(".env is not tracked by git");

  const examplePath = join(repoRoot, ".env.example");
  if (!existsSync(examplePath)) {
    fail(".env.example is missing");
  } else {
    const filled = readFileSync(examplePath, "utf8")
      .split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith("#"))
      .filter((line) => /^[A-Z_]+=.+$/.test(line.trim()))
      // Documented non-secret defaults are fine; credentials must be blank.
      .filter((line) => /KEY|TOKEN|SECRET|PASSWORD/i.test(line));

    filled.length === 0
      ? pass(".env.example carries placeholders only", "no credential has a value")
      : fail(".env.example contains a filled credential", filled.join(", "));
  }

  // If a key is configured, prove it appears in no tracked file.
  const key = process.env.RIME_API_KEY?.trim();
  if (key === undefined || key.length === 0) {
    skip("credential-in-repo scan", "no RIME_API_KEY set to search for");
  } else {
    const files = git(["ls-files"]).out.split(/\r?\n/).filter(Boolean);
    const leaked = files.filter((file) => {
      const full = join(repoRoot, file);
      if (!existsSync(full)) return false;
      try {
        return readFileSync(full, "utf8").includes(key);
      } catch {
        return false;
      }
    });
    leaked.length === 0
      ? pass("credential appears in no tracked file", `${files.length} files scanned`)
      : fail("credential FOUND in tracked files", leaked.join(", "));
  }
}

// ---------------------------------------------------------------------------
console.log("\n2. Configuration against Rime's live catalogue");
// ---------------------------------------------------------------------------

const model = process.env.RIME_MODEL?.trim() || DEFAULT_MODEL;
const speaker = process.env.RIME_SPEAKER?.trim() || DEFAULT_SPEAKER;
const language = DEFAULT_LANGUAGE;

console.log(`  configuration: model=${model} speaker=${speaker} lang=${language}`);

let catalogueOk = false;
try {
  const response = await fetch(CATALOG_URL);
  if (!response.ok) throw new Error(`catalogue returned ${response.status}`);
  const catalogue = (await response.json()) as Record<string, Record<string, unknown>>;

  const byLanguage = catalogue[model];
  if (byLanguage === undefined) {
    fail(`model "${model}" exists`, `known models: ${Object.keys(catalogue).join(", ")}`);
  } else {
    pass(`model "${model}" exists`);

    const voices = byLanguage[language];
    if (voices === undefined) {
      fail(`model "${model}" supports language "${language}"`, `has: ${Object.keys(byLanguage).join(", ")}`);
    } else {
      pass(`model "${model}" supports language "${language}"`);

      const names = Array.isArray(voices)
        ? voices.map((v) => (typeof v === "string" ? v : ((v as Record<string, string>).name ?? "")))
        : Object.keys(voices as Record<string, unknown>);

      if (names.includes(speaker)) {
        pass(`speaker "${speaker}" is served by ${model}/${language}`, `${names.length} voices available`);
        catalogueOk = true;
      } else {
        fail(
          `speaker "${speaker}" is served by ${model}/${language}`,
          `not in catalogue; e.g. ${names.slice(0, 6).join(", ")}`,
        );
      }
    }
  }
} catch (error) {
  fail("live catalogue reachable", error instanceof Error ? error.message : "unknown error");
}

// ---------------------------------------------------------------------------
console.log("\n3. Live synthesis");
// ---------------------------------------------------------------------------

const apiKey = process.env.RIME_API_KEY?.trim();

if (apiKey === undefined || apiKey.length === 0) {
  skip("real synthesis", "no RIME_API_KEY configured (this is a valid zero-cost setup)");
} else if (!catalogueOk) {
  skip("real synthesis", "configuration failed above; fix that first");
} else {
  try {
    const started = Date.now();
    const response = await fetch(TTS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "audio/wav",
      },
      body: JSON.stringify({
        text: "Preflight check. This is Rime speaking.",
        speaker,
        modelId: model,
        lang: language,
      }),
    });
    const elapsed = Date.now() - started;

    if (!response.ok) {
      fail(`synthesis request`, `HTTP ${response.status} (401 means the key is invalid)`);
    } else {
      const bytes = new Uint8Array(await response.arrayBuffer());
      const header = String.fromCharCode(...bytes.slice(0, 4));

      if (header !== "RIFF") {
        // Rime returns JSON on an unrecognised Accept header; a 200 alone is
        // not proof of audio.
        fail("response is WAVE audio", `starts with "${header}", not "RIFF"`);
      } else {
        pass("response is WAVE audio", `${bytes.byteLength} bytes in ${elapsed} ms (includes network)`);

        // A valid but silent file would still say RIFF, so check the samples.
        let peak = 0;
        for (let offset = 44; offset + 1 < bytes.byteLength; offset += 2) {
          const sample = (bytes[offset]! | (bytes[offset + 1]! << 8)) << 16 >> 16;
          const amplitude = Math.abs(sample);
          if (amplitude > peak) peak = amplitude;
        }
        peak > 1000
          ? pass("audio is not silence", `peak ${((peak / 32767) * 100).toFixed(1)}% of full scale`)
          : fail("audio is not silence", `peak only ${peak}`);
      }
    }
  } catch (error) {
    fail("synthesis request", error instanceof Error ? error.message : "unknown error");
  }
}

// ---------------------------------------------------------------------------
console.log("");
if (failures === 0) {
  console.log(`PREFLIGHT PASSED${skipped > 0 ? ` (${skipped} skipped)` : ""}`);
} else {
  console.log(`PREFLIGHT FAILED — ${failures} problem(s)${skipped > 0 ? `, ${skipped} skipped` : ""}`);
}
process.exit(failures === 0 ? 0 : 1);
