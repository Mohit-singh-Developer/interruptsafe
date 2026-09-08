import { useCallback, useEffect, useRef, useState } from "react";
import {
  VoiceActivityDetector,
  type VoiceActivityStatus,
} from "./voiceActivityDetector";

/**
 * React wrapper around the local voice activity detector.
 *
 * Owns the detector's lifetime and guarantees the microphone is released when
 * the component unmounts - a stream left running keeps the browser's recording
 * indicator lit, which users reasonably find alarming.
 *
 * The `onSpeechStart` callback is held in a ref so the detector always calls
 * the latest version. Without that, the callback captured at start time would
 * see stale state and could not tell whether a turn was in flight.
 */

export interface VoiceActivity {
  readonly status: VoiceActivityStatus;
  /** True while the signal is above the loudness threshold. For the indicator. */
  readonly loud: boolean;
  start(): Promise<void>;
  stop(): void;
  /** Allows the next speech episode to report again. */
  rearm(): void;
}

export function useVoiceActivity(onSpeechStart: () => void): VoiceActivity {
  const [status, setStatus] = useState<VoiceActivityStatus>("idle");
  const [loud, setLoud] = useState(false);

  const onSpeechStartRef = useRef(onSpeechStart);
  onSpeechStartRef.current = onSpeechStart;

  const detectorRef = useRef<VoiceActivityDetector | null>(null);

  if (detectorRef.current === null) {
    detectorRef.current = new VoiceActivityDetector({
      onSpeechStart: () => onSpeechStartRef.current(),
      onLoudChange: setLoud,
    });
  }

  const start = useCallback(async () => {
    setStatus("starting");
    const result = await detectorRef.current!.start();
    setStatus(result);
  }, []);

  const stop = useCallback(() => {
    detectorRef.current?.stop();
    setLoud(false);
    setStatus("idle");
  }, []);

  const rearm = useCallback(() => {
    detectorRef.current?.rearm();
  }, []);

  // Release the microphone if the component goes away while listening.
  useEffect(() => {
    const detector = detectorRef.current;
    return () => detector?.stop();
  }, []);

  return { status, loud, start, stop, rearm };
}
