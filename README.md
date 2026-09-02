# InterruptSafe

A full-duplex voice agent that never continues an outdated conversation: when the
user interrupts, playback stops, the conversation advances to a new generation,
and results from the superseded generation can no longer re-enter it.

## Current development status

**Phase 1 of 16 - runnable frontend and backend foundation.**

The workspace skeleton exists and both halves run. There is no conversation
logic, no generation versioning, no interruption handling, no speech-to-text and
no Rime speech output yet - those arrive in later phases.

| Phase | Status |
|-------|--------|
| 0 - Project planning and architecture | Complete |
| 1 - Frontend and backend structure | Complete |
| 2-16 | Not started |

## Architecture

The approved design, the conversation-versioning model, the cancellation and
stale-result fencing strategy, the scope split between core MVP and future work,
and the full phase plan are documented in:

**[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**

## Requirements

- Node.js 22 or newer
- npm 10 or newer (workspaces)

## Setup

```
npm install
```

No API keys are needed at this phase. Environment variables are documented in
[.env.example](.env.example); `PORT` and `LOG_LEVEL` are read from the
environment if set, and otherwise fall back to `8787` and `info`.

## Running

Start the backend and frontend together:

```
npm run dev
```

Then open **http://localhost:5173**. The page reports whether it can reach the
backend.

Individually, if you prefer separate terminals:

```
npm run dev:server    # http://127.0.0.1:8787
npm run dev:web       # http://localhost:5173
```

The health endpoint can be checked directly:

```
curl http://127.0.0.1:8787/api/health
```

Note: the Vite dev server binds the IPv6 loopback, so use `localhost:5173`
rather than `127.0.0.1:5173`.

## Other commands

```
npm run typecheck     # type-check every workspace
npm run build         # production build of the web client
```

## Workspace layout

| Package | Purpose |
|---------|---------|
| `packages/shared` | Types shared by both sides. Consumed as raw TypeScript; no build step |
| `packages/server` | Fastify HTTP backend |
| `packages/web` | React + Vite client |

During development the browser talks only to the Vite dev server, which proxies
`/api/*` to the backend. There is therefore no cross-origin request and no CORS
configuration.
