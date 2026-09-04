import type {
  ApiErrorResponse,
  ChatOkResponse,
  ChatRequest,
  ChatSupersededResponse,
  ConversationActivityResponse,
  InterruptRequest,
  InterruptResponse,
} from "@interruptsafe/shared";

/**
 * HTTP client for the conversation and interruption endpoints.
 *
 * A turn has three possible shapes, and the caller must be able to tell them
 * apart without reading error text: it committed, it was superseded, or it
 * failed. The first two are returned as a discriminated union; only a genuine
 * failure throws.
 *
 * Note that the in-flight `fetch` is deliberately *not* aborted when the user
 * interrupts. The architecture permits aborting it as a client-side
 * convenience, but letting the response arrive is what makes the superseded
 * outcome visible - which is the behaviour worth showing.
 */

export type ChatOutcome =
  | {
      readonly kind: "ok";
      readonly message: string;
      readonly conversationId: string;
      readonly generation: number;
    }
  | {
      readonly kind: "superseded";
      readonly conversationId: string;
      readonly resultGeneration: number;
      readonly currentGeneration: number;
    };

export async function sendChatMessage(
  message: string,
  conversationId?: string,
): Promise<ChatOutcome> {
  const body: ChatRequest =
    conversationId === undefined ? { message } : { message, conversationId };

  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  // A non-JSON body is possible if something upstream fails, so parse defensively.
  const payload: unknown = await response.json().catch(() => null);

  // 409 means the turn finished after being superseded. Not an error - the work
  // simply was not allowed to affect the conversation.
  if (response.status === 409) {
    const superseded = payload as ChatSupersededResponse | null;
    if (
      superseded === null ||
      typeof superseded.resultGeneration !== "number" ||
      typeof superseded.currentGeneration !== "number" ||
      typeof superseded.conversationId !== "string"
    ) {
      throw new Error("Malformed superseded response from server.");
    }
    return {
      kind: "superseded",
      conversationId: superseded.conversationId,
      resultGeneration: superseded.resultGeneration,
      currentGeneration: superseded.currentGeneration,
    };
  }

  if (!response.ok) {
    const apiError = (payload as ApiErrorResponse | null)?.error;
    throw new Error(apiError ?? `Request failed with status ${response.status}.`);
  }

  const chat = payload as ChatOkResponse | null;
  if (
    chat === null ||
    typeof chat.message !== "string" ||
    typeof chat.conversationId !== "string" ||
    typeof chat.generation !== "number"
  ) {
    throw new Error("Malformed response from server.");
  }

  return {
    kind: "ok",
    message: chat.message,
    conversationId: chat.conversationId,
    generation: chat.generation,
  };
}

/**
 * Asks the server to advance the conversation's generation.
 *
 * The returned generation is the guaranteed outcome. `cancellationRequested`
 * reports how many outstanding requests were asked to stop, which is not a
 * promise that any of them did.
 */
export async function requestInterrupt(
  conversationId: string,
): Promise<InterruptResponse> {
  const body: InterruptRequest = { conversationId };

  const response = await fetch("/api/interrupt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const apiError = (payload as ApiErrorResponse | null)?.error;
    throw new Error(apiError ?? `Interrupt failed with status ${response.status}.`);
  }

  const result = payload as InterruptResponse | null;
  if (result === null || typeof result.generation !== "number") {
    throw new Error("Malformed interrupt response from server.");
  }

  return result;
}

/**
 * Reads the server's record of what happened in this conversation.
 *
 * Display only. The server remains authoritative, and nothing here feeds back
 * into a decision - a failed or stale read costs visibility, never correctness.
 */
export async function fetchActivity(
  conversationId: string,
): Promise<ConversationActivityResponse> {
  const response = await fetch(
    `/api/conversations/${encodeURIComponent(conversationId)}/activity`,
  );

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const apiError = (payload as ApiErrorResponse | null)?.error;
    throw new Error(apiError ?? `Activity read failed with status ${response.status}.`);
  }

  const activity = payload as ConversationActivityResponse | null;
  if (activity === null || !Array.isArray(activity.events)) {
    throw new Error("Malformed activity response from server.");
  }

  return activity;
}
