/**
 * Generation-stamped playback queue for assistant speech.
 *
 * Every clip that enters this queue carries the conversation generation it was
 * produced for. Playback only ever happens for clips whose stamp matches the
 * queue's current generation, and advancing that generation makes everything
 * older inaudible - both the clip playing right now and everything waiting
 * behind it.
 *
 * That is the property the hackathon brief asks for: when the user interrupts,
 * queued speech must stop promptly, and generation-N audio must never continue
 * into a generation-N+1 answer.
 *
 * ## Still not the correctness mechanism
 *
 * This makes the *user's experience* correct - they stop hearing the abandoned
 * answer. It does not make the *conversation* correct; that was already settled
 * server-side by `fencedCommit` before any audio existed. Nothing here is
 * awaited or checked by anything that decides what the conversation contains.
 * If every stop below silently failed, the transcript would still be right.
 */

export interface SpeechQueueHooks {
  /** First audio of a generation actually began playing. */
  onPlaybackStarted(generation: number): void;
  /** The queue drained and nothing is playing. */
  onIdle(): void;
}

interface QueuedClip {
  readonly generation: number;
  readonly blob: Blob;
}

export class AssistantSpeechQueue {
  private queue: QueuedClip[] = [];
  private audio: HTMLAudioElement | null = null;
  private objectUrl: string | null = null;
  private draining = false;
  /** Clips not stamped with this are never played. */
  private generation = -1;
  private startedThisGeneration = false;
  /** Set when the browser refuses to autoplay, so the UI can explain. */
  private blocked = false;
  /** Settles the promise for the clip currently playing. */
  private settleCurrent: ((finished: boolean) => void) | null = null;

  constructor(private readonly hooks: SpeechQueueHooks) {}

  get isPlaying(): boolean {
    return this.audio !== null;
  }

  get autoplayBlocked(): boolean {
    return this.blocked;
  }

  /**
   * Moves the queue to a new generation.
   *
   * Anything queued or playing for an older generation is discarded
   * immediately. Returns how many queued clips were dropped.
   */
  setGeneration(generation: number): number {
    if (generation === this.generation) return 0;
    this.generation = generation;
    this.startedThisGeneration = false;
    return this.flush();
  }

  /**
   * Adds a clip. Rejected - and reported as such - if it belongs to a
   * generation the queue has already moved past.
   */
  enqueue(generation: number, blob: Blob): boolean {
    if (generation !== this.generation) return false;
    this.queue.push({ generation, blob });
    void this.drain();
    return true;
  }

  /**
   * Silences playback and discards everything queued.
   *
   * Returns the number of queued clips dropped, which the UI reports so an
   * interruption's effect on *pending* audio is visible and not just implied.
   */
  flush(): number {
    const dropped = this.queue.length;
    this.queue = [];
    this.stopCurrent();
    return dropped;
  }

  private stopCurrent(): void {
    const audio = this.audio;
    if (audio === null) return;

    audio.pause();
    audio.onended = null;
    audio.onerror = null;
    this.audio = null;

    if (this.objectUrl !== null) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }

    // The clip's promise must be settled here. Detaching the handlers above
    // means `onended` will never fire, so without this the drain loop would
    // wait forever - and every later clip, including the new generation's,
    // would silently never play.
    const settle = this.settleCurrent;
    this.settleCurrent = null;
    settle?.(false);
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;

    try {
      for (;;) {
        const next = this.queue.shift();
        if (next === undefined) break;

        // Re-checked at the moment of playing, not only when enqueued: the
        // generation can advance while an earlier clip is still playing.
        if (next.generation !== this.generation) continue;

        const finished = await this.playOne(next);
        if (!finished) break;
      }
    } finally {
      this.draining = false;
      if (this.audio === null) this.hooks.onIdle();
    }
  }

  /** Returns false if playback was stopped or refused, ending the drain. */
  private async playOne(clip: QueuedClip): Promise<boolean> {
    const url = URL.createObjectURL(clip.blob);
    const audio = new Audio(url);
    this.audio = audio;
    this.objectUrl = url;

    try {
      await audio.play();
      this.blocked = false;
    } catch (error) {
      this.stopCurrent();
      // Browsers refuse audio that no user gesture initiated. Worth knowing,
      // because the fix is "click something", not "retry".
      this.blocked = error instanceof Error && error.name === "NotAllowedError";
      return false;
    }

    if (!this.startedThisGeneration) {
      this.startedThisGeneration = true;
      this.hooks.onPlaybackStarted(clip.generation);
    }

    return await new Promise<boolean>((resolve) => {
      this.settleCurrent = resolve;

      audio.onended = () => {
        this.settleCurrent = null;
        // Only tidy up if this clip is still the active one; a clip that ends
        // after being superseded must not disturb its replacement.
        if (this.audio === audio) this.stopCurrent();
        resolve(true);
      };
      audio.onerror = () => {
        this.settleCurrent = null;
        if (this.audio === audio) this.stopCurrent();
        resolve(false);
      };
    });
  }
}
