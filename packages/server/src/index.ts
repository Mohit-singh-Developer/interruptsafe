import Fastify from "fastify";
import type { HealthResponse } from "@interruptsafe/shared";

/**
 * InterruptSafe backend - Phase 1.
 *
 * Deliberately minimal: an HTTP server and a health endpoint. There is no LLM
 * integration, no WebSocket transport, no tool execution, and no conversation
 * state yet. Those arrive in later phases.
 */

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? "info" },
});

app.get("/api/health", async (): Promise<HealthResponse> => {
  return {
    status: "ok",
    service: "interruptsafe-server",
    phase: 1,
    uptimeSeconds: Number(process.uptime().toFixed(3)),
    timestamp: new Date().toISOString(),
  };
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
