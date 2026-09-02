/**
 * Contracts shared between the InterruptSafe server and web client.
 *
 * This package is consumed as raw TypeScript source (see `exports` in
 * package.json) so there is no build step. Both `tsx` on the server and Vite in
 * the browser resolve `.ts` directly.
 *
 * Phase 1 contains only the health contract. The conversation and generation
 * protocol types arrive in later phases.
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
