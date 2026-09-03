import type {
  ApiErrorResponse,
  ChatRequest,
  ChatResponse,
} from "@interruptsafe/shared";

/**
 * HTTP client for the conversation endpoint.
 *
 * Sends one message and awaits one reply. The server owns the transcript, so
 * the only thing carried between turns is the conversation id. Streaming,
 * cancellation and generation stamps belong to later phases.
 */

export interface ChatReply {
  readonly message: string;
  readonly conversationId: string;
}

export async function sendChatMessage(
  message: string,
  conversationId?: string,
): Promise<ChatReply> {
  const body: ChatRequest =
    conversationId === undefined ? { message } : { message, conversationId };

  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  // A non-JSON body is possible if something upstream fails, so parse defensively.
  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const apiError = (payload as ApiErrorResponse | null)?.error;
    throw new Error(apiError ?? `Request failed with status ${response.status}.`);
  }

  const chat = payload as ChatResponse | null;
  if (
    chat === null ||
    typeof chat.message !== "string" ||
    typeof chat.conversationId !== "string"
  ) {
    throw new Error("Malformed response from server.");
  }

  return { message: chat.message, conversationId: chat.conversationId };
}
