import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Browser-native speech recognition.
 *
 * Uses the Web Speech API (`SpeechRecognition`, or `webkitSpeechRecognition` on
 * Chromium). This is the zero-cost path: no API key, no account, no cloud SDK
 * added to the project.
 *
 * ## An honest note about where the audio goes
 *
 * This API is **not guaranteed to be on-device**. Chrome and Edge have
 * historically sent audio to a Google speech service for recognition; Safari
 * uses Apple's. Whether any given browser recognises locally or remotely is a
 * property of that browser, not of this code, and it can change between
 * versions. What is true is that *this application* never receives, stores or
 * uploads the audio: the browser hands us text, and only text.
 *
 * If that matters for a given demo, the microphone can simply be left off - the
 * text composer is always available and nothing else depends on it.
 *
 * ## Support
 *
 * Firefox does not implement it at the time of writing. The hook reports
 * `unsupported` and the caller keeps working from typed input.
 */

// The Web Speech API is not in every TypeScript DOM lib, so the small part of
// it we use is declared locally rather than depending on ambient types.
interface RecognitionAlternative {
  readonly transcript: string;
}

interface RecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: RecognitionAlternative;
}

interface RecognitionResultList {
  readonly length: number;
  readonly [index: number]: RecognitionResult;
}

interface RecognitionEvent {
  readonly resultIndex: number;
  readonly results: RecognitionResultList;
}

interface RecognitionErrorEvent {
  readonly error: string;
}

interface RecognitionInstance {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: RecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}

type RecognitionConstructor = new () => RecognitionInstance;

function getRecognitionConstructor(): RecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  const scope = window as unknown as Record<string, unknown>;
  const ctor = scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
  return typeof ctor === "function" ? (ctor as RecognitionConstructor) : null;
}

export type SpeechRecognitionStatus =
  | "unsupported"
  | "idle"
  | "starting"
  | "listening"
  | "denied"
  | "error";

export interface SpeechRecognitionState {
  readonly status: SpeechRecognitionStatus;
  readonly supported: boolean;
  /** Words recognised so far in the current utterance, before it is finalised. */
  readonly interim: string;
  start(): void;
  stop(): void;
}

export interface SpeechRecognitionCallbacks {
  /** Called once per finalised utterance, with its text. */
  onFinal(text: string): void;
  /**
   * Called as soon as *any* words are recognised, interim or final.
   *
   * This is the tier-2 confirmation signal: it means the loudness the detector
   * heard was actually speech, not a door slam.
   */
  onRecognisedActivity(): void;
}

export function useSpeechRecognition(
  callbacks: SpeechRecognitionCallbacks,
): SpeechRecognitionState {
  const supported = useRef(getRecognitionConstructor() !== null).current;

  const [status, setStatus] = useState<SpeechRecognitionStatus>(
    supported ? "idle" : "unsupported",
  );
  const [interim, setInterim] = useState("");

  // Held in a ref so the recognition instance - created once - always calls the
  // current callbacks rather than the ones captured when it was created.
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  const recognitionRef = useRef<RecognitionInstance | null>(null);
  /** True while the user wants to be listening, across automatic restarts. */
  const wantListeningRef = useRef(false);

  // Created once, not per render.
  if (supported && recognitionRef.current === null) {
    const Recognition = getRecognitionConstructor()!;
    const recognition = new Recognition();

    recognition.lang = "en-US";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => setStatus("listening");

    recognition.onresult = (event) => {
      // Results accumulate across the session, so only entries from
      // `resultIndex` onward are new. Reprocessing earlier ones would emit the
      // same final transcript repeatedly.
      let pendingInterim = "";

      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (result === undefined) continue;

        const text = result[0]?.transcript?.trim() ?? "";
        if (text.length === 0) continue;

        // Any recognised words at all confirm that speech is happening.
        callbacksRef.current.onRecognisedActivity();

        if (result.isFinal) {
          callbacksRef.current.onFinal(text);
        } else {
          pendingInterim = pendingInterim === "" ? text : `${pendingInterim} ${text}`;
        }
      }

      setInterim(pendingInterim);
    };

    recognition.onerror = (event) => {
      // "no-speech" and "aborted" are routine and not worth surfacing.
      if (event.error === "no-speech" || event.error === "aborted") return;

      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        wantListeningRef.current = false;
        setStatus("denied");
        return;
      }

      setStatus("error");
    };

    recognition.onend = () => {
      setInterim("");
      // Continuous recognition still ends on its own, typically after a pause.
      // Restart only while the user still wants to listen, so this cannot spin.
      if (wantListeningRef.current) {
        try {
          recognition.start();
        } catch {
          // Already starting; the next onend will try again.
        }
        return;
      }
      setStatus((current) => (current === "denied" || current === "error" ? current : "idle"));
    };

    recognitionRef.current = recognition;
  }

  const start = useCallback(() => {
    const recognition = recognitionRef.current;
    if (recognition === null) return;

    wantListeningRef.current = true;
    setStatus("starting");
    try {
      recognition.start();
    } catch {
      // start() throws if it is already running, which is harmless here.
    }
  }, []);

  const stop = useCallback(() => {
    const recognition = recognitionRef.current;
    wantListeningRef.current = false;
    setInterim("");
    recognition?.stop();
    setStatus((current) => (current === "unsupported" ? current : "idle"));
  }, []);

  // Detach handlers and abort on unmount so nothing fires into a dead tree.
  useEffect(() => {
    const recognition = recognitionRef.current;
    return () => {
      wantListeningRef.current = false;
      if (recognition === null) return;
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      recognition.onstart = null;
      recognition.abort();
    };
  }, []);

  return { status, supported, interim, start, stop };
}
