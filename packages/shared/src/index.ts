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

/** Success response body of `POST /api/chat`. */
export interface ChatResponse {
  message: string;
  /** Echoed back so the client can continue the same conversation. */
  conversationId: string;
}

/** Error response body used by any endpoint that rejects a request. */
export interface ApiErrorResponse {
  error: string;
}

/** Maximum accepted length of a chat message, in characters. */
export const MAX_CHAT_MESSAGE_LENGTH = 4000;
