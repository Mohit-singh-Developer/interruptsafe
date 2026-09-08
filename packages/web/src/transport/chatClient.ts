import type {
  ApiErrorResponse,
  ChatOkResponse,
  ChatRequest,
  ChatSupersededResponse,
  ConversationActivityResponse,
  HealthResponse,
  InterruptRequest,
  InterruptResponse,
  TtsRequest,
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

/** Reads server capabilities, chiefly whether speech output is configured. */
export async function fetchHealth(): Promise<HealthResponse> {
  const response = await fetch("/api/health");
  if (!response.ok) throw new Error(`Health check failed with ${response.status}.`);
  return (await response.json()) as HealthResponse;
}

/**
 * Outcome of asking the server to synthesise speech.
 *
 * `unavailable` means no Rime credential is configured, which is a normal
 * zero-cost setup rather than a fault. Both non-audio outcomes are presentation
 * problems only: the assistant's text has already been committed server-side
 * and is unaffected.
 */
export type SpeechOutcome =
  | {
      readonly kind: "audio";
      readonly blob: Blob;
      /** Server-measured Rime request duration in ms, when reported. */
      readonly upstreamMs: number | null;
    }
  | { readonly kind: "superseded" }
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "failed"; readonly reason: string };

export async function synthesizeSpeech(
  text: string,
  signal: AbortSignal,
  stamp?: { conversationId: string; generation: number },
): Promise<SpeechOutcome> {
  const body: TtsRequest =
    stamp === undefined
      ? { text }
      : { text, conversationId: stamp.conversationId, generation: stamp.generation };

  let response: Response;
  try {
    response = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (signal.aborted) return { kind: "failed", reason: "Superseded before playback." };
    return { kind: "failed", reason: "Could not reach the speech endpoint." };
  }

  if (response.status === 503) {
    const payload = (await response.json().catch(() => null)) as ApiErrorResponse | null;
    return { kind: "unavailable", reason: payload?.error ?? "Speech output is not configured." };
  }

  // The server declined to synthesise because the turn was already superseded.
  if (response.status === 409) return { kind: "superseded" };

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as ApiErrorResponse | null;
    return { kind: "failed", reason: payload?.error ?? `Speech failed (${response.status}).` };
  }

  const upstreamHeader = response.headers.get("X-Rime-Upstream-Ms");
  const upstreamMs = upstreamHeader === null ? null : Number(upstreamHeader);

  return {
    kind: "audio",
    blob: await response.blob(),
    upstreamMs: Number.isFinite(upstreamMs) ? upstreamMs : null,
  };
}
