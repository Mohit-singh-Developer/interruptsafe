import Fastify, { type FastifyError } from "fastify";
import type { ApiErrorResponse } from "@interruptsafe/shared";
import { createLlmProvider } from "./agent/llmProvider";
import { registerRoutes } from "./transport/routes";

/**
 * InterruptSafe backend - Phase 2.
 *
 * Serves a health endpoint and a single-turn chat endpoint backed by a
 * deterministic mock provider. There is no real language model, no streaming,
 * no conversation state, no generation versioning, no cancellation, no tools
 * and no WebSocket transport. Those arrive in later phases.
 */

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? "info" },
});

const provider = createLlmProvider();
app.log.info({ provider: provider.name }, "LLM provider selected");

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
  await app.listen({ port: PORT, host: HOST });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
