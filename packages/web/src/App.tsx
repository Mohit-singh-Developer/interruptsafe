import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ConversationEvent } from "@interruptsafe/shared";
import {
  fetchActivity,
  requestInterrupt,
  sendChatMessage,
} from "./transport/chatClient";

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
};

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

  useEffect(() => {
    endOfListRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isSending]);

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

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();

    const message = input.trim();
    if (message.length === 0 || isSending) return;

    conversationId.current ??= crypto.randomUUID();

    setInput("");
    setError(null);
    const userMessageId = append({ role: "user", text: message });
    setIsSending(true);

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
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setIsSending(false);
      void refreshActivity();
    }
  }

  async function handleInterrupt() {
    const id = conversationId.current;
    if (id === undefined) return;

    try {
      const result = await requestInterrupt(id);
      setGeneration(result.generation);

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

  return (
    <main className="shell">
      <header>
        <div className="header-row">
          <h1>InterruptSafe</h1>
          <span
            className="generation generation--current"
            title="Current conversation generation. Advances on every new user turn and on every interruption."
          >
            {generation === null ? "no generation yet" : `generation ${generation}`}
          </span>
        </div>
        <p className="tagline">
          Advancing the generation is what invalidates outstanding work.
          Cancellation is only ever requested, never relied upon.
        </p>
      </header>

      <section className="conversation" aria-label="Conversation">
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
          <p className="pending" role="status">
            Waiting for a response…
          </p>
        ) : null}

        <div ref={endOfListRef} />
      </section>

      {error !== null ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}

      <form className="composer" onSubmit={handleSubmit}>
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

      <section className="activity" aria-label="Conversation activity">
        <h2>Conversation activity</h2>

        {events.length === 0 ? (
          <p className="empty">
            Lifecycle events recorded by the server will appear here.
          </p>
        ) : (
          groupByGeneration(events).map((group, index) => (
            <div className="activity__group" key={`${group.generation ?? "none"}-${index}`}>
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
                      (event.type === "result-fenced" ||
                      event.type === "interruption-requested" ||
                      event.type === "provider-failed"
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
  );
}
