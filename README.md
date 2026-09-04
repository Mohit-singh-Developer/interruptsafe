# InterruptSafe

A full-duplex voice agent that never continues an outdated conversation: when the
user interrupts, playback stops, the conversation advances to a new generation,
and results from the superseded generation can no longer re-enter it.

## Current development status

**Interruption correctness core - implemented.**

You can type a message and get a reply. The reply comes either from a
**deterministic mock** (the default, requiring no API key and making no network
call) or from a **real Anthropic model**, selected by `LLM_PROVIDER`.

The central guarantee now holds:

> Old work may keep running, but old work can never commit its result once its
> generation has been superseded.

Advancing the generation is the correctness mechanism. Cancellation is requested
where a provider supports it, but nothing depends on it succeeding.

There is no streaming, no tools, no speech-to-text and no Rime speech output
yet; those arrive in later phases.

| Phase | Status |
|-------|--------|
| 0 - Project planning and architecture | Complete |
| 1 - Frontend and backend structure | Complete |
| 2 - Basic text conversation flow | Complete |
| 3 - Real LLM provider and conversation state | Complete |
| 4 - Generation versioning | Complete |
| 5 - Mock long-running tools | **Skipped so far** |
| 6 - Stale-result fencing | Complete |
| 7 - Deterministic interruption | Complete |
| 8-16 | Not started |

## API

| Endpoint | Purpose |
|----------|---------|
| `GET /api/health` | Liveness and current phase |
| `POST /api/chat` | One turn of a conversation |
| `POST /api/interrupt` | Advance the generation, superseding outstanding work |

```
POST /api/chat
{ "message": "Hello", "conversationId": "optional-on-the-first-turn" }

200 -> { "status": "ok", "message": "...", "conversationId": "...", "generation": 1 }
409 -> { "status": "superseded", "conversationId": "...",
         "resultGeneration": 1, "currentGeneration": 2 }
400 -> { "error": "..." }
502 -> { "error": "..." }
```

The four outcomes are distinguishable without reading any error text:

| Outcome | Status | Meaning |
|---------|--------|---------|
| Committed | `200` | Still current when it finished; appended to the transcript |
| Superseded | `409` | Finished after being superseded; **nothing was appended** |
| Invalid request | `400` | Validation failure |
| Provider failure | `502` | Upstream fault; nothing was appended |

A `409` is not an error. The provider may have produced a perfectly good answer -
it simply arrived after the user moved on, so it was not allowed to affect the
conversation.

```
POST /api/interrupt
{ "conversationId": "..." }

200 -> { "conversationId": "...", "generation": 2, "cancellationRequested": 1 }
```

`generation` is the guaranteed outcome: once it returns, every outstanding stamp
is stale. `cancellationRequested` reports how many in-flight requests were
*asked* to stop - never how many actually did.

Omit `conversationId` on the first chat turn and the server allocates one. Send
it back on later turns to continue the same conversation. An unrecognised id
starts a fresh conversation under that id rather than failing, so a client
survives a server restart. (The browser allocates its own id up front, so that
Interrupt is available during the very first turn.)

The server owns the transcript: history is stored per conversation and is sent
to the provider on every turn. The browser keeps its message list for display
only. History is held in memory, so it is lost when the server restarts.

The route is provider-agnostic - it depends only on the `LlmProvider` interface
and contains no provider-specific logic, and the frontend contains no provider
logic and no keys.

## How interruption stays correct

Every turn is stamped with the generation that was current when it started.
Interrupting advances that generation. When a turn finishes it must pass through
a single function - `packages/server/src/session/fencedCommit.ts` - which
compares the stamp against the generation that is current *now*, and refuses to
append anything if they differ.

That check is synchronous: nothing can advance the generation between judging a
result current and writing it.

Cancellation is separate and advisory. The Anthropic provider forwards the abort
signal so an abandoned turn stops billing tokens. The deterministic mock
**deliberately ignores it**, which makes it a faithful stand-in for a provider
that cannot or will not stop - and demonstrates that the result is discarded
correctly regardless.

## Demonstrating it

The mock replies instantly, leaving no window to press Interrupt. Open one:

```
DEV_DETERMINISTIC_DELAY_MS=1500 npm run dev
```

Then at http://localhost:5173: send a message, press **Interrupt** before the
reply lands, and watch the generation advance. The reply still arrives - the
mock ignored the cancellation - but it comes back marked superseded, is struck
through as *not committed*, and never enters the conversation. Send another
message and the reply confirms the fenced turn is absent from history.

This delay is a development aid only. It has no effect on the real provider and
is not part of the correctness model.

## Choosing a provider

Selection is by the `LLM_PROVIDER` environment variable.

### Deterministic mock (default - no API key)

Nothing to configure. With no `.env` file at all:

```
npm run dev
```

Replies are a pure function of the input, so they are predictable and testable.

### Real Anthropic provider

```
cp .env.example .env
```

Then edit `.env` and set:

```
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=your-key-here
```

`.env` is gitignored - never commit it, and never paste a real key into
documentation, an issue, or a commit message.

If `LLM_PROVIDER=anthropic` and `ANTHROPIC_API_KEY` is missing, the server
**exits with a clear configuration error**. It never falls back to the mock on
its own, so you cannot mistake fake replies for real ones.

### Environment variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `LLM_PROVIDER` | no | `deterministic` | `deterministic` or `anthropic` |
| `ANTHROPIC_API_KEY` | only when `LLM_PROVIDER=anthropic` | - | API credential |
| `LLM_MODEL` | no | `claude-opus-5` | Model id |
| `LLM_EFFORT` | no | `low` | `low`\|`medium`\|`high`\|`xhigh`\|`max` |
| `PORT` | no | `8787` | Backend port |
| `LOG_LEVEL` | no | `info` | Log verbosity |
| `DEV_DETERMINISTIC_DELAY_MS` | no | `0` | Development aid: artificial mock latency so Interrupt can be pressed by hand |

Real environment variables take precedence over values in `.env`, so you can
override a single setting for one run without editing the file:

```
LLM_PROVIDER=deterministic npm run dev
```

All values are read by the backend only. No key is ever sent to the browser,
and the API key is never written to the logs.

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
