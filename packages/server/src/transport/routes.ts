import type { FastifyInstance } from "fastify";
import {
  MAX_CHAT_MESSAGE_LENGTH,
  type ApiErrorResponse,
  type ChatResponse,
  type ConversationActivityResponse,
  type HealthResponse,
  type InterruptResponse,
} from "@interruptsafe/shared";
import type { LlmProvider } from "../agent/llmProvider";
import { isValidConversationId, type ConversationStore } from "../session/conversationState";
import { commitExchange } from "../session/fencedCommit";
import type { InFlightRegistry } from "../session/inFlightRegistry";

/**
 * HTTP routes.
 *
 * The server owns conversation history through `ConversationState`. The browser
 * keeps a message list, but only for display - the authoritative transcript,
 * and the one the provider is shown, lives on the server.
 *
 * These routes are provider-agnostic. They depend only on the `LlmProvider`
 * interface and contain no provider-specific logic.
 *
 * Two things happen to every turn here. It is stamped with the generation that
 * was current when it started, and when it finishes it must pass through
 * `commitExchange` before it can affect anything. The route itself holds no
 * cancellation logic and keeps no maps; that ownership lives in
 * `InFlightRegistry`.
 *
 * Lifecycle events are recorded alongside those steps for observability. They
 * are written from decisions that have already been made - never consulted to
 * make one - and the log they are written to is owned by `ConversationState`,
 * not by this module.
 */

type ValidatedChat =
  | { ok: true; message: string; conversationId?: string }
  | { ok: false; error: string };

type ValidatedInterrupt =
  | { ok: true; conversationId: string }
  | { ok: false; error: string };

const CONVERSATION_ID_ERROR =
  "Field 'conversationId' must be a string of 1-100 characters " +
  "using letters, digits, hyphens or underscores.";

/**
 * Validates the chat request body. Returns the trimmed message so the provider
 * never sees surrounding whitespace.
 */
function validateChatBody(body: unknown): ValidatedChat {
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
    return { ok: false, error: CONVERSATION_ID_ERROR };
  }

  return { ok: true, message: trimmed, conversationId };
}

/** Interruption always names a conversation - there is no implicit target. */
function validateInterruptBody(body: unknown): ValidatedInterrupt {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: "Request body must be a JSON object." };
  }

  const { conversationId } = body as Record<string, unknown>;

  if (typeof conversationId !== "string" || !isValidConversationId(conversationId)) {
    return { ok: false, error: CONVERSATION_ID_ERROR };
  }

  return { ok: true, conversationId };
}

export function registerRoutes(
  app: FastifyInstance,
  provider: LlmProvider,
  conversations: ConversationStore,
  inFlight: InFlightRegistry,
): void {
  app.get("/api/health", async (): Promise<HealthResponse> => {
    return {
      status: "ok",
      service: "interruptsafe-server",
      phase: 4,
      uptimeSeconds: Number(process.uptime().toFixed(3)),
      timestamp: new Date().toISOString(),
    };
  });

  /**
   * Conversation activity: the lifecycle events and the reader's transcript.
   *
   * Both are served together because the UI refreshes them as one view, and a
   * second endpoint would mean a second round trip for the same refresh.
   *
   * Read-only in the strict sense: it does not create the conversation and does
   * not disturb eviction order, so polling cannot allocate state or keep a dead
   * conversation alive. An unknown but well-formed id reads as an empty
   * conversation rather than an error, matching how unknown ids behave on chat.
   */
  app.get<{ Params: { conversationId: string } }>(
    "/api/conversations/:conversationId/activity",
    async (request, reply): Promise<ConversationActivityResponse | ApiErrorResponse> => {
      const { conversationId } = request.params;

      if (!isValidConversationId(conversationId)) {
        reply.code(400);
        return { error: CONVERSATION_ID_ERROR };
      }

      const snapshot = conversations.activity(conversationId);

      return {
        conversationId,
        currentGeneration: snapshot.currentGeneration,
        events: [...snapshot.events],
        transcript: [...snapshot.transcript],
      };
    },
  );

  /**
   * Interruption.
   *
   * Step 2 is the only step that has to succeed. Advancing the generation is a
   * local synchronous change that cannot fail partway, and from the moment it
   * returns every outstanding stamp is stale. Step 3 is a courtesy that saves
   * work; the response deliberately does not wait on it or depend on it.
   */
  app.post(
    "/api/interrupt",
    async (request, reply): Promise<InterruptResponse | ApiErrorResponse> => {
      const validated = validateInterruptBody(request.body);

      if (!validated.ok) {
        reply.code(400);
        return { error: validated.error };
      }

      // 1. Resolve the conversation.
      const conversationId = conversations.resolve(validated.conversationId);
      const events = conversations.eventsFor(conversationId);
      const generations = conversations.generationFor(conversationId);
      const outstanding = inFlight.countFor(conversationId);
      request.log.info({ conversationId, outstanding }, "Interruption requested");
      // Recorded against the generation being left behind, which is the one the
      // outstanding work belongs to.
      events.record(
        "interruption-requested",
        `User interrupted with ${outstanding} request(s) in flight.`,
        generations.now(),
      );

      // 2. Advance the generation. THIS is the correctness action.
      const generation = generations.bump("user-interruption");
      request.log.info(
        { conversationId, generation, reason: "user-interruption" },
        "Generation advanced",
      );
      events.record(
        "generation-advanced",
        "Advanced by user interruption. Outstanding work is now stale.",
        generation,
      );

      // Leave a marker in the transcript so the interruption boundary is
      // visible to a reader. It is not a turn and never reaches the provider.
      conversations.markInterruption(conversationId, generation);

      // 3. Ask outstanding work to stop. Advisory: it may be ignored, and any
      //    result that arrives anyway is fenced when it tries to commit.
      const cancellationRequested = inFlight.requestCancellation(conversationId);
      request.log.info(
        { conversationId, cancellationRequested },
        "Cancellation requested (advisory, not guaranteed)",
      );
      events.record(
        "cancellation-requested",
        `Cancellation requested for ${cancellationRequested} request(s). Advisory only - not relied upon.`,
        generation,
      );

      return { conversationId, generation, cancellationRequested };
    },
  );

  app.post(
    "/api/chat",
    async (request, reply): Promise<ChatResponse | ApiErrorResponse> => {
      const validated = validateChatBody(request.body);

      if (!validated.ok) {
        reply.code(400);
        return { error: validated.error };
      }

      const conversationId = conversations.resolve(validated.conversationId);

      // A new user turn advances the conversation to a new generation, which
      // invalidates any work still outstanding from the previous one. The
      // stamp is taken here, at the moment this unit of work is created.
      const generations = conversations.generationFor(conversationId);
      const events = conversations.eventsFor(conversationId);
      const generation = generations.bump("new-user-turn");
      request.log.info(
        { conversationId, generation, reason: "new-user-turn" },
        "Generation advanced",
      );
      events.record("generation-advanced", "Advanced by a new user turn.", generation);

      // The new turn is appended to a copy for the provider, not to the store.
      // Nothing is committed until the result has passed the generation check,
      // so neither a failure nor a superseded turn can leave a dangling user
      // message in the transcript.
      const turns = [
        ...conversations.history(conversationId),
        { role: "user" as const, content: validated.message },
      ];

      const handle = inFlight.register(conversationId, generation);
      request.log.info({ conversationId, generation }, "Provider work started");
      events.record("turn-started", "Provider work started for this turn.", generation);

      try {
        const result = await provider.generate({ messages: turns }, handle.signal);

        // The single door into the conversation. Synchronous, so the generation
        // cannot move between the check and the append.
        const outcome = commitExchange(
          conversations,
          conversationId,
          generation,
          validated.message,
          result.message,
        );

        if (!outcome.committed) {
          request.log.warn(
            {
              conversationId,
              resultGeneration: outcome.resultGeneration,
              currentGeneration: outcome.currentGeneration,
            },
            "Stale result fenced - not committed",
          );
          events.record(
            "result-fenced",
            `Reply for generation ${outcome.resultGeneration} discarded; the conversation is at generation ${outcome.currentGeneration}.`,
            outcome.resultGeneration,
          );
          reply.code(409);
          return {
            status: "superseded",
            conversationId,
            resultGeneration: outcome.resultGeneration,
            currentGeneration: outcome.currentGeneration,
          };
        }

        request.log.info(
          { conversationId, generation, provider: provider.name },
          "Result committed",
        );
        events.record(
          "result-committed",
          "Reply was still current and was committed to the conversation.",
          generation,
        );
        return { status: "ok", message: result.message, conversationId, generation };
      } catch (error) {
        // A provider that honours cancellation reports the abort as a failure.
        // Whether this is an abort or a genuine upstream fault, if the turn is
        // no longer current the honest answer is that it was superseded - and
        // either way nothing was appended.
        if (generations.isStale(generation)) {
          request.log.info(
            {
              conversationId,
              resultGeneration: generation,
              currentGeneration: generations.now(),
            },
            "Superseded work ended without committing",
          );
          events.record(
            "result-fenced",
            `Work for generation ${generation} ended without committing; the conversation is at generation ${generations.now()}.`,
            generation,
          );
          reply.code(409);
          return {
            status: "superseded",
            conversationId,
            resultGeneration: generation,
            currentGeneration: generations.now(),
          };
        }

        // Upstream failure (network, auth, rate limit). Details go to the log;
        // the client gets a generic message so nothing sensitive is echoed back.
        request.log.error({ err: error }, "Provider failed to generate a reply");
        // Deliberately generic: provider internals stay in the server log.
        events.record(
          "provider-failed",
          "The provider failed to produce a reply. Nothing was committed.",
          generation,
        );
        reply.code(502);
        return { error: "The language model provider failed to respond." };
      } finally {
        handle.release();
      }
    },
  );
}
