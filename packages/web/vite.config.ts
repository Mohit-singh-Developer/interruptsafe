import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Must match the backend's PORT (see .env.example). The proxy below forwards
 * `/api/*` from the Vite dev server to the backend, so the browser only ever
 * talks to one origin and no CORS handling is needed on the server.
 */
const BACKEND_PORT = 8787;

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
