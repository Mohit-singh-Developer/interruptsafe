import Fastify, { type FastifyError } from "fastify";
import type { ApiErrorResponse } from "@interruptsafe/shared";
import { ConfigError, loadConfig, loadEnvFile, type Config } from "./config";
import { createLlmProvider, type LlmProvider } from "./agent/llmProvider";
import { registerRoutes } from "./transport/routes";

/**
 * InterruptSafe backend - Phase 3.
 *
 * Serves a health endpoint and a single-turn chat endpoint. The reply comes
 * from whichever provider `LLM_PROVIDER` selects: a deterministic mock, or a
 * real Anthropic provider. There is still no streaming, no conversation state,
 * no generation versioning, no cancellation, no tools and no WebSocket
 * transport. Those arrive in later phases.
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

registerRoutes(app, provider);

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
