import type { FastifyInstance } from "fastify";
import {
  MAX_CHAT_MESSAGE_LENGTH,
  type ApiErrorResponse,
  type ChatResponse,
  type HealthResponse,
} from "@interruptsafe/shared";
import type { LlmProvider } from "../agent/llmProvider";
import { isValidConversationId, type ConversationStore } from "../session/conversationState";

/**
 * HTTP routes.
 *
 * The server now owns conversation history through `ConversationState`. The
 * browser still keeps a message list, but only for display - the authoritative
 * transcript, and the one the provider is shown, lives on the server.
 *
 * These routes are provider-agnostic. They depend only on the `LlmProvider`
 * interface and contain no provider-specific logic.
 */

type Validated =
  | { ok: true; message: string; conversationId?: string }
  | { ok: false; error: string };

/**
 * Validates the chat request body. Returns the trimmed message so the provider
 * never sees surrounding whitespace.
 */
function validateChatBody(body: unknown): Validated {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: "Request body must be a JSON object." };
  }

  const { message, conversationId } = body as Record<string, unknown>;

  if (typeof message !== "string") {
    return { ok: false, error: "Field 'message' is required and must be a string." };
  }

  const trimmed = message.trim();

  if (trimmed.length === 0) {
    return { ok: false, error: "Field 'message' must not be empty." };
  }

  if (trimmed.length > MAX_CHAT_MESSAGE_LENGTH) {
    return {
      ok: false,
      error: `Field 'message' must be at most ${MAX_CHAT_MESSAGE_LENGTH} characters.`,
    };
  }

  if (conversationId === undefined) {
    return { ok: true, message: trimmed };
  }

  if (typeof conversationId !== "string" || !isValidConversationId(conversationId)) {
    return {
      ok: false,
      error:
        "Field 'conversationId' must be a string of 1-100 characters " +
        "using letters, digits, hyphens or underscores.",
    };
  }

  return { ok: true, message: trimmed, conversationId };
}

export function registerRoutes(
  app: FastifyInstance,
  provider: LlmProvider,
  conversations: ConversationStore,
): void {
  app.get("/api/health", async (): Promise<HealthResponse> => {
    return {
      status: "ok",
      service: "interruptsafe-server",
      phase: 3,
      uptimeSeconds: Number(process.uptime().toFixed(3)),
      timestamp: new Date().toISOString(),
    };
  });

  app.post(
    "/api/chat",
    async (request, reply): Promise<ChatResponse | ApiErrorResponse> => {
      const validated = validateChatBody(request.body);

      if (!validated.ok) {
        reply.code(400);
        return { error: validated.error };
      }

      const conversationId = conversations.resolve(validated.conversationId);

      // The new turn is appended to a copy for the provider, not to the store.
      // Nothing is committed until a reply actually arrives, so a failed request
      // cannot leave a dangling user message in the transcript.
      const turns = [
        ...conversations.history(conversationId),
        { role: "user" as const, content: validated.message },
      ];

      try {
        const result = await provider.generate({ messages: turns });
        conversations.appendExchange(conversationId, validated.message, result.message);
        return { message: result.message, conversationId };
      } catch (error) {
        // Upstream failure (network, auth, rate limit). Details go to the log;
        // the client gets a generic message so nothing sensitive is echoed back.
        request.log.error({ err: error }, "Provider failed to generate a reply");
        reply.code(502);
        return { error: "The language model provider failed to respond." };
      }
    },
  );
}
