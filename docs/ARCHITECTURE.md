# InterruptSafe - Architecture

**Status: as-built, with two exceptions noted below.** This document began as the
design approved before implementation. The correctness core it describes —
generation versioning, stale-result fencing, two-stage interruption, the mock
tool path and the Rime integration — is built and running; read it as a
description of the shipped system.

Two parts were designed here and **deliberately not built**. They are marked
where they appear, and are listed once here so nothing in this document can be
mistaken for a claim about the code:

| Section | Status |
|---------|--------|
| §11.2 WebSocket transport with binary generation-stamped audio frames | **NOT BUILT.** The shipped transport is plain HTTP throughout — see §11.1. Clause-chunked HTTP synthesis gave enough of the latency benefit that the protocol was not needed to prove the claim. |
| §13 phase plan, "Phase 8 · + Deepgram" | **NOT BUILT and not used.** Speech recognition is the browser's own Web Speech API. There is no speech-to-text credential, service or SDK in this project. |

Everything else describes code you can read in this repository. Where this
document and the code disagree, the code is correct — and please open the
mismatch as a defect.

---

## 1. The problem

A user speaks a request. The agent begins processing, calls a long-running tool,
and starts speaking a response. Mid-sentence, the user interrupts and changes
their request.

A naive agent does the wrong thing in a specific, recognisable way: it keeps
talking for another second, then answers the *old* question, or lets a tool
result that belongs to the abandoned request leak into the new answer.

InterruptSafe exists to make that failure impossible.

## 2. The guarantee

When the user interrupts, the system must ensure that:

1. Currently playing audio stops promptly.
2. Queued or obsolete audio does not continue.
3. Obsolete LLM generation is cancelled where possible.
4. Obsolete tool/API calls are cancelled where possible.
5. If a task cannot be cancelled, its result is fenced as stale.
6. The conversation moves to a new version/generation.
7. New user input becomes the active request.
8. Old tool results never overwrite or re-enter the latest conversation.
9. The final spoken response reflects the user's latest instruction.
10. Rime provides the primary text-to-speech output.

Guarantees 3 and 4 are **best-effort** - some work genuinely cannot be recalled.
Guarantees 5 and 8 are **absolute**, and they are what make the system correct
even when cancellation fails. This distinction is the heart of the design and is
expanded in section 7.

## 3. The critical MVP flow

This is the one flow the project must demonstrate. Nothing unrelated is built
before it works end to end.

```
User request
    v
Tool starts
    v
Agent starts responding through Rime
    v
User interrupts
    v
Playback stops
    v
Generation increments
    v
Old tool result returns
    v
Version mismatch detected
    v
Old result rejected
    v
New request processed
    v
Rime speaks only the updated response
```

## 4. Approved technology stack

TypeScript end to end, in an npm workspaces monorepo.

| Layer | Choice |
|-------|--------|
| Backend | Node.js 22 + TypeScript, `fastify` for HTTP. Plain request/response only — no WebSocket dependency is installed (see §11.2) |
| Frontend | React + Vite + TypeScript, Web Audio API |
| Shared | `packages/shared` - wire protocol and generation types, zero dependencies |
| LLM | Anthropic SDK behind an `LlmProvider` interface (section 10) |
| TTS | **Rime - primary and only**; there is no fallback TTS in this codebase |
| STT | Browser-native Web Speech API - zero cost, no key, no SDK. No third-party STT service is used |
| Package manager | npm workspaces (npm 10+, no pnpm dependency) |

**Why TypeScript on both sides.** Every cancellable operation in this system -
the Anthropic request, the Rime request, and our own tools - accepts the same
`AbortSignal`, so one mechanism reaches all of them. **As implemented** there is
one `AbortController` per in-flight request, held by `InFlightRegistry` and
keyed by conversation, rather than one per generation: an interruption aborts
every controller registered for that conversation. Keeping the controllers out
of `GenerationManager` is deliberate, so the staleness check stays independent
of anything cancellation does. Node 22 provides `AbortController`,
`AbortSignal.any()`, and `AbortSignal.timeout()` natively.
Sharing the protocol types between client and server also means the generation
contract cannot drift between the two sides.

## 5. Repository layout

This is the layout **as it actually exists**, not a plan.

```
interruptsafe/
  package.json                 # npm workspaces root
  .env.example
  .gitignore
  README.md
  docs/
    ARCHITECTURE.md            # this file
    RIME_EVIDENCE.md           # hard voice claim, acceptance test, results
    evidence/                  # committed Rime audio sample
  packages/
    shared/
      src/index.ts             # wire contracts + generation/event/transcript types
    server/
      src/
        config.ts              # env parsing; Rime and Anthropic both optional
        session/               # ConversationState, GenerationManager,
                               #   InFlightRegistry, fencedCommit, event log
        agent/                 # LlmProvider, deterministic mock, Anthropic
        tools/                 # tool interface, MOCK travel tools, intent,
                               #   dispatch (the tool fencing boundary)
        tts/                   # Rime client (optional)
        transport/             # HTTP routes
    web/
      src/
        audio/                 # VAD, browser speech recognition, playback
        transport/             # typed HTTP client
        App.tsx                # conversation, voice bar, activity timeline
```

Two directories from the original plan were never created, because what they
were for arrived differently. There is no `server/src/stt/`: speech recognition
runs in the browser, so no server-side provider interface was needed. There is
no `server/src/obs/`: the event log lives with the state it describes, in
`session/conversationEvents.ts`. On the web side there is no separate `state/`
or `ui/` split - the client is small enough that `App.tsx` plus `audio/` and
`transport/` is clearer than more folders.

`docs/RIME_EVIDENCE.md` holds the hard voice claim, its acceptance test, and the
measured results. `docs/evidence/` holds a committed Rime audio sample backing
those results.

## 6. Conversation versioning

A single monotonically increasing integer per session. Not a UUID, not a vector
clock - a hackathon judge must understand it in ten seconds.

```ts
type Generation = number;

class GenerationManager {
  bump(reason: BumpReason): Generation;   // abort old controller, increment, emit
  now(): Generation;
  isStale(g: Generation): boolean;        // g !== current
  signalFor(g: Generation): AbortSignal;
}
```

**Scope note.** The implemented manager provides `now`, `bump`, `isCurrent` and
`isStale`, and it owns no `AbortController`. `signalFor` is deliberately absent:
cancellation capability lives in `session/inFlightRegistry.ts` instead, which
keeps it structurally separate from the check that actually decides
correctness. Each conversation owns its own manager, held by
`ConversationState`, so generations are isolated and are evicted along with the
conversation.

Enforcement is implemented. Every turn is stamped when it starts and must pass
`session/fencedCommit.ts` before it may touch the transcript; a stale result is
rejected there and nothing is appended.

The visible event log described in section 12 is implemented too, as a bounded
per-conversation log in `session/conversationEvents.ts`, exposed by
`GET /api/conversations/:conversationId/activity` and rendered as a timeline in
the client. It is strictly observability: events are written from decisions that
have already been made and are never read back to make one, so removing the log
entirely would change what is visible and not what is correct.

Every unit of work is **stamped at the moment it is created**: the LLM turn, each
individual tool call, each Rime synthesis request, and each outbound audio frame.
Nothing is allowed to enter the conversation without its stamp being compared
against the current generation.

The generation increments on exactly one event: a **confirmed** user interruption
or a new user turn. It does not increment on speculative signals (see section 8).

### 6.1 Truncating an interrupted turn

When the user interrupts during speech, the half-delivered assistant turn cannot
simply be deleted from the transcript. The user *heard* part of it. If the
transcript pretends it never happened, the model's context no longer matches the
user's experience, and the next response will be incoherent.

So on a generation bump the conversation state:

1. Truncates the assistant message to the text actually spoken (the **spoken
   watermark**),
2. appends an explicit `[interrupted by user here]` marker,
3. appends the new user utterance.

This is what makes guarantee 9 hold in practice rather than in theory.

**Scope note.** Step 2 is implemented: an interruption appends a marker entry to
the conversation, and `ConversationState` keeps two views of the same list -
`transcript` for a reader, which includes markers, and `history` for the
provider, which projects only committed exchanges. A marker is therefore visible
without ever becoming input to the model.

Steps 1 and 3 remain deferred. There is nothing to truncate yet: no text has
been spoken, because there is no TTS, so the spoken watermark has no meaning
until audio exists. A superseded turn is currently dropped whole rather than
truncated, with the marker recording where it happened. The precise,
sequence-accurate watermark - derived from per-chunk playback acknowledgments
from the browser - arrives with real audio playback. Core versioning and fencing
are **not** blocked on it.

## 7. Cancellation versus fencing

These are two different mechanisms solving two different problems, and conflating
them is the most common way this class of system goes wrong.

### Cancellation - best-effort, saves latency and money

**As implemented:** one `AbortController` per in-flight request, registered in
`session/inFlightRegistry.ts` against its conversation and its generation stamp.
An interruption aborts every controller registered for that conversation. On a
bump:

- the Anthropic request is aborted, so an abandoned turn stops billing tokens;
- the signal is passed into every dispatched tool;
- browser-side, any Rime playback is stopped and its synthesis request aborted.

The registry holds no authority over what may commit - it is consulted by
nothing when that decision is made.

Cancellation is **advisory**. A third-party SDK may ignore the signal. A booking
that has already been committed downstream cannot be un-issued. Therefore
cancellation alone can never satisfy guarantee 8.

### Fencing - guaranteed, protects correctness

Every result funnels through exactly one function. That single door is the whole
design; scattering the check across several call sites guarantees that one is
eventually missed.

```ts
// packages/server/src/tools/dispatch.ts - the single door into the conversation
function commitToolResult(gen: Generation, result: ToolResult): void {
  if (state.isStale(gen)) {
    events.emit({
      type: "tool_result_rejected",
      reason: "stale",
      resultGeneration: gen,
      currentGeneration: state.now(),
    });
    compensate(result);  // e.g. release a hold the tool already took
    return;              // never touches messages[]
  }
  state.appendToolResult(result);
}
```

**As implemented.** The choke point for anything entering the conversation is
`packages/server/src/session/fencedCommit.ts`, and its function is
`commitExchange`. Nothing else calls `appendExchange` directly. The check and
the append sit in one synchronous block with no `await` between them, so the
generation cannot move in the gap between judging a result current and writing
it.

Tools sit behind a second, earlier check in
`packages/server/src/tools/dispatch.ts`, matching the sketch above. That one is
an **early exit rather than a second source of truth**: it rejects a stale tool
result before a reply is built on it, which saves the work, but a reply that
somehow got through would still be refused at commit time because its own stamp
would be stale too. Tools themselves hold no generation and cannot reach
conversation state, so there is no third path.

**Compensation hooks** matter for credibility: a `bookHotel` call that completed
*after* its generation was abandoned represents a real side effect. It registers
a compensating action rather than being silently discarded. Not yet implemented:
nothing in the system currently has an external side effect to compensate for.

## 8. Interruption handling

Three tiers, deliberately layered so that the system feels instant without being
twitchy.

| Tier | Source | Latency | Action | Phase |
|------|--------|---------|--------|-------|
| 1 - Suspected | Client-side VAD | ~50-150 ms | Flush local playback immediately. **Do not** bump the generation | 8 |
| 2 - Confirmed | STT speech-start / first non-empty interim transcript | ~200-500 ms | Bump the generation; request cancellation of in-flight work (best-effort) | 8 |
| 3 - Explicit | UI interrupt control / new typed turn | deterministic | Bump the generation; request cancellation of in-flight work (best-effort) | 7 |

**Two-stage commit.** Tier 1 provides the *feel* of instant interruption - audio
stops the moment the user speaks. Tier 2 provides the *truth*. If tier 2 does not
arrive within roughly 600 ms, the trigger was a cough or a background noise:
playback resumes and the generation was never disturbed. Bumping the generation
on raw VAD alone produces an agent that interrupts itself constantly.

**As implemented.** The two-stage commit is in place, in
`packages/web/src/App.tsx` over `audio/`:

- **Tier 1** (`voiceActivityDetector.ts`) - sustained loudness flushes the
  playback queue immediately, so the user stops hearing the abandoned answer at
  once. It does **not** advance the generation, and the UI says so explicitly.
- **Tier 2** (`useSpeechRecognition.ts`) - the first *recognised words*, interim
  or final, confirm that the loudness was speech. Only then is
  `POST /api/interrupt` called and the generation advanced.
- **Timeout** - if nothing is recognised within
  `VOICE_CONFIRM_TIMEOUT_MS` (1200 ms), the trigger is discarded as background
  noise and the conversation is left entirely alone.
- **Tier 3** - the Interrupt button still advances the generation immediately,
  and is what the automated tests drive.

Two honest caveats. Playback that tier 1 stopped is not resumed if tier 2 never
confirms - the audio has already been discarded, so a cough costs the remainder
of one spoken reply, though not the conversation. And in a browser with no
speech recognition (Firefox) there is no tier 2 available, so tier 1 confirms
directly; the UI states which case applies rather than implying confirmation
happened.

**Echo guard** (Phase 8). Without it the agent's own voice triggers its own
barge-in detector: request `echoCancellation`, `noiseSuppression`, and
`autoGainControl` on the microphone stream; raise the VAD threshold while agent
audio is playing; ignore VAD for a short window after playback begins.

**Tier 3 ships first, in Phase 7, and needs no microphone.** It is also the tier
the automated tests drive, because it is deterministic.

### 8.1 Interruption over HTTP — as built

Before any WebSocket exists, an interruption is simply a separate HTTP request to
a dedicated interruption endpoint. What that endpoint does - and what it
explicitly does not do - is the point of the whole design:

1. **The interruption endpoint advances the active conversation generation.**
   This is the only guaranteed effect. It is a local, synchronous state change on
   the server and it cannot fail partway.

2. **The client may abort or stop waiting for an obsolete request.** Aborting the
   in-flight `fetch` frees the client to move on and prevents a superseded
   response from being rendered. It is a client-side convenience only.

3. **Aborting a client request does not cancel server-side work.** Closing the
   connection may cause the server to observe a disconnect, but observing a
   disconnect is not cancellation, and the system must never depend on it. Work
   already dispatched - an LLM turn, a tool call, an external API request -
   continues unless something server-side explicitly cancels it, and some of it
   cannot be cancelled at all.

4. **Server-side work may therefore continue and complete after the
   interruption.** That is expected and permitted. Cancellation is best-effort;
   it reduces cost and latency but is never relied upon for correctness.

5. **Anything that completes under an older generation is fenced and rejected.**
   The result is compared against the current generation at the single choke
   point in section 7, and is discarded if it is stale. This is what actually
   protects the conversation, and it holds whether or not the client aborted
   anything and whether or not cancellation succeeded.

The same five properties hold once the transport becomes a WebSocket in Phase 8.
Only the delivery mechanism changes; generation advancement remains the
guaranteed effect, and fencing remains the guarantee that makes it correct.

## 9. Rime TTS integration

**Rime is the primary and only text-to-speech path. This codebase contains no
`speechSynthesis` fallback and no secondary TTS provider.** A silent fallback
would invalidate the project's Rime evidence entirely, so its absence is a
deliberate architectural constraint rather than an omission.

**As implemented** the pipeline is:

```
committed reply -> prepareForSpeech -> clause chunker (browser)
                -> one HTTPS request per clause -> WAV clip
                -> generation-stamped playback queue -> speaker
```

`prepareForSpeech` (`packages/shared/src/speechText.ts`) applies Rime's own
guidance for text destined to be heard rather than read: markdown and bullets
removed, arrows and symbols spoken as words, asides flattened, non-dollar
currency written out, sentences kept under 25 words, and no SSML or inline tags
ever emitted. It runs on the client before chunking and again on the server
before the Rime call; it is idempotent, so applying it twice is harmless. It
alters only the spoken rendering - the committed transcript is untouched.

Chunking happens in `web/src/audio/clauseChunker.ts`, after the reply is
committed, because this build does not stream LLM tokens. It still buys the
important property: speech starts after the *first* clause is synthesised
rather than the whole reply, and the next clause is fetched while the previous
one plays. Each clause is also an independently generation-stamped playback
unit, so an interruption discards at clause granularity.

Rime documents HTTP and WebSocket streaming; neither is used here. One request
per clause is a documented, verifiable path, and inventing a streaming protocol
that could not be tested without a credential would have been worse.

The original plan below assumed token streaming and a WebSocket transport:

```
LLM token stream -> sentence chunker -> Rime (per clause) -> PCM frames
                 -> WebSocket -> browser playback buffer
```

Chunking at clause boundaries rather than waiting for a complete response buys
two things: time-to-first-audio drops to roughly one clause of generation, and
interruption granularity becomes one clause instead of one paragraph.

**Audio format:** raw PCM16, mono, 24 kHz, uncompressed. Not MP3 or Opus - codec
decode buffers add latency and make instant flushing substantially harder.
Uncompressed audio over a local WebSocket is effectively free.

**Instrumentation from the first line of Phase 9,** because it becomes
`RIME_EVIDENCE.md`: every Rime request is logged with its generation, character
count, time-to-first-byte, total bytes returned, and whether it was aborted
mid-stream.

**Verified and implemented.** Checked against Rime's own quickstart before the
client was written: `POST https://users.rime.ai/v1/rime-tts`, `Authorization:
Bearer <key>`, `Accept: audio/wav`, body `{ text, speaker, modelId }`, where
`modelId` is `mistv3` (lowest latency) or `coda` (flagship). No undocumented
parameters are sent. The client lives in `packages/server/src/tts/rimeClient.ts`
and the endpoint URL is a module constant, so nothing the browser sends can
redirect the request. `RIME_API_KEY` is server-side only and is never logged.

**Optional, by deliberate choice.** Rime remains the only text-to-speech path -
there is still no fallback synthesiser - but its absence is not a failure. With
no credential the server starts normally, `GET /api/health` reports
`ttsAvailable: false`, `POST /api/tts` answers `503`, and the client shows voice
output as unavailable. Text chat, mock tools, generation fencing and
interruption are all unaffected, so the project can be developed and demonstrated
at no cost.

**Synthesis cannot affect conversation correctness.** Speech is generated from a
reply that has *already* passed `fencedCommit`. `/api/tts` is a separate endpoint
that reads nothing from `ConversationState`, writes nothing to it, and carries no
generation stamp. A synthesis failure costs audio and never text.

## 10. LLM provider abstraction

The agent loop must not be coupled to one vendor or one model. The abstraction is
introduced in its simplest useful form and grows only when a phase genuinely
requires more, rather than being built speculatively against a future need.

### 10.1 The interface: request and response

The provider starts as a plain asynchronous call. There is no streaming and no
cancellation, because nothing at this phase consumes either.

```ts
interface LlmRequest {
  readonly message: string;
}

interface LlmResult {
  readonly message: string;
}

interface LlmProvider {
  readonly name: string;
  generate(request: LlmRequest): Promise<LlmResult>;
}
```

The only implementation at this phase is a **deterministic mock**. It makes no
network call, requires no API key, and returns a pure function of its input so
that the browser-to-backend path can be exercised and asserted against before a
real provider exists.

This lives in `packages/server/src/agent/llmProvider.ts`, with the mock in
`packages/server/src/agent/deterministicProvider.ts`. Construction happens in a
single `createLlmProvider()` factory, and that factory is the seam: the
conversation route depends only on the interface and never on a concrete
provider.

### 10.2 A real provider behind the same abstraction

A real implementation is added and selected inside `createLlmProvider()`. The
conversation route is not rewritten, because it never referred to anything but
`LlmProvider`.

(This shipped under the "Phase 3" label while the phase table below lists
`ConversationState` at row 3; both landed, in the opposite order. The numbering
is left as it happened rather than rewritten.)

The default real implementation targets the Anthropic SDK. Model id and reasoning
effort come from environment variables (`LLM_MODEL`, `LLM_EFFORT`), so changing
model is configuration, not a code change.

Which provider is active is chosen by `LLM_PROVIDER`, and the deterministic mock
is retained rather than replaced - it is what allows the later interruption and
stale-result tests to run without a network dependency. Selecting a real
provider without its required configuration is a startup failure; the server
never falls back to the mock on its own, because silently serving fake replies
would undermine every test built on top of it.

**Streaming is not a requirement of Phase 3.** A real provider can satisfy the
Phase 2 `generate` contract by awaiting a complete response. Streaming must not
be introduced at this phase unless Phase 3 turns out to genuinely need it.

### 10.3 Voice, streaming and interruption phases - evolving the interface

The interface grows when something actually consumes token-level output: the
sentence chunker in section 9 needs partial text so Rime can begin speaking
before the full reply exists, and interruption needs a way to ask an in-flight
turn to stop. At that point the provider becomes something closer to:

```ts
interface LlmProvider {
  readonly name: string;
  streamTurn(request: LlmTurnRequest, signal: AbortSignal): AsyncIterable<LlmEvent>;
}
```

Two constraints govern that evolution:

- The `AbortSignal` is a **best-effort** cancellation request, exactly as
  described in sections 7 and 8.1. A provider may ignore it, and work already
  dispatched may still complete.
- Correctness must continue to rest on advancing the generation and on fencing
  stale results at the single choke point - never on a stream having been
  successfully aborted.

An interface that made cancellation look guaranteed would contradict the central
claim of this project, so the streaming form must be introduced without weakening
either constraint.

### 10.4 Notes that apply once a real provider exists

**Agent loop:** a manual `while (stop_reason === "tool_use")` loop rather than the
SDK's tool-runner helper. The tool runner is the better default for ordinary
agents, but this project's entire thesis lives *at the loop boundary* - an
explicit, inspectable staleness check between every turn. Owning the loop keeps
that check visible in our code rather than inside a helper's callback.

**Latency posture:** fast mode is **off**. Correctness is established and
measured first; latency optimisation is evaluated against a real baseline once
the end-to-end voice system works.

**One model-specific caution.** Reasoning must not be disabled on Claude Opus 5
to save latency. With thinking disabled the model can write a tool call into
visible response text instead of emitting a proper tool-use block. In a voice
agent that means Rime reads a raw tool call aloud to the user. Low effort with
adaptive thinking left on is both cheaper and safer.

## 11. Transport and wire protocol

The transport is introduced in two stages. Real-time transport is deliberately
deferred until the data being carried is actually continuous.

### 11.1 Plain HTTP — as built, and what shipped

The text-only phases need nothing more than request and response. The browser
talks to the Vite dev server, which proxies `/api/*` to the backend, so there is
no cross-origin request and no CORS configuration.

Adding a socket earlier would introduce reconnection, backpressure, and framing
concerns while the payload is still a single request and a single reply. The
entire correctness core - conversation state, generation versioning, tool
cancellation, and stale-result fencing - is built and proven over HTTP.

Interruption works over plain HTTP as a request to a separate endpoint. Section
8.1 sets out exactly what that guarantees and, importantly, what it does not:
aborting a client request never cancels server-side work.

### 11.2 One WebSocket per session — DESIGNED, NOT BUILT

> **This section describes a design that was not implemented.** The shipped
> transport is the plain HTTP of §11.1, for every route including synthesis.
> Clause-chunked HTTP delivered enough of the time-to-first-audio benefit that
> a custom binary protocol was not needed to prove the interruption claim, and
> an unimplemented protocol is worth less than a verified simple one. It is kept
> here because the generation-stamped frame header below is the natural
> extension of the fencing model to a streaming transport, and it records why
> the client would still not need to trust the server to stop in time.

Real-time transport would arrive at the point where it is genuinely required:
microphone audio streaming to the server for speech-to-text, and synthesized
audio streaming back for playback. WebRTC is not used - its signalling setup
costs significant time and buys nothing for a local demo.

- **JSON text frames** carry control and observability events:
  `user_turn`, `generation_changed`, `tool_started`, `tool_result_accepted`,
  `tool_result_rejected`, `assistant_text_delta`, `interrupt`.
- **Binary frames** carry audio, with an 8-byte self-describing header:

```
bytes 0-3   uint32 LE   generation
bytes 4-7   uint32 LE   sequence
bytes 8+                PCM16 mono payload
```

**Why the header exists.** Frames already on the wire cannot be recalled. Even
after the server aborts the Rime stream, some chunks have been sent. The client
compares each frame's generation against its own current value and discards
mismatches. The client therefore never has to trust that the server stopped in
time - this is defence in depth for guarantee 2.

## 12. Scope: core MVP versus future work

### CORE MVP - required

- Text-based conversation over HTTP, with an agent abstraction behind it.
- `ConversationState` as the single owner of conversation history.
- `GenerationManager`: monotonic generation, per-generation `AbortController`.
- Simulated long-running tools with configurable delay, clearly labelled as mock.
- **Stale-result fencing at a single choke point**, with a visible event log.
- Deterministic interruption (tier 3): bump the generation and truncate the
  interrupted turn, then request best-effort cancellation of the LLM stream and
  any in-flight tools. Correctness rests on the generation bump and the fencing,
  never on cancellation succeeding.
- Microphone capture, VAD, and STT (Phase 8).
- Rime TTS as the only speech output, with per-request logging.
- Audio playback that stops promptly on interruption, and client-side dropping of
  audio frames stamped with a superseded generation.
- The complete critical flow in section 3, demonstrated end to end.
- Metrics for interrupt-to-silence latency and stale-rejection counts.
- Automated tests for versioning and fencing.
- `RIME_EVIDENCE.md` built from real captured logs.

### FUTURE / ADVANCED - explicitly out of MVP scope

- AudioWorklet ring-buffer playback. Approved as an optimisation for the voice
  phases and expected to give sub-20 ms flush latency, but it must not delay
  Phases 1-7. A simpler playback path is acceptable first.
- Sequence-accurate spoken watermark via per-chunk playback acknowledgments
  (Phase 10). The coarse approximation lands in Phase 7.
- Compensating transactions for tools with real side effects, beyond the
  demonstration hook.
- Silero or other ML-based VAD in place of energy-based detection.
- WebRTC transport, multi-user sessions, authentication, persistence.
- Multi-provider LLM implementations beyond the Anthropic default. The interface
  exists in the MVP; additional implementations do not.
- Fast mode / latency tuning, evaluated only after a baseline is measured.

## 13. Phase plan and commit points

Each phase ended with a report and a stop, for manual review and commit.

**This table is the original plan, kept as a record of how the work was**
**sequenced.** Two rows did not survive contact with the build: the real-time
transport of phase 8 was never introduced (see §11.2), and Deepgram was replaced
by the browser Web Speech API, which costs nothing and needs no credential.

| Phase | Deliverable | Runnable | Keys needed |
|-------|-------------|----------|-------------|
| 0 | Architecture plan, README, `.gitignore`, `.env.example` | - | none |
| 1 | Workspace skeleton, HTTP server, health endpoint | yes | none |
| 2 | Text conversation over HTTP: text input, agent abstraction, response display | yes | none |
| 3 | `ConversationState` extracted and owned | yes | Anthropic |
| 4 | `GenerationManager` plus generation timeline UI | yes | Anthropic |
| 5 | Mock long-running tools (labelled MOCK) | yes | none |
| 6 | **Stale-result fencing and the event log** | yes | Anthropic |
| 7 | Deterministic interruption; LLM and tool abort; turn truncation | yes | Anthropic |
| 8 | Microphone, VAD, two-stage commit, browser speech recognition | yes | none |
| 9 | **Rime integration and request logging** | yes | + Rime |
| 10 | Playback flush on interrupt; client-side generation drop | yes | all |
| 11 | End-to-end travel assistant scenario | yes | all |
| 12 | Stress testing: rapid interrupts, mid-tool, mid-sentence | yes | all |
| 13 | Metrics and observability | yes | all |
| 14 | Automated test suite | yes | none |
| 15 | `RIME_EVIDENCE.md` from captured logs | - | - |
| 16 | README and hackathon documentation | - | - |

**Phases 2 through 7 require no microphone, no Rime key, and no WebSocket.** The
entire correctness core - versioning, cancellation, and fencing - is provable by
typing text over plain HTTP. This is deliberate: the hardest logic is de-risked
before either audio complexity or real-time transport is introduced.

Phase 2 puts a deterministic stub behind the `LlmProvider` interface so the
request-to-response path can be proven without a network call; the real provider
implementation is wired in from Phase 3, which is where the Anthropic key first
becomes necessary.

## 14. Environment variables

All secrets are backend-only and are read from environment variables. No key is
ever sent to the browser. See [`.env.example`](../.env.example) for the full
template with per-phase annotations.

| Variable | Purpose | First needed |
|----------|---------|--------------|
| `LLM_PROVIDER` | Selects `deterministic` or `anthropic`; defaults to `deterministic` | Phase 3 |
| `ANTHROPIC_API_KEY` | LLM provider credential, required only when `LLM_PROVIDER=anthropic` | Phase 3 |
| `LLM_MODEL` | Model id, swappable without code change | Phase 3 |
| `LLM_EFFORT` | Reasoning effort, `low` recommended for voice | Phase 3 |
| `RIME_API_KEY` | Rime credential | Phase 9 |
| `RIME_SPEAKER` | Rime voice selection | Phase 9 |
| `RIME_MODEL` | Rime model id | Phase 9 |
| `DEEPGRAM_API_KEY` | Speech-to-text credential | Phase 8 |
| `PORT` | Backend listen port | Phase 1 |
| `LOG_LEVEL` | Log verbosity | Phase 1 |

## 15. Open questions

All three questions raised at design time are now closed.

- **Rime endpoint, parameters and model identifiers — RESOLVED.** Verified
  against the live API and the live voice catalogue; the exact shipped values
  and the measurements are in [RIME_EVIDENCE.md](RIME_EVIDENCE.md) §4 and §6.
  The check found a real defect: the original default pairing of mistv3 with
  the speaker celeste is invalid and is now rejected at startup.
- **Speech recognition — RESOLVED differently than planned.** Deepgram was not
  used. The browser Web Speech API provides recognition at no cost and with no
  credential; its limits are documented in the README under Known limitations.
- **VAD thresholds — RESOLVED empirically.** Hand-tuned constants live in
  packages/web/src/audio/voiceActivityDetector.ts. They are demo defaults for a
  laptop microphone in a quiet room, not calibrated figures, which is why tier 2
  confirmation exists before the generation advances.
