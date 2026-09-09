import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  prepareForSpeech,
  type ConversationEvent,
  type SpeechProviderInfo,
} from "@interruptsafe/shared";
import {
  fetchActivity,
  fetchHealth,
  requestInterrupt,
  sendChatMessage,
  synthesizeSpeech,
} from "./transport/chatClient";
import { useVoiceActivity } from "./audio/useVoiceActivity";
import { useSpeechRecognition } from "./audio/useSpeechRecognition";
import { AssistantSpeechQueue } from "./audio/assistantAudio";
import { splitIntoClauses } from "./audio/clauseChunker";

/**
 * InterruptSafe web client.
 *
 * A minimal text conversation: type a message, send it over HTTP, display the
 * reply. The message list here is display state only - the server owns the
 * authoritative transcript.
 *
 * While a turn is in flight an Interrupt control is offered. Pressing it
 * advances the conversation's generation on the server, which is what makes the
 * outstanding turn obsolete. When that turn's reply eventually arrives it comes
 * back marked as superseded, and this client renders it as discarded rather
 * than as the latest answer - the visible half of the guarantee the server
 * enforces.
 */

type DisplayRole = "user" | "assistant" | "notice" | "interruption";

/** Human-readable labels for the timeline. */
const EVENT_LABELS: Record<ConversationEvent["type"], string> = {
  "turn-started": "Provider work started",
  "generation-advanced": "Generation advanced",
  "interruption-requested": "Interrupted by user",
  "cancellation-requested": "Cancellation requested (advisory)",
  "result-committed": "Result committed",
  "result-fenced": "Result fenced — not committed",
  "provider-failed": "Provider failed",
  "tool-started": "Mock tool started",
  "tool-completed": "Mock tool completed",
  "tool-cancelled": "Mock tool cancelled",
  "tool-failed": "Mock tool failed",
  "tool-result-fenced": "Mock tool result fenced — not used",
  "tts-started": "Rime synthesis started",
  "tts-audio-ready": "Rime audio ready",
  "tts-fenced": "Rime synthesis skipped — turn superseded",
  "tts-failed": "Rime synthesis failed",
};

/** Event types that represent work being rejected or abandoned. */
const INTERRUPTED_EVENTS: ReadonlySet<ConversationEvent["type"]> = new Set([
  "interruption-requested",
  "result-fenced",
  "provider-failed",
  "tool-cancelled",
  "tool-failed",
  "tool-result-fenced",
  "tts-fenced",
  "tts-failed",
]);

/**
 * The mock tool currently running, if any.
 *
 * Derived from the event list: a `tool-started` that has not yet been followed
 * by an outcome for the same tool.
 */
function runningTool(events: readonly ConversationEvent[]): string | null {
  let running: string | null = null;

  for (const event of events) {
    if (event.type === "tool-started") {
      running = event.tool ?? "tool";
    } else if (
      event.type === "tool-completed" ||
      event.type === "tool-cancelled" ||
      event.type === "tool-failed" ||
      event.type === "tool-result-fenced"
    ) {
      running = null;
    }
  }

  return running;
}

/** Button text per microphone state. */
const MIC_LABELS: Record<string, string> = {
  idle: "Start listening",
  starting: "Starting…",
  listening: "Listening",
  denied: "Mic blocked",
  unavailable: "No microphone",
  error: "Mic error — retry",
};

/** Longer explanations, shown as tooltips and to screen readers. */
const MIC_TITLES: Record<string, string> = {
  idle: "Start local microphone listening. Audio never leaves this tab.",
  starting: "Requesting microphone access…",
  listening:
    "Listening locally for speech activity. Speaking while a turn is in flight will interrupt it. Nothing is transcribed.",
  denied: "Microphone permission was denied. Allow it in your browser settings.",
  unavailable: "No microphone is available in this browser or device.",
  error: "The microphone could not be started. Click to try again.",
};

/**
 * How long tier 1 waits for recognition to confirm that loudness was speech.
 *
 * Long enough for the Web Speech API to emit a first interim result, short
 * enough that a genuine interruption does not feel delayed. If nothing is
 * recognised in this window the noise is discarded and the conversation is left
 * completely alone.
 */
const VOICE_CONFIRM_TIMEOUT_MS = 1200;

/** Renders a measurement, or a dash when it has not been observed. */
function fmtMs(value: number | null): string {
  return value === null ? "—" : `${value} ms`;
}

interface EventGroup {
  generation: number | undefined;
  events: ConversationEvent[];
}

/** Groups consecutive events by the generation they belong to. */
function groupByGeneration(events: readonly ConversationEvent[]): EventGroup[] {
  const groups: EventGroup[] = [];

  for (const event of events) {
    const last = groups.at(-1);
    if (last !== undefined && last.generation === event.generation) {
      last.events.push(event);
    } else {
      groups.push({ generation: event.generation, events: [event] });
    }
  }

  return groups;
}

/**
 * Measurements taken in the browser.
 *
 * All of these are **application-side** timings measured with
 * `performance.now()`. They exclude audio-device output latency, which the page
 * cannot observe, and `lastRimeUpstreamMs` is a whole-request duration measured
 * on the server that includes network time to Rime - it is not a
 * time-to-first-byte figure. `null` means not yet observed, and nothing is
 * displayed until it is.
 */
interface Metrics {
  /** Turn submitted -> first assistant audio actually playing. */
  timeToFirstAudioMs: number | null;
  /** Loudness detected -> queued audio flushed (JS time only). */
  detectionToSilenceMs: number | null;
  /** POST /api/interrupt round trip, i.e. request -> generation advanced. */
  interruptRoundTripMs: number | null;
  /** Loudness detected -> speech confirmed by recognition. */
  vadToConfirmedMs: number | null;
  /** Server-measured Rime request duration for the most recent clause. */
  lastRimeUpstreamMs: number | null;
  /** Queued clips discarded by the most recent flush. */
  clipsDropped: number | null;
}

interface DisplayMessage {
  id: number;
  role: DisplayRole;
  text: string;
  /** Set on replies; the generation the turn was processed under. */
  generation?: number;
  /** True when this turn was fenced and never entered the conversation. */
  superseded?: boolean;
}

export function App() {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Latest generation reported by the server; null until the first response.
  const [generation, setGeneration] = useState<number | null>(null);
  // Server-recorded lifecycle events. Display only.
  const [events, setEvents] = useState<readonly ConversationEvent[]>([]);

  const nextId = useRef(0);
  const endOfListRef = useRef<HTMLDivElement>(null);
  // Allocated by the client on the first send rather than by the server, so
  // that Interrupt is available during the very first turn too. The server
  // accepts a client-supplied id. Reloading starts a new conversation.
  const conversationId = useRef<string | undefined>(undefined);

  // Null until the server has been asked; false means no Rime credential.
  const [ttsAvailable, setTtsAvailable] = useState<boolean | null>(null);
  /** Ref mirror, because the speak path reads it from an async closure. */
  const ttsAvailableRef = useRef<boolean | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const [voiceOutputNote, setVoiceOutputNote] = useState<string | null>(null);
  /** Which provider produces speech, reported by the server. */
  const [speechInfo, setSpeechInfo] = useState<SpeechProviderInfo | null>(null);

  // Mirrors of state for the microphone callback, which is created once and
  // would otherwise close over stale values.
  const isSendingRef = useRef(false);
  const voiceInterruptFiredRef = useRef(false);
  /** Speech recognised while a turn was still running, sent once it settles. */
  const queuedTranscriptRef = useRef<string | null>(null);

  /** Aborts in-flight synthesis requests when the user interrupts. */
  const ttsAbortRef = useRef<AbortController | null>(null);

  // --- Measurements. Only values actually observed are ever displayed. ---
  const [metrics, setMetrics] = useState<Metrics>({
    timeToFirstAudioMs: null,
    detectionToSilenceMs: null,
    interruptRoundTripMs: null,
    vadToConfirmedMs: null,
    lastRimeUpstreamMs: null,
    clipsDropped: null,
  });
  const turnStartedAtRef = useRef<number | null>(null);

  // --- Two-stage interruption state (architecture section 8). ---
  /** Set by tier 1 (loudness). Cleared by tier 2 confirmation or by timeout. */
  const pendingVoiceInterruptRef = useRef<{ at: number } | null>(null);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const speechQueueRef = useRef<AssistantSpeechQueue | null>(null);
  speechQueueRef.current ??= new AssistantSpeechQueue({
    onPlaybackStarted: () => {
      setSpeaking(true);
      const startedAt = turnStartedAtRef.current;
      if (startedAt !== null) {
        setMetrics((m) => ({
          ...m,
          timeToFirstAudioMs: Math.round(performance.now() - startedAt),
        }));
      }
    },
    onIdle: () => setSpeaking(false),
  });

  /**
   * Local speech activity was detected.
   *
   * This deliberately does two checks before doing anything. Speech while the
   * app is idle is ignored entirely, so an open microphone never sends requests
   * on its own; and only the first episode during a given turn acts, so talking
   * continuously cannot produce a stream of interruptions.
   *
   * When it does act it calls exactly the same interrupt path as the button.
   * There is no separate voice interruption mechanism on the server.
   */
  function handleSpeechDetected(): void {
    const queue = speechQueueRef.current!;
    // Nothing to interrupt: no turn running and nothing being spoken.
    if (!isSendingRef.current && !queue.isPlaying) return;
    if (voiceInterruptFiredRef.current) return;
    if (pendingVoiceInterruptRef.current !== null) return;

    const detectedAt = performance.now();

    // TIER 1 - perceived interruption. Stop what the user is hearing straight
    // away. Deliberately does NOT advance the generation: loudness alone is not
    // evidence that the user said anything.
    const dropped = queue.flush();
    setMetrics((m) => ({
      ...m,
      detectionToSilenceMs: Math.round(performance.now() - detectedAt),
      clipsDropped: dropped,
    }));

    pendingVoiceInterruptRef.current = { at: detectedAt };

    // With no recognition available there is no tier 2 to wait for, so the
    // loudness signal has to stand on its own. Stated plainly rather than
    // pretending the confirmation happened.
    if (!speech.supported) {
      confirmVoiceInterrupt("no speech recognition in this browser");
      return;
    }

    append({
      role: "notice",
      text:
        `Loudness detected — assistant audio stopped immediately${dropped > 0 ? ` and ${dropped} queued clip(s) discarded` : ""}. ` +
        "The conversation has NOT changed yet: waiting for speech recognition to confirm this was really speech.",
    });

    confirmTimerRef.current = setTimeout(() => {
      confirmTimerRef.current = null;
      pendingVoiceInterruptRef.current = null;
      append({
        role: "notice",
        text:
          `No speech recognised within ${VOICE_CONFIRM_TIMEOUT_MS} ms — treated as background noise. ` +
          "The generation was NOT advanced and the turn is untouched.",
      });
    }, VOICE_CONFIRM_TIMEOUT_MS);
  }

  /**
   * TIER 2 - confirmation.
   *
   * Recognised words prove the loudness was speech. Only now does the
   * conversation actually change: this is the point at which the generation
   * advances and outstanding work becomes stale.
   */
  function confirmVoiceInterrupt(reason: string): void {
    const pending = pendingVoiceInterruptRef.current;
    if (pending === null) return;

    pendingVoiceInterruptRef.current = null;
    if (confirmTimerRef.current !== null) {
      clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = null;
    }

    setMetrics((m) => ({
      ...m,
      vadToConfirmedMs: Math.round(performance.now() - pending.at),
    }));

    if (voiceInterruptFiredRef.current) return;
    voiceInterruptFiredRef.current = true;

    append({
      role: "notice",
      text:
        `Speech confirmed (${reason}) — interruption requested. The generation advances now, ` +
        "on confirmed speech, not when the noise was first heard.",
    });

    void handleInterrupt();
  }

  /**
   * A complete utterance was recognised.
   *
   * If a turn is already running, this speech is what interrupted it, so the
   * transcript is queued and sent as the *next* turn once the superseded one
   * settles. That is the whole point of the project in one interaction: the
   * user talks over the assistant, the old work is fenced, and what they
   * actually said becomes the live request.
   */
  function handleFinalTranscript(text: string): void {
    if (text.length === 0) return;

    if (isSendingRef.current) {
      queuedTranscriptRef.current = text;
      return;
    }
    void submitMessage(text);
  }

  const voice = useVoiceActivity(handleSpeechDetected);
  const speech = useSpeechRecognition({
    onFinal: handleFinalTranscript,
    onRecognisedActivity: () => confirmVoiceInterrupt("words recognised"),
  });

  useEffect(() => {
    endOfListRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isSending]);

  // Ask the server once whether speech output is configured. A false answer is
  // a normal zero-cost setup, not a fault.
  useEffect(() => {
    fetchHealth()
      .then((health) => {
        ttsAvailableRef.current = health.ttsAvailable;
        setTtsAvailable(health.ttsAvailable);
        setSpeechInfo(health.speech);
      })
      .catch(() => {
        ttsAvailableRef.current = false;
        setTtsAvailable(false);
      });
  }, []);

  // Send whatever was said during an interrupted turn, once that turn settles.
  useEffect(() => {
    if (isSending) return;
    const queued = queuedTranscriptRef.current;
    if (queued === null) return;
    queuedTranscriptRef.current = null;
    void submitMessage(queued);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSending]);

  // Re-arm the one-shot voice interrupt once a turn settles.
  //
  // `isSendingRef` is deliberately NOT written here. `submitMessage` owns it and
  // sets it synchronously, and the effect above can start a new turn during this
  // same commit - so assigning the previous render's value here would clobber
  // the ref back to false while a turn was genuinely in flight, silently
  // disabling voice interruption for it.
  useEffect(() => {
    if (!isSending) {
      voiceInterruptFiredRef.current = false;
      voice.rearm();
    }
  }, [isSending, voice]);

  // Poll only while a turn is in flight, so slow mock tools are visible as they
  // run. It stops the moment the turn settles - there is no idle polling.
  useEffect(() => {
    if (!isSending) return;
    const timer = setInterval(() => void refreshActivity(), 700);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSending]);

  function append(message: Omit<DisplayMessage, "id">): number {
    const id = nextId.current++;
    setMessages((current) => [...current, { ...message, id }]);
    return id;
  }

  /**
   * Pulls the server's event record after a lifecycle transition.
   *
   * No polling: it runs when something has actually happened. A failure here is
   * swallowed because the timeline is a view, not a source of truth - losing it
   * must never interfere with the conversation.
   */
  async function refreshActivity(): Promise<void> {
    const id = conversationId.current;
    if (id === undefined) return;

    try {
      const activity = await fetchActivity(id);
      setEvents(activity.events);
      setGeneration(activity.currentGeneration);
    } catch {
      // Intentionally ignored - observability only.
    }
  }

  function markSuperseded(messageId: number): void {
    setMessages((current) =>
      current.map((message) =>
        message.id === messageId ? { ...message, superseded: true } : message,
      ),
    );
  }

  /**
   * Silences the assistant and abandons any synthesis in progress.
   *
   * Presentation only. Nothing waits on this and nothing checks that it worked;
   * whether a reply may exist at all was already settled server-side.
   */
  function stopAssistantAudio(): number {
    ttsAbortRef.current?.abort();
    const dropped = speechQueueRef.current?.flush() ?? 0;
    setSpeaking(false);
    return dropped;
  }

  /**
   * Speaks a reply that has already been committed.
   *
   * Every failure path here is deliberately quiet: a missing credential, a
   * refused autoplay or a broken clip costs the audio and nothing else. The
   * text is already in the conversation and stays there.
   */
  async function speakAssistantReply(text: string, generation: number): Promise<void> {
    if (ttsAvailableRef.current === false) return;

    const conversation = conversationId.current;
    if (conversation === undefined) return;

    // Prepare before chunking, so clause boundaries fall on speech-ready text
    // rather than on markdown the synthesiser would have pronounced.
    const clauses = splitIntoClauses(prepareForSpeech(text));
    if (clauses.length === 0) return;

    const queue = speechQueueRef.current!;
    // Anything still queued from an earlier generation becomes inaudible here.
    queue.setGeneration(generation);

    const controller = new AbortController();
    ttsAbortRef.current = controller;

    try {
      // Clause by clause: playback can start after the first one, and the next
      // is fetched while the previous plays.
      for (const clause of clauses) {
        if (controller.signal.aborted) return;

        const outcome = await synthesizeSpeech(clause, controller.signal, {
          conversationId: conversation,
          generation,
        });

        if (outcome.kind === "unavailable") {
          ttsAvailableRef.current = false;
          setTtsAvailable(false);
          setVoiceOutputNote(outcome.reason);
          return;
        }

        // The server declined because the turn was superseded. Expected during
        // an interruption, and not a fault.
        if (outcome.kind === "superseded") return;

        if (outcome.kind === "failed") {
          setVoiceOutputNote(outcome.reason);
          return;
        }

        setVoiceOutputNote(null);
        if (outcome.upstreamMs !== null) {
          setMetrics((m) => ({ ...m, lastRimeUpstreamMs: outcome.upstreamMs }));
        }

        // Refused when the generation has moved on: stop fetching the rest.
        if (!queue.enqueue(generation, outcome.blob)) return;
      }
    } finally {
      if (ttsAbortRef.current === controller) ttsAbortRef.current = null;
      if (queue.autoplayBlocked) {
        setVoiceOutputNote(
          "The browser blocked audio playback until you interact with the page. Click anywhere, then send again.",
        );
      }
    }
  }

  /** Sends one turn. Shared by the composer and by recognised speech. */
  async function submitMessage(rawMessage: string): Promise<void> {
    const message = rawMessage.trim();
    if (message.length === 0 || isSendingRef.current) return;

    conversationId.current ??= crypto.randomUUID();

    // A new request supersedes anything still being spoken.
    stopAssistantAudio();

    setError(null);
    const userMessageId = append({ role: "user", text: message });
    setIsSending(true);
    // Set synchronously as well as in the effect, so speech recognised moments
    // later sees the turn as in flight rather than starting a second one.
    isSendingRef.current = true;

    let committedReply: { text: string; generation: number } | null = null;
    turnStartedAtRef.current = performance.now();

    try {
      const outcome = await sendChatMessage(message, conversationId.current);

      if (outcome.kind === "superseded") {
        // The reply finished after the conversation had moved on. The server
        // did not append this turn, so neither half of it is part of the
        // transcript - the user message is marked discarded to match.
        markSuperseded(userMessageId);
        setGeneration(outcome.currentGeneration);
        append({
          role: "notice",
          text:
            `Reply for generation ${outcome.resultGeneration} was fenced as stale ` +
            `(current generation is ${outcome.currentGeneration}) and was not added ` +
            `to the conversation.`,
        });
        return;
      }

      conversationId.current = outcome.conversationId;
      setGeneration(outcome.generation);
      append({
        role: "assistant",
        text: outcome.message,
        generation: outcome.generation,
      });
      committedReply = { text: outcome.message, generation: outcome.generation };
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setIsSending(false);
      isSendingRef.current = false;
      void refreshActivity();
    }

    // Only a committed reply is spoken, and only after it is committed. A
    // superseded or failed turn produces no audio at all.
    if (committedReply !== null) {
      await speakAssistantReply(committedReply.text, committedReply.generation);
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const message = input;
    setInput("");
    await submitMessage(message);
  }

  async function handleInterrupt() {
    const id = conversationId.current;
    if (id === undefined) return;

    // Silence the assistant first so the user hears the effect immediately.
    // This is comfort, not correctness - the generation bump below is what
    // actually makes the outstanding work obsolete.
    const dropped = stopAssistantAudio();
    const requestedAt = performance.now();

    try {
      const result = await requestInterrupt(id);
      setMetrics((m) => ({
        ...m,
        interruptRoundTripMs: Math.round(performance.now() - requestedAt),
        clipsDropped: dropped > 0 ? dropped : m.clipsDropped,
      }));
      setGeneration(result.generation);
      // Everything older than this is now inaudible as well as uncommittable.
      speechQueueRef.current?.setGeneration(result.generation);

      // The boundary marker. Not an assistant turn, and the server records the
      // same marker in its transcript, excluded from what the provider is sent.
      append({
        role: "interruption",
        text: "interrupted by user here",
        generation: result.generation,
      });

      append({
        role: "notice",
        text:
          `Generation advanced to ${result.generation}. Cancellation was requested for ` +
          `${result.cancellationRequested} in-flight request(s) - advisory only, so the ` +
          `reply may still arrive and will be discarded.`,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      void refreshActivity();
    }
  }

  /**
   * One control for both microphone consumers.
   *
   * The energy detector provides the fast interruption signal; speech
   * recognition provides the words. They are independent - recognition being
   * unsupported does not stop voice interruption from working.
   */
  function toggleListening(): void {
    if (voice.status === "listening") {
      voice.stop();
      speech.stop();
      return;
    }

    void voice.start();
    if (speech.supported) speech.start();
  }

  const activeTool = isSending ? runningTool(events) : null;
  const listening = voice.status === "listening";

  return (
    <div className="page">
      <nav className="nav">
        <span className="nav__brand">InterruptSafe</span>
        <div className="nav__links">
          <a className="nav__link" href="#conversation">
            Conversation
          </a>
          <a className="nav__link" href="#provider">
            Provider
          </a>
          <a className="nav__link" href="#activity">
            Activity
          </a>
        </div>
        <span
          className="generation generation--current nav__generation"
          title="Current conversation generation. Advances on every new user turn and on every interruption."
        >
          {generation === null ? "no generation yet" : `generation ${generation}`}
        </span>
      </nav>

      <main className="shell">
        <header className="hero">
          <p className="hero__eyebrow">
            For a driver — hands on the wheel, eyes on the road
          </p>
          <h1>Change your mind mid-sentence. It keeps up.</h1>
          <p className="tagline">
            Old work may keep running, but old work can never commit its result
            once its generation has been superseded. Advancing the generation is
            the correctness mechanism; cancellation is only ever requested, never
            relied upon.
          </p>
        </header>

        {listening || speaking || voiceOutputNote !== null ? (
          <section className="voicebar" aria-label="Voice status">
            {listening ? (
              <div
                className={"voicebar__row" + (voice.loud ? " voicebar__row--active" : "")}
              >
                <span className="voicebar__badge">🎤 Listening</span>
                {!speech.supported ? (
                  <span className="voicebar__hint">
                    ⚠️ Speech recognition is unsupported in this browser. Voice can
                    still interrupt; type to send messages.
                  </span>
                ) : speech.status === "denied" ? (
                  <span className="voicebar__hint">
                    ⚠️ Speech recognition permission denied.
                  </span>
                ) : speech.interim.length > 0 ? (
                  <span className="voicebar__transcript">“{speech.interim}”</span>
                ) : (
                  <span className="voicebar__hint">
                    Speak — recognised words appear here, then become a message.
                  </span>
                )}
              </div>
            ) : null}

            {speaking ? (
              <div className="voicebar__row voicebar__row--speaking">
                <span className="voicebar__badge">🔊 Assistant speaking</span>
                <span className="voicebar__hint">
                  Speak, or press Interrupt, to cut it off.
                </span>
              </div>
            ) : null}

            {voiceOutputNote !== null ? (
              <div className="voicebar__row voicebar__row--warn">
                <span className="voicebar__badge">⚠️ Voice output unavailable</span>
                <span className="voicebar__hint">{voiceOutputNote}</span>
              </div>
            ) : null}
          </section>
        ) : null}

        <section className="panel--dark" id="conversation">
          <div className="section-head">
            <h2>Speak. Interrupt. Stay correct.</h2>
            <p>
              Every turn is stamped with the generation that was current when it
              started. A reply that arrives after the user has moved on is shown
              struck through and never enters the transcript.
            </p>
          </div>

          <div className="conversation">
            {messages.length === 0 && !isSending ? (
              <p className="empty">Send a message to start.</p>
            ) : null}

            {messages.map((message) =>
              message.role === "interruption" ? (
                <div key={message.id} className="interruption-marker" role="separator">
                  <span className="interruption-marker__label">
                    [{message.text}]
                    {message.generation !== undefined
                      ? ` → generation ${message.generation}`
                      : null}
                  </span>
                </div>
              ) : message.role === "notice" ? (
                <p key={message.id} className="notice" role="status">
                  {message.text}
                </p>
              ) : (
                <article
                  key={message.id}
                  className={
                    `message message--${message.role}` +
                    (message.superseded === true ? " message--superseded" : "")
                  }
                >
                  <span className="message__role">
                    {message.role === "user" ? "You" : "Assistant"}
                    {message.generation !== undefined ? (
                      <span
                        className="generation"
                        title="Generation this turn was processed under"
                      >
                        gen {message.generation}
                      </span>
                    ) : null}
                    {message.superseded === true ? (
                      <span className="generation generation--stale">not committed</span>
                    ) : null}
                  </span>
                  <p className="message__text">{message.text}</p>
                </article>
              ),
            )}

            {isSending ? (
              activeTool !== null ? (
                <p className="pending pending--tool" role="status">
                  Mock tool running: <strong>{activeTool}</strong>
                  {generation !== null ? (
                    <span className="generation">gen {generation}</span>
                  ) : null}
                </p>
              ) : (
                <p className="pending" role="status">
                  Waiting for a response…
                </p>
              )
            ) : null}

            <div ref={endOfListRef} />
          </div>
        </section>

        {error !== null ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}

        <form className="composer" onSubmit={handleSubmit}>
          <button
            type="button"
            className={
              "button--mic" +
              (voice.status === "listening" ? " button--mic-live" : "") +
              (voice.loud ? " button--mic-loud" : "")
            }
            onClick={toggleListening}
            disabled={
              voice.status === "starting" ||
              voice.status === "denied" ||
              voice.status === "unavailable"
            }
            title={MIC_TITLES[voice.status]}
            aria-label={MIC_TITLES[voice.status]}
          >
            {voice.status === "listening" ? (
              <>
                <span className="mic-dot" aria-hidden="true" />
                {voice.loud ? "Voice detected" : "Listening"}
              </>
            ) : (
              MIC_LABELS[voice.status]
            )}
          </button>
          <input
            type="text"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Type a message"
            aria-label="Message"
            autoComplete="off"
            disabled={isSending}
          />
          {isSending ? (
            <button type="button" className="button--interrupt" onClick={handleInterrupt}>
              Interrupt
            </button>
          ) : null}
          <button type="submit" disabled={isSending || input.trim().length === 0}>
            {isSending ? "Sending…" : "Send"}
          </button>
        </form>

        <div className="grid-2">
          <section className="card" id="provider">
            <h2>Speech provider</h2>
            {speechInfo === null ? (
              <p className="empty">Checking…</p>
            ) : speechInfo.provider === "rime" ? (
              <p className="provider provider--active">
                <strong>Rime</strong>
                <span className="provider__detail">
                  model {speechInfo.model} · voice {speechInfo.speaker} ·{" "}
                  {speechInfo.language} · {speechInfo.audioFormat} ·{" "}
                  {speechInfo.endpoint}
                </span>
              </p>
            ) : (
              <p className="provider provider--none">
                <strong>None</strong>
                <span className="provider__detail">
                  No Rime credential configured — the app runs in text mode. There is
                  no fallback synthesiser; nothing else speaks in Rime's place.
                </span>
              </p>
            )}
          </section>

          <section className="card">
            <h2>Measured this session</h2>
            <p className="card__caveat">
              Browser-side timings via <code>performance.now()</code>. They exclude
              audio device output latency. Rime request duration is measured
              server-side and includes network time — it is not time-to-first-byte.
              Blank means not yet observed.
            </p>
            <dl className="metrics">
              <dt>Turn → first audio</dt>
              <dd>{fmtMs(metrics.timeToFirstAudioMs)}</dd>
              <dt>Loudness → audio stopped</dt>
              <dd>{fmtMs(metrics.detectionToSilenceMs)}</dd>
              <dt>Loudness → speech confirmed</dt>
              <dd>{fmtMs(metrics.vadToConfirmedMs)}</dd>
              <dt>Interrupt round trip</dt>
              <dd>{fmtMs(metrics.interruptRoundTripMs)}</dd>
              <dt>Rime request (server-side)</dt>
              <dd>{fmtMs(metrics.lastRimeUpstreamMs)}</dd>
              <dt>Queued clips discarded</dt>
              <dd>
                {metrics.clipsDropped === null ? "—" : String(metrics.clipsDropped)}
              </dd>
            </dl>
          </section>
        </div>

        <section className="panel--dark" id="activity">
          <div className="section-head">
            <h2>What the server actually recorded</h2>
            <p>
              Lifecycle events grouped by generation. Observability only — nothing
              reads them back to decide anything.
            </p>
          </div>

          {events.length === 0 ? (
            <p className="empty">
              Lifecycle events recorded by the server will appear here.
            </p>
          ) : (
            groupByGeneration(events).map((group, index) => (
              <div
                className="activity__group"
                key={`${group.generation ?? "none"}-${index}`}
              >
                <h3 className="activity__generation">
                  {group.generation === undefined
                    ? "no generation"
                    : `generation ${group.generation}`}
                </h3>
                <ul className="activity__events">
                  {group.events.map((event) => (
                    <li
                      key={event.id}
                      className={
                        "activity__event" +
                        (INTERRUPTED_EVENTS.has(event.type)
                          ? " activity__event--interrupted"
                          : "")
                      }
                    >
                      <span className="activity__label">{EVENT_LABELS[event.type]}</span>
                      <span className="activity__detail">{event.detail}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </section>
      </main>

      <footer className="footer">
        <div className="footer__inner">
          <p className="footer__note">
            A full-duplex voice agent that never continues an outdated
            conversation. Speech recognition runs in the browser and is free;
            speech output is optional.
          </p>

          <div className="footer__col">
            <h3>On this page</h3>
            <ul>
              <li>
                <a href="#conversation">Conversation</a>
              </li>
              <li>
                <a href="#provider">Speech provider</a>
              </li>
              <li>
                <a href="#activity">Activity</a>
              </li>
            </ul>
          </div>

          <div className="footer__col">
            <h3>Endpoints</h3>
            <ul>
              <li>
                <a href="/api/health">GET /api/health</a>
              </li>
              <li>
                <span>POST /api/chat</span>
              </li>
              <li>
                <span>POST /api/interrupt</span>
              </li>
              <li>
                <span>POST /api/tts</span>
              </li>
            </ul>
          </div>

          <div className="footer__col">
            <h3>Third party</h3>
            <ul>
              <li>
                <a href="https://docs.rime.ai" target="_blank" rel="noreferrer">
                  Rime — speech output
                </a>
              </li>
              <li>
                <span>Web Speech API — recognition</span>
              </li>
              <li>
                <span>No other service is contacted</span>
              </li>
            </ul>
          </div>
        </div>

        <div className="footer__wordmark" aria-hidden="true">
          InterruptSafe
        </div>
      </footer>
    </div>
  );
}
