/**
 * A very simple LOCAL voice activity detector.
 *
 * This is NOT speech recognition and NOT production-grade VAD. It measures the
 * loudness of the microphone signal and decides that "someone is probably
 * talking" when the signal stays above a threshold for long enough. It has no
 * idea what was said, and it cannot tell a voice from a slammed door.
 *
 * ## Privacy and cost
 *
 * Everything happens inside the browser tab. The microphone stream is connected
 * to an `AnalyserNode`, energy is read from it, and the numbers are discarded.
 * No audio is buffered, uploaded, or sent anywhere, and no external service is
 * contacted - so this costs nothing to run.
 *
 * ## What it produces
 *
 * One `onSpeechStart` callback per episode of sustained sound. It latches after
 * firing and only re-arms once the signal has been quiet again for a while, so
 * continuous talking produces one event rather than a stream of them. Deciding
 * what to *do* with that event is the caller's business; this class never calls
 * the server.
 */

/**
 * Root-mean-square level, 0..1, above which a frame counts as "loud".
 *
 * Tuned by hand against a laptop microphone at normal speaking volume in a
 * quiet room. Ambient room noise usually sits well below this; speech sits
 * clearly above it. It is a demo default, not a calibrated figure.
 */
export const VOICE_ACTIVITY_THRESHOLD = 0.045;

/** Sustained loudness required before speech is declared, in milliseconds. */
export const VOICE_ACTIVITY_HOLD_MS = 250;

/** Quiet time required before another speech episode can be reported. */
export const VOICE_ACTIVITY_RELEASE_MS = 700;

/** How often the signal is sampled. */
const SAMPLE_INTERVAL_MS = 50;

export type VoiceActivityStatus =
  | "idle"
  | "starting"
  | "listening"
  | "denied"
  | "unavailable"
  | "error";

export interface VoiceActivityCallbacks {
  /** Fired once per sustained episode of sound. */
  onSpeechStart(): void;
  /** Fired when the loud/quiet state changes, for the UI indicator. */
  onLoudChange(loud: boolean): void;
}

export class VoiceActivityDetector {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  private loudForMs = 0;
  private quietForMs = 0;
  private latched = false;
  private loud = false;

  constructor(private readonly callbacks: VoiceActivityCallbacks) {}

  /**
   * Requests the microphone and begins analysing.
   *
   * Returns the resulting status rather than throwing, because every failure
   * here is a normal thing that happens to users: permission refused, no input
   * device, or a browser that does not expose the API at all.
   */
  async start(): Promise<VoiceActivityStatus> {
    if (
      typeof navigator === "undefined" ||
      navigator.mediaDevices?.getUserMedia === undefined ||
      typeof AudioContext === "undefined"
    ) {
      return "unavailable";
    }

    try {
      // Echo cancellation matters once the assistant speaks aloud: without it
      // the agent's own voice reaches this detector and interrupts itself.
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      if (name === "NotAllowedError" || name === "SecurityError") return "denied";
      if (name === "NotFoundError" || name === "OverconstrainedError") return "unavailable";
      return "error";
    }

    try {
      this.context = new AudioContext();
      // Browsers may hand back a suspended context until a user gesture.
      if (this.context.state === "suspended") await this.context.resume();

      this.source = this.context.createMediaStreamSource(this.stream);
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 512;

      // The analyser is a dead end on purpose: it is never connected to the
      // destination, so the microphone is never played back to the user.
      this.source.connect(this.analyser);
    } catch {
      this.stop();
      return "error";
    }

    this.reset();
    // Backed by a concrete ArrayBuffer so it matches the analyser's signature.
    const buffer = new Uint8Array(new ArrayBuffer(this.analyser.fftSize));
    this.timer = setInterval(() => this.sample(buffer), SAMPLE_INTERVAL_MS);

    return "listening";
  }

  /** Stops analysis and releases the microphone. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }

    this.source?.disconnect();
    this.source = null;
    this.analyser = null;

    // Every track must be stopped or the browser keeps showing the mic as live.
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;

    void this.context?.close().catch(() => undefined);
    this.context = null;

    if (this.loud) {
      this.loud = false;
      this.callbacks.onLoudChange(false);
    }
    this.reset();
  }

  /** Re-arms the detector so the next speech episode reports again. */
  rearm(): void {
    this.latched = false;
  }

  private reset(): void {
    this.loudForMs = 0;
    this.quietForMs = 0;
    this.latched = false;
  }

  private sample(buffer: Uint8Array<ArrayBuffer>): void {
    const analyser = this.analyser;
    if (analyser === null) return;

    analyser.getByteTimeDomainData(buffer);

    // Time-domain samples are centred on 128; RMS of the deviation is a decent
    // stand-in for loudness and is cheap to compute.
    let sumOfSquares = 0;
    for (const sample of buffer) {
      const deviation = (sample - 128) / 128;
      sumOfSquares += deviation * deviation;
    }
    const level = Math.sqrt(sumOfSquares / buffer.length);

    const isLoud = level >= VOICE_ACTIVITY_THRESHOLD;

    if (isLoud !== this.loud) {
      this.loud = isLoud;
      this.callbacks.onLoudChange(isLoud);
    }

    if (isLoud) {
      this.loudForMs += SAMPLE_INTERVAL_MS;
      this.quietForMs = 0;

      if (!this.latched && this.loudForMs >= VOICE_ACTIVITY_HOLD_MS) {
        this.latched = true;
        this.callbacks.onSpeechStart();
      }
      return;
    }

    this.loudForMs = 0;
    this.quietForMs += SAMPLE_INTERVAL_MS;

    // Long enough silence re-arms the latch, so a later episode reports again.
    if (this.latched && this.quietForMs >= VOICE_ACTIVITY_RELEASE_MS) {
      this.latched = false;
    }
  }
}
