import { useEffect, useRef, useState, type FormEvent } from "react";
import { sendChatMessage } from "./transport/chatClient";

/**
 * InterruptSafe web client - Phase 2.
 *
 * A minimal text conversation: type a message, send it over HTTP, display the
 * reply. The message list here is display state only - the backend is stateless
 * and no history is sent with a request. There is no microphone, no audio, and
 * no interruption control yet.
 */

interface DisplayMessage {
  id: number;
  role: "user" | "assistant";
  text: string;
}

export function App() {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nextId = useRef(0);
  const endOfListRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endOfListRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isSending]);

  const append = (role: DisplayMessage["role"], text: string) => {
    setMessages((current) => [...current, { id: nextId.current++, role, text }]);
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
      const reply = await sendChatMessage(message);
      append("assistant", reply);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setIsSending(false);
    }
  }

  return (
    <main className="shell">
      <header>
        <h1>InterruptSafe</h1>
        <p className="tagline">
          Phase 2 - text conversation over HTTP, answered by a deterministic
          mock provider. No language model is called.
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
