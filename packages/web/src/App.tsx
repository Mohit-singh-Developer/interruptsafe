import { useEffect, useState } from "react";
import type { HealthResponse } from "@interruptsafe/shared";

/**
 * InterruptSafe web client - Phase 1 placeholder.
 *
 * This page exists to prove the frontend builds, runs, and can reach the
 * backend through the Vite proxy. There is no conversation UI, no microphone,
 * and no audio playback yet.
 */

type BackendState =
  | { kind: "checking" }
  | { kind: "ok"; health: HealthResponse }
  | { kind: "error"; message: string };

function useBackendHealth(): BackendState {
  const [state, setState] = useState<BackendState>({ kind: "checking" });

  useEffect(() => {
    const controller = new AbortController();

    fetch("/api/health", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Backend responded ${response.status}`);
        }
        const health = (await response.json()) as HealthResponse;
        setState({ kind: "ok", health });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          kind: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      });

    return () => controller.abort();
  }, []);

  return state;
}

function BackendStatus({ state }: { state: BackendState }) {
  if (state.kind === "checking") {
    return (
      <p className="status status--pending">
        <span className="dot" /> Checking backend…
      </p>
    );
  }

  if (state.kind === "error") {
    return (
      <>
        <p className="status status--error">
          <span className="dot" /> Backend unreachable
        </p>
        <p className="detail">{state.message}</p>
        <p className="detail">
          Start it with <code>npm run dev:server</code>, or run both with{" "}
          <code>npm run dev</code>.
        </p>
      </>
    );
  }

  const { health } = state;
  return (
    <>
      <p className="status status--ok">
        <span className="dot" /> Backend connected
      </p>
      <dl className="detail-grid">
        <dt>Service</dt>
        <dd>{health.service}</dd>
        <dt>Phase</dt>
        <dd>{health.phase}</dd>
        <dt>Uptime</dt>
        <dd>{health.uptimeSeconds}s</dd>
      </dl>
    </>
  );
}

export function App() {
  const state = useBackendHealth();

  return (
    <main className="shell">
      <header>
        <h1>InterruptSafe</h1>
        <p className="tagline">
          A full-duplex voice agent that never continues an outdated
          conversation.
        </p>
      </header>

      <section className="card">
        <h2>Backend</h2>
        <BackendStatus state={state} />
      </section>

      <section className="card">
        <h2>Phase 1 of 16</h2>
        <p className="detail">
          Frontend and backend foundation only. Conversation state, generation
          versioning, tool cancellation, stale-result fencing, interruption
          handling, speech-to-text and Rime speech output are not implemented
          yet.
        </p>
      </section>
    </main>
  );
}
