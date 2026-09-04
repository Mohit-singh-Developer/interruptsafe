/**
 * Contracts shared between the InterruptSafe server and web client.
 *
 * This package is consumed as raw TypeScript source (see `exports` in
 * package.json) so there is no build step. Both `tsx` on the server and Vite in
 * the browser resolve `.ts` directly.
 *
 * Contains the health contract and a multi-turn chat contract. The generation
 * and interruption protocol types arrive in later phases.
 */

/** Response body of `GET /api/health`. */
export interface HealthResponse {
  status: "ok";
  service: "interruptsafe-server";
  /** Development phase this build corresponds to. */
  phase: number;
  /** Seconds since the server process started. */
  uptimeSeconds: number;
  /** ISO-8601 timestamp generated when the request was served. */
  timestamp: string;
}

/**
 * Request body of `POST /api/chat`.
 *
 * Generation stamps and interruption flags belong to later phases and must not
 * be added here until the phase that needs them.
 */
export interface ChatRequest {
  message: string;
  /**
   * Conversation to continue. Omit on the first turn; the server allocates an
   * id and returns it. An unrecognised id starts a fresh conversation under
   * that id rather than failing, so a client survives a server restart.
   */
  conversationId?: string;
}

/**
 * A reply that was still current when it finished, and was therefore committed
 * to the conversation. Served with HTTP 200.
 */
export interface ChatOkResponse {
  status: "ok";
  message: string;
  /** Echoed back so the client can continue the same conversation. */
  conversationId: string;
  /**
   * The conversation generation this turn was processed under.
   *
   * Advancing the generation is what invalidates older work, so surfacing the
   * stamp lets the client show which version of the conversation a reply
   * belongs to.
   */
  generation: number;
}

/**
 * A reply that finished *after* its generation had already been superseded.
 *
 * The work may well have completed successfully - it is not an error, and the
 * provider may have produced a perfectly good answer. It is simply no longer
 * allowed to affect the conversation, because the user has moved on. Nothing
 * was appended to the transcript. Served with HTTP 409.
 *
 * This is deliberately a separate shape rather than a flag on a success
 * response, so a client cannot mistake fenced work for an active result.
 */
export interface ChatSupersededResponse {
  status: "superseded";
  conversationId: string;
  /** Generation the fenced work was stamped with when it started. */
  resultGeneration: number;
  /** Generation that is current now, and which superseded it. */
  currentGeneration: number;
}

/** Response body of `POST /api/chat`, discriminated by `status`. */
export type ChatResponse = ChatOkResponse | ChatSupersededResponse;

/** Request body of `POST /api/interrupt`. */
export interface InterruptRequest {
  conversationId: string;
}

/** Response body of `POST /api/interrupt`. */
export interface InterruptResponse {
  conversationId: string;
  /** The new current generation. Everything older than this is now stale. */
  generation: number;
  /**
   * How many in-flight requests a cancellation was *requested* for.
   *
   * Advisory only. A provider may ignore the request and complete anyway; that
   * work is fenced when it tries to commit. This number says what was asked
   * for, never what was achieved.
   */
  cancellationRequested: number;
}

/**
 * Lifecycle transitions worth showing a person.
 *
 * These are observability only. Nothing in the system reads an event back to
 * decide anything: `GenerationManager` remains the authority on what is
 * current, and `fencedCommit` remains the only gate on what may be committed.
 * Deleting the whole event system would change what is visible, not what is
 * correct.
 */
export type ConversationEventType =
  | "turn-started"
  | "generation-advanced"
  | "interruption-requested"
  | "cancellation-requested"
  | "result-committed"
  | "result-fenced"
  | "provider-failed";

export interface ConversationEvent {
  id: string;
  conversationId: string;
  type: ConversationEventType;
  /** The generation this transition concerned, where one applies. */
  generation?: number;
  /** ISO-8601 timestamp, assigned server-side when the event was recorded. */
  at: string;
  /** Short human-readable summary. Never contains provider internals. */
  detail: string;
}

/**
 * A committed exchange, as shown in the transcript.
 *
 * Only exchanges that passed the fence appear here, which is the same set the
 * provider is shown.
 */
export interface TranscriptExchange {
  kind: "exchange";
  generation: number;
  user: string;
  assistant: string;
}

/**
 * A marker recording that the user interrupted at this point.
 *
 * Deliberately not an assistant turn. It is part of the transcript a person
 * reads, and is never included in the message list handed to the provider.
 */
export interface TranscriptInterruption {
  kind: "interruption";
  /** The generation the conversation moved to as a result. */
  generation: number;
  at: string;
}

export type TranscriptEntry = TranscriptExchange | TranscriptInterruption;

/** Response body of `GET /api/conversations/:conversationId/activity`. */
export interface ConversationActivityResponse {
  conversationId: string;
  /** The conversation's current generation at the time of reading. */
  currentGeneration: number;
  /** Oldest first. Bounded; the oldest entries are dropped as it fills. */
  events: ConversationEvent[];
  /** Oldest first. Committed exchanges plus interruption markers. */
  transcript: TranscriptEntry[];
}

/** Error response body used by any endpoint that rejects a request. */
export interface ApiErrorResponse {
  error: string;
}

/** Maximum accepted length of a chat message, in characters. */
export const MAX_CHAT_MESSAGE_LENGTH = 4000;
