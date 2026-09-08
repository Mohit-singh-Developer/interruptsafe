import type { RimeConfig } from "../config";

/**
 * Rime text-to-speech client.
 *
 * Verified against Rime's own quickstart documentation:
 *
 *   POST https://users.rime.ai/v1/rime-tts
 *   Authorization: Bearer <key>
 *   Content-Type: application/json
 *   Accept: audio/wav
 *   { "text": "...", "speaker": "celeste", "modelId": "mistv3" }
 *
 * `modelId` is documented as `coda` (flagship quality) or `mistv3` (lowest
 * latency). No undocumented parameters are sent.
 *
 * ## Boundaries
 *
 * The endpoint is a hard-coded constant. Nothing the browser sends can redirect
 * this request elsewhere - the client supplies text, never a URL.
 *
 * The API key lives here and in the environment only. It is never returned to
 * the browser, never written to a log line, and never included in an error
 * message handed back to a caller.
 *
 * ## This is presentation, not correctness
 *
 * Speech is generated from an assistant reply that has *already* been committed
 * through `fencedCommit`. If synthesis fails, is slow, or is never configured at
 * all, the committed text is unaffected: the conversation is already correct and
 * only its audible rendering is missing.
 */

const RIME_ENDPOINT = "https://users.rime.ai/v1/rime-tts";

/** Requested audio encoding. WAV plays natively in every target browser. */
const AUDIO_CONTENT_TYPE = "audio/wav";

/** Upper bound on a single synthesis request. */
const REQUEST_TIMEOUT_MS = 20000;

export interface SynthesizedSpeech {
  readonly audio: Uint8Array;
  readonly contentType: string;
  /**
   * Wall-clock milliseconds for the upstream Rime request, measured server-side.
   *
   * This is request duration for a complete clip - it is **not** a
   * time-to-first-byte figure, and it includes network time to Rime. Reported
   * as measured; no attempt is made to separate provider time from network time.
   */
  readonly upstreamMs: number;
}

/** Thrown when Rime could not produce audio. Message is safe to surface. */
export class TtsError extends Error {
  override readonly name = "TtsError";
}

export interface RimeClient {
  readonly speaker: string;
  readonly model: string;
  readonly language: string;
  readonly audioFormat: string;
  readonly endpoint: string;
  synthesize(text: string, signal: AbortSignal): Promise<SynthesizedSpeech>;
}

export function createRimeClient(config: RimeConfig): RimeClient {
  return {
    speaker: config.speaker,
    model: config.model,
    language: config.language,
    audioFormat: AUDIO_CONTENT_TYPE,
    endpoint: RIME_ENDPOINT,

    async synthesize(text: string, signal: AbortSignal): Promise<SynthesizedSpeech> {
      const startedAt = performance.now();
      // Bound the request so a hung upstream cannot pin a connection open.
      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const combined = AbortSignal.any([signal, timeout]);

      let response: Response;
      try {
        response = await fetch(RIME_ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            "Content-Type": "application/json",
            Accept: AUDIO_CONTENT_TYPE,
          },
          body: JSON.stringify({
            text,
            speaker: config.speaker,
            modelId: config.model,
            lang: config.language,
          }),
          signal: combined,
        });
      } catch (error) {
        if (signal.aborted) throw error;
        // Deliberately generic: never echo request details that might carry the key.
        throw new TtsError("Could not reach the speech service.");
      }

      if (!response.ok) {
        // The status is safe to report; the body is not guaranteed to be.
        throw new TtsError(`Speech service returned status ${response.status}.`);
      }

      const audio = new Uint8Array(await response.arrayBuffer());
      if (audio.byteLength === 0) {
        throw new TtsError("Speech service returned empty audio.");
      }

      return {
        audio,
        contentType: response.headers.get("content-type") ?? AUDIO_CONTENT_TYPE,
        upstreamMs: Math.round(performance.now() - startedAt),
      };
    },
  };
}
