import Fastify, { type FastifyError } from "fastify";
import type { ApiErrorResponse } from "@interruptsafe/shared";
import { ConfigError, loadConfig, loadEnvFile, type Config } from "./config";
import { createLlmProvider, type LlmProvider } from "./agent/llmProvider";
import { ConversationStore } from "./session/conversationState";
import { InFlightRegistry } from "./session/inFlightRegistry";
import { createMockTravelTools } from "./tools/mockTravelTools";
import { ToolRegistry } from "./tools/tool";
import { createRimeClient } from "./tts/rimeClient";
import { registerRoutes } from "./transport/routes";

/**
 * InterruptSafe backend.
 *
 * Serves a health endpoint, a multi-turn chat endpoint, and an interruption
 * endpoint. The reply comes from whichever provider `LLM_PROVIDER` selects: a
 * deterministic mock, or a real Anthropic provider. Conversation history is
 * owned by `ConversationState`, and every turn is stamped with a generation
 * that must still be current before the result may be committed.
 *
 * Mock travel tools run behind the same generation stamp, and committed
 * replies are synthesised by Rime through a separate presentation endpoint.
 * There is no token streaming and no WebSocket transport: every route here is
 * plain HTTP request/response.
 */

// Configuration and provider construction happen before the server starts, so a
// misconfiguration is reported plainly instead of surfacing as a request error.
let config: Config;
let provider: LlmProvider;

try {
  loadEnvFile();
  config = loadConfig();
  provider = createLlmProvider(config);
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(`\nConfiguration error: ${error.message}\n`);
    process.exit(1);
  }
  throw error;
}

const app = Fastify({
  logger: { level: config.logLevel },
});

// Model and effort are safe to log; the API key is never logged.
app.log.info(
  {
    provider: provider.name,
    selection: config.provider,
    ...(config.anthropic ? { effort: config.anthropic.effort } : {}),
  },
  "LLM provider selected",
);

// Single owner of conversation history for the lifetime of this process.
const conversations = new ConversationStore();

// Tracks outstanding provider work so an interruption can ask it to stop.
// Advisory only - correctness comes from the generation check, not from here.
const inFlight = new InFlightRegistry();

// MOCK tools only. They make no network calls and return synthetic data.
const tools = new ToolRegistry(
  createMockTravelTools(config.mockToolDelayMs, config.mockToolMode),
);
app.log.info(
  {
    tools: tools.names(),
    mockToolDelayMs: config.mockToolDelayMs,
    mockToolMode: config.mockToolMode,
  },
  "Mock tools registered",
);

// Speech output is optional. Without a Rime credential the client simply shows
// voice output as unavailable; nothing else changes.
const rime = config.rime === undefined ? undefined : createRimeClient(config.rime);
app.log.info(
  rime === undefined
    ? { ttsAvailable: false }
    : { ttsAvailable: true, speaker: rime.speaker, model: rime.model },
  rime === undefined
    ? "Rime TTS not configured - voice output disabled (text mode unaffected)"
    : "Rime TTS configured",
);

registerRoutes(app, provider, conversations, inFlight, tools, rime);

// Normalise framework-generated failures (malformed JSON, unknown routes) onto
// the same `{ error }` shape the routes use, so clients parse one error format.
app.setErrorHandler((error: FastifyError, _request, reply) => {
  const status = error.statusCode ?? 500;
  if (status >= 500) {
    app.log.error(error);
  }
  const body: ApiErrorResponse = {
    error: status >= 500 ? "Internal server error." : error.message,
  };
  reply.code(status).send(body);
});

app.setNotFoundHandler((request, reply) => {
  const body: ApiErrorResponse = {
    error: `Route ${request.method} ${request.url} not found.`,
  };
  reply.code(404).send(body);
});

// Close the server on signals so `tsx watch` restarts do not leave the port bound.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    app.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}

try {
  await app.listen({ port: config.port, host: config.host });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
