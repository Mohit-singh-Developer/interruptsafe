import type { FastifyInstance } from "fastify";
import {
  MAX_CHAT_MESSAGE_LENGTH,
  type ApiErrorResponse,
  type ChatResponse,
  type HealthResponse,
} from "@interruptsafe/shared";
import type { LlmProvider } from "../agent/llmProvider";

/**
 * HTTP routes.
 *
 * Phase 2 is stateless: each request is independent and the server keeps no
 * conversation history. The client holds the message list purely for display.
 * Server-side conversation state arrives in a later phase.
 */

type Validated =
  | { ok: true; message: string }
  | { ok: false; error: string };

/**
 * Validates the chat request body. Returns the trimmed message so the provider
 * never sees surrounding whitespace.
 */
function validateChatBody(body: unknown): Validated {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: "Request body must be a JSON object." };
  }

  const { message } = body as Record<string, unknown>;

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

  return { ok: true, message: trimmed };
}

export function registerRoutes(app: FastifyInstance, provider: LlmProvider): void {
  app.get("/api/health", async (): Promise<HealthResponse> => {
    return {
      status: "ok",
      service: "interruptsafe-server",
      phase: 2,
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

      const result = await provider.generate({ message: validated.message });
      return { message: result.message };
    },
  );
}
