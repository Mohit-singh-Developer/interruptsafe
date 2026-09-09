import type { FastifyInstance } from "fastify";
import {
  MAX_CHAT_MESSAGE_LENGTH,
  MAX_TTS_TEXT_LENGTH,
  prepareForSpeech,
  type ApiErrorResponse,
  type ChatResponse,
  type ConversationActivityResponse,
  type HealthResponse,
  type InterruptResponse,
} from "@interruptsafe/shared";
import type { RimeClient } from "../tts/rimeClient";
import type { LlmProvider, LlmToolContext } from "../agent/llmProvider";
import { isValidConversationId, type ConversationStore } from "../session/conversationState";
import { commitExchange } from "../session/fencedCommit";
import type { InFlightRegistry } from "../session/inFlightRegistry";
import { dispatchTool } from "../tools/dispatch";
import { detectToolIntent } from "../tools/intent";
import type { ToolRegistry } from "../tools/tool";

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

type ValidatedTts =
  | { ok: true; text: string; conversationId?: string; generation?: number }
  | { ok: false; error: string };

/** Text to synthesise. Nothing else is accepted from the client. */
function validateTtsBody(body: unknown): ValidatedTts {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: "Request body must be a JSON object." };
  }

  const { text, conversationId, generation } = body as Record<string, unknown>;

  if (typeof text !== "string") {
    return { ok: false, error: "Field 'text' is required and must be a string." };
  }

  if (conversationId !== undefined) {
    if (typeof conversationId !== "string" || !isValidConversationId(conversationId)) {
      return { ok: false, error: CONVERSATION_ID_ERROR };
    }
  }

  if (generation !== undefined && (!Number.isInteger(generation) || (generation as number) < 0)) {
    return { ok: false, error: "Field 'generation' must be a non-negative whole number." };
  }

  const trimmed = text.trim();

  if (trimmed.length === 0) {
    return { ok: false, error: "Field 'text' must not be empty." };
  }

  if (trimmed.length > MAX_TTS_TEXT_LENGTH) {
    return {
      ok: false,
      error: `Field 'text' must be at most ${MAX_TTS_TEXT_LENGTH} characters.`,
    };
  }

  return {
    ok: true,
    text: trimmed,
    ...(typeof conversationId === "string" ? { conversationId } : {}),
    ...(typeof generation === "number" ? { generation } : {}),
  };
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
  tools: ToolRegistry,
  /** Absent when no Rime credential is configured. Voice output is optional. */
  rime: RimeClient | undefined,
): void {
  app.get("/api/health", async (): Promise<HealthResponse> => {
    return {
      status: "ok",
      service: "interruptsafe-server",
      uptimeSeconds: Number(process.uptime().toFixed(3)),
      timestamp: new Date().toISOString(),
      ttsAvailable: rime !== undefined,
      speech:
        rime === undefined
          ? { provider: "none" }
          : {
              provider: "rime",
              model: rime.model,
              speaker: rime.speaker,
              language: rime.language,
              audioFormat: rime.audioFormat,
              endpoint: rime.endpoint,
              transport: "HTTPS request/response per clause; audio to browser over the same HTTP origin",
            },
    };
  });

  /**
   * Speech synthesis.
   *
   * Kept entirely separate from `/api/chat` because it is a presentation
   * concern. It reads nothing from `ConversationState`, writes nothing to it,
   * and has no generation stamp - a reply is synthesised only *after* it has
   * already been committed, so nothing here can affect what the conversation
   * contains. A failure costs audio, never text.
   *
   * The client sends text and nothing else. It cannot select a voice or model,
   * and it certainly cannot supply a URL: the upstream endpoint is a constant
   * inside the Rime client.
   */
  app.post(
    "/api/tts",
    async (request, reply): Promise<ApiErrorResponse | undefined> => {
      if (rime === undefined) {
        reply.code(503);
        return {
          error:
            "Speech output is not configured on this server. Set RIME_API_KEY to enable it.",
        };
      }

      const validated = validateTtsBody(request.body);
      if (!validated.ok) {
        reply.code(400);
        return { error: validated.error };
      }

      // If the caller told us which turn this clause belongs to, skip work the
      // user has already moved past. This is a COST AND LATENCY OPTIMISATION,
      // not a correctness gate: the conversation was already settled by
      // `fencedCommit` before any text reached this endpoint.
      // Read-only lookup: this endpoint must not be able to allocate a
      // conversation, nor evict a live one, by naming an id that does not
      // exist. An unknown id simply forgoes the optimisation and speaks.
      const { conversationId, generation } = validated;
      const known = conversationId === undefined ? undefined : conversations.existing(conversationId);
      const events = known?.events;

      if (known !== undefined && generation !== undefined) {
        const generations = known.generation;
        if (generations.isStale(generation)) {
          request.log.info(
            { conversationId, resultGeneration: generation, currentGeneration: generations.now() },
            "Speech synthesis skipped - turn superseded",
          );
          events?.record(
            "tts-fenced",
            `Speech for generation ${generation} was not synthesised; the conversation is at generation ${generations.now()}.`,
            generation,
          );
          reply.code(409);
          return {
            status: "superseded",
            resultGeneration: generation,
            currentGeneration: generations.now(),
          } as unknown as ApiErrorResponse;
        }
      }

      // Stop synthesising if the browser goes away - for example because the
      // user interrupted. A saving, not a correctness measure.
      //
      // This listens on the RESPONSE stream, not the request. `request.raw`
      // emits "close" once the request body has been fully consumed, which
      // Fastify does before the handler runs - so listening there aborted every
      // synthesis a moment after it started. The response stream closes either
      // when we finish writing or when the peer disconnects, and
      // `writableFinished` distinguishes the two.
      const controller = new AbortController();
      reply.raw.on("close", () => {
        if (!reply.raw.writableFinished) controller.abort();
      });

      // Applied again here even though the client already prepared the text.
      // The server owns the Rime contract, and `prepareForSpeech` is idempotent,
      // so this costs nothing and guarantees no markdown or arrow ever reaches
      // the synthesiser regardless of what the caller sent.
      const spoken = prepareForSpeech(validated.text);
      // Emptiness is judged on letters and digits, not length: text that was
      // only markdown reduces to stray punctuation, which is not worth a
      // synthesis request and would be pronounced as noise.
      if (!/[a-z0-9]/i.test(spoken)) {
        reply.code(400);
        return { error: "Field 'text' contained nothing speakable." };
      }

      events?.record("tts-started", `Rime synthesis started (${rime.model}/${rime.speaker}).`, generation);

      try {
        const speech = await rime.synthesize(spoken, controller.signal);
        events?.record(
          "tts-audio-ready",
          `Rime returned ${speech.audio.byteLength} bytes in ${speech.upstreamMs} ms (request duration, includes network).`,
          generation,
        );
        reply.header("Content-Type", speech.contentType);
        reply.header("Cache-Control", "no-store");
        reply.header("X-Rime-Upstream-Ms", String(speech.upstreamMs));
        await reply.send(Buffer.from(speech.audio));
        return undefined;
      } catch (error) {
        events?.record(
          "tts-failed",
          "Rime synthesis failed. The committed text is unaffected.",
          generation,
        );
        // Only a message string is logged, never an error object that might
        // carry request details.
        request.log.error(
          { reason: error instanceof Error ? error.message : "unknown" },
          "Speech synthesis failed",
        );
        if (!reply.sent) {
          reply.code(502);
          return { error: "Speech synthesis failed." };
        }
        return undefined;
      }
    },
  );

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
        // A message may deterministically ask for a MOCK tool. The tool runs
        // first, and its result must pass its own fence before it is allowed to
        // shape the reply. That fence is an early exit, not the guarantee - the
        // reply still has to survive `commitExchange` below.
        let toolContext: LlmToolContext | undefined;
        const intent = detectToolIntent(validated.message);
        const tool = intent === null ? undefined : tools.get(intent.tool);

        if (intent !== null && tool !== undefined) {
          request.log.info(
            { conversationId, generation, tool: tool.name },
            "Mock tool started",
          );
          events.record(
            "tool-started",
            `Mock tool ${tool.name} started.`,
            generation,
            tool.name,
          );

          const outcome = await dispatchTool(
            tool,
            intent.input,
            generation,
            generations,
            handle.signal,
          );

          if (outcome.kind === "accepted") {
            events.record(
              "tool-completed",
              `Mock tool ${tool.name} returned: ${outcome.result.summary}.`,
              generation,
              tool.name,
            );
            toolContext = {
              tool: tool.name,
              summary: outcome.result.summary,
              rows: outcome.result.rows,
            };
          } else if (outcome.kind === "failed") {
            request.log.error(
              { conversationId, generation, tool: tool.name },
              "Mock tool failed",
            );
            events.record(
              "tool-failed",
              `Mock tool ${tool.name} failed. Nothing was committed.`,
              generation,
              tool.name,
            );
            reply.code(502);
            return { error: "The tool failed to produce a result." };
          } else {
            // Cancelled or stale: either way this turn has been superseded and
            // its work must not shape anything.
            const currentGeneration = generations.now();

            if (outcome.kind === "cancelled") {
              request.log.info(
                { conversationId, generation, tool: tool.name },
                "Mock tool honoured cancellation",
              );
              events.record(
                "tool-cancelled",
                `Mock tool ${tool.name} honoured the cancellation request and stopped early.`,
                generation,
                tool.name,
              );
            } else {
              request.log.warn(
                {
                  conversationId,
                  tool: tool.name,
                  resultGeneration: outcome.resultGeneration,
                  currentGeneration,
                },
                "Stale tool result fenced - not used",
              );
              events.record(
                "tool-result-fenced",
                `Mock tool ${tool.name} ignored cancellation and finished, but its result belonged to generation ${outcome.resultGeneration} while the conversation is at ${currentGeneration}. Discarded.`,
                outcome.resultGeneration,
                tool.name,
              );
            }

            reply.code(409);
            return {
              status: "superseded",
              conversationId,
              resultGeneration: generation,
              currentGeneration,
            };
          }
        }

        const result = await provider.generate(
          { messages: turns, ...(toolContext === undefined ? {} : { toolContext }) },
          handle.signal,
        );

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
          {
            conversationId,
            generation,
            provider: provider.name,
            // Present only when the provider declined on safety grounds. A
            // refusal is a successful response, so without this it would be
            // indistinguishable from an ordinary reply in the log.
            ...(result.refusalCategory === undefined
              ? {}
              : { refusalCategory: result.refusalCategory }),
          },
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
        //
        // Only named fields are logged, never the raw error object. A provider
        // SDK's error can carry arbitrary request and header material, and the
        // README states plainly that the API key is never written to the logs -
        // serialising whatever an SDK chose to attach would make that a claim
        // this code could not actually keep.
        request.log.error(
          {
            name: error instanceof Error ? error.name : "unknown",
            reason: error instanceof Error ? error.message : "unknown",
            stack: error instanceof Error ? error.stack : undefined,
          },
          "Provider failed to generate a reply",
        );
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
