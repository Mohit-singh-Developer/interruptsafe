import { useEffect, useRef, useState, type FormEvent } from "react";
import { sendChatMessage } from "./transport/chatClient";

/**
 * InterruptSafe web client.
 *
 * A minimal text conversation: type a message, send it over HTTP, display the
 * reply. The message list here is display state only - the server owns the
 * authoritative transcript, and the only thing carried between turns is the
 * conversation id.
 *
 * Each reply reports the generation its turn was processed under, which is
 * shown so the conversation's version is visible as it advances. There is no
 * microphone, no audio, and no interruption control yet.
 */

interface DisplayMessage {
  id: number;
  role: "user" | "assistant";
  text: string;
  /** Set on replies; the generation the turn was processed under. */
  generation?: number;
}

export function App() {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Latest generation reported by the server; null until the first reply.
  const [generation, setGeneration] = useState<number | null>(null);

  const nextId = useRef(0);
  const endOfListRef = useRef<HTMLDivElement>(null);
  // Allocated by the server on the first turn, then sent back on every turn.
  // Reloading the page starts a new conversation.
  const conversationId = useRef<string | undefined>(undefined);

  useEffect(() => {
    endOfListRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isSending]);

  const append = (
    role: DisplayMessage["role"],
    text: string,
    turnGeneration?: number,
  ) => {
    setMessages((current) => [
      ...current,
      { id: nextId.current++, role, text, generation: turnGeneration },
    ]);
  };

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();

    const message = input.trim();
    if (message.length === 0 || isSending) return;

    setInput("");
    setError(null);
    append("user", message);
    setIsSending(true);

    try {
      const reply = await sendChatMessage(message, conversationId.current);
      conversationId.current = reply.conversationId;
      setGeneration(reply.generation);
      append("assistant", reply.message, reply.generation);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setIsSending(false);
    }
  }

  return (
    <main className="shell">
      <header>
        <div className="header-row">
          <h1>InterruptSafe</h1>
          <span
            className="generation generation--current"
            title="Current conversation generation. Advances on every new user turn."
          >
            {generation === null ? "no generation yet" : `generation ${generation}`}
          </span>
        </div>
        <p className="tagline">
          Text conversation over HTTP. The server owns the transcript; the
          active provider is chosen by server configuration.
        </p>
      </header>

      <section className="conversation" aria-label="Conversation">
        {messages.length === 0 && !isSending ? (
          <p className="empty">Send a message to start.</p>
        ) : null}

        {messages.map((message) => (
          <article key={message.id} className={`message message--${message.role}`}>
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
            </span>
            <p className="message__text">{message.text}</p>
          </article>
        ))}

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
        <button type="submit" disabled={isSending || input.trim().length === 0}>
          {isSending ? "Sending…" : "Send"}
        </button>
      </form>
    </main>
  );
}
