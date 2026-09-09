import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * The dev server proxies `/api/*` to the backend, so the browser only ever
 * talks to one origin and the server needs no CORS handling.
 *
 * The target port must match the backend's, which is configurable through
 * `PORT`. Hard-coding it here meant that setting `PORT` moved the backend but
 * not the proxy, and every request 500'd against a port with nothing on it -
 * with no message pointing at the cause.
 *
 * Only `PORT` is read out of the root `.env`, deliberately parsed by hand
 * rather than loaded wholesale: the file also holds `RIME_API_KEY`, and there
 * is no reason for a credential to enter the front-end build process at all.
 */

const DEFAULT_BACKEND_PORT = 8787;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Reads a single non-secret key from the root .env, if it is set there. */
function portFromEnvFile(): number | undefined {
  const envPath = resolve(repoRoot, ".env");
  if (!existsSync(envPath)) return undefined;

  try {
    for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const match = /^\s*PORT\s*=\s*(\d+)\s*$/.exec(line);
      if (match !== null) return Number(match[1]);
    }
  } catch {
    // An unreadable .env is not fatal here; fall back to the default.
  }
  return undefined;
}

function backendPort(): number {
  // A real environment variable wins, matching how the server resolves it.
  const fromEnv = Number(process.env.PORT);
  if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv;
  return portFromEnvFile() ?? DEFAULT_BACKEND_PORT;
}

const BACKEND_PORT = backendPort();

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${BACKEND_PORT}`,
        changeOrigin: true,
      },
    },
  },
});
