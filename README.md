# InterruptSafe

A full-duplex voice agent that never continues an outdated conversation: when the
user interrupts, playback stops, the conversation advances to a new generation,
and results from the superseded generation can no longer re-enter it.

> **▶ Demo video:** https://drive.google.com/drive/folders/1_UYYrL8AU-MGLmGkpr17taAjCQjUQP7F?usp=sharing
> · **Slides:** https://docs.google.com/presentation/d/12BDca2zh9h6dGNXr7MjI0VymAYIGojIT/edit?usp=sharing
>
> **Hard voice problem:** interruption and recovery — [the claim and its
> acceptance test](docs/RIME_EVIDENCE.md#1-claim) ·
> **Speech provider:** Rime `mistv3` / `luna` / `eng`, observable at
> `GET /api/health` · **Reproduce it:** `npm run verify` needs no credential and
> no network.

## Who this is for

**A driver, mid-journey, with both hands on the wheel and both eyes on the road.**

They are three hours into a long drive and want somewhere to stop tonight, so
they ask out loud. While the assistant is still looking, they change their mind
— they passed a sign, the light is going, or they simply reconsidered — and they
say so *over the top of* the reply, because that is how people actually talk.

They cannot pick up the phone to correct it. They cannot glance down a list. A
screen is unsafe at speed and illegal in most places. **Voice is not a
convenience for this user; it is the only channel available.** Remove speech and
there is no product left — not a worse product, no product.

### The failure that matters

A naive agent keeps talking for another second and then answers the question the
driver has already abandoned. Or worse: the lookup for the *old* destination
returns late and quietly becomes the answer.

The driver cannot catch either mistake. They never saw a screen, so the only
thing they know about the conversation is **what they heard**. If what they hear
is stale, they act on it, and they take the wrong exit.

So the requirement is not "interrupt quickly". It is:

> Nothing the driver did not ask for may ever be spoken as current.

InterruptSafe makes that structural rather than probable. Stopping the audio is
the part the driver notices; refusing to let the abandoned work commit is the
part that keeps them from acting on a stale answer.

## What works today

You can type a message and get a reply. The reply comes either from a
**deterministic mock** (the default, requiring no API key and making no network
call) or from a **real Anthropic model**, selected by `LLM_PROVIDER`.

The central guarantee now holds:

> Old work may keep running, but old work can never commit its result once its
> generation has been superseded.

Advancing the generation is the correctness mechanism. Cancellation is requested
where a provider supports it, but nothing depends on it succeeding.

The full voice path works too: speak, see the recognised text, have it answered,
and interrupt by talking over the reply. Speech recognition is browser-native
and free. **Rime is the primary spoken output and the path the demo runs on** —
there is no second synthesiser and no fallback voice. Running without a Rime
credential is a supported *degraded* mode, described under
[Known limitations](#known-limitations), not the intended one: it exercises the
text half of the product only.

Why speech is load-bearing rather than decorative: the product exists to be
talked over. Remove the audio and tier-1 interruption has nothing to stop, two
of the ten acceptance criteria become untestable, and what is left is a chat box.

**Rime is verified against the live API.** The shipped `mistv3` / `luna` / `eng`
configuration returns real WAVE speech through the full committed-reply path;
measurements, failure modes and a playable sample clip are in
[docs/RIME_EVIDENCE.md](docs/RIME_EVIDENCE.md) and
`docs/evidence/rime-mistv3-luna-hello.wav`.

## API

| Endpoint | Purpose |
|----------|---------|
| `GET /api/health` | Liveness, uptime, and whether speech output is configured |
| `POST /api/chat` | One turn of a conversation |
| `POST /api/interrupt` | Advance the generation, superseding outstanding work |
| `GET /api/conversations/:conversationId/activity` | Lifecycle events and the reader's transcript |
| `POST /api/tts` | Rime speech synthesis for a committed reply; `503` when no credential is configured |

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

```
GET /api/conversations/:conversationId/activity

200 -> { "conversationId": "...", "currentGeneration": 3,
         "events": [ { "type": "result-fenced", "generation": 1, ... } ],
         "transcript": [ { "kind": "interruption", ... },
                         { "kind": "exchange", ... } ] }
400 -> { "error": "..." }
```

Two views of the same conversation. `events` is the lifecycle record;
`transcript` is what a reader sees, which is committed exchanges **plus
interruption markers**. A marker is not a turn: it never appears in the message
list sent to the provider, so an interruption is visible without becoming input
to the model.

The endpoint is strictly read-only - it does not create a conversation and does
not affect eviction order, so polling cannot allocate state. An unknown but
well-formed id reads as an empty conversation; a malformed id is a `400`.

Events are observability only. Nothing reads them back to decide anything, and
the whole event system could be removed without changing which results are
allowed to commit.

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

## MOCK tools

Three tools simulate slow background work. **They are mocks.** They make no
network call and return invented data derived from a hash of the input — never
real flight, weather, or hotel information, and nothing they produce should be
presented as genuine.

| Tool | Keyword | Arguments parsed |
|------|---------|------------------|
| `searchFlights` | `flight` | `from <a> to <b>`, or `<a> to <b>` |
| `searchHotels` | `hotel` | `in <city>` |
| `checkWeather` | `weather` | `in <city>` |

Selection is **deterministic keyword matching**, not model-driven tool calling —
so the whole tool demonstration runs with no API key and no network. Hotels are
checked before weather, so "hotels in Goa with good weather" resolves to the
hotel search. Any other message is answered directly by the provider, with no
tool involved.

```
Find hotels in Jaipur
What is the weather in Jaipur
Find flights from Delhi to Mumbai
```

**A keyword alone is not enough.** The message must also read as a request —
either it carries a request cue (`find`, `need`, `check`, `where`, `what`,
`make it`…) or the keyword leads the sentence. So "hotels in Goa" runs a search
and "why are you asking me about hotels" does not. Answering a question the user
did not ask is worse than answering nothing, because in a voice product they
*hear* it.

**A missing place is asked for, never invented.** "Find some flights" with no
cities replies *"Which two cities are you flying between?"* rather than
substituting a default. An earlier build answered confidently about Delhi to
Mumbai — a route the user had never mentioned — which is precisely the failure
this project exists to prevent. The question is returned immediately, without
the artificial tool delay, because there is nothing to look up.

**Place names end where the letters end** — at punctuation, a digit, a symbol or
the end of the message — and trailing qualifiers are trimmed. So
`hotels in Udaipur instead`, `hotels in Jaipur under 3000` and
`flights from Delhi to Mumbai 9am` all parse correctly. This matters for the
voice path in particular: speech recognition supplies no punctuation and readily
appends qualifiers.

A tool never touches conversation state. It returns a value, and
`packages/server/src/tools/dispatch.ts` decides whether that value is still
current enough to shape a reply. The reply then has to survive `fencedCommit`
as well, so there are two independent chances to reject abandoned work and no
way for a tool to bypass either.

## Voice

Press **Start listening** once and the microphone drives two independent things:

| Signal | What it does | Where it runs |
|--------|--------------|---------------|
| Energy detection (VAD) | Fast "someone is talking" signal that interrupts an in-flight turn | Browser, local |
| Speech recognition (STT) | Turns what you said into text, which becomes your next message | Browser, via the Web Speech API |

They are independent: if recognition is unsupported, voice can still interrupt,
and the text composer always works.

### Speech-to-text is browser-native and free

It uses `SpeechRecognition` / `webkitSpeechRecognition` — no API key, no
account, no cloud SDK in this project. Say "hello" and the interim words appear
live in the voice bar; when the utterance is finalised it is sent as a normal
chat message through the same typed client the composer uses.

**An honest caveat about privacy.** This API is **not guaranteed to run
on-device**. Chrome and Edge have historically sent audio to a Google speech
service; Safari uses Apple's. Whether recognition happens locally is a property
of the browser, not of this code, and it varies by version. What is true is that
**this application never receives or uploads your audio** — the browser hands it
text, and only text. If that matters, leave the microphone off and type; nothing
else depends on it.

**Support varies.** Firefox does not implement it at the time of writing. The UI
detects this and says so rather than failing.

### Voice activity detection is local

An `AnalyserNode` measures loudness, and that is all. It is a simple energy
threshold, not production-grade VAD, and it cannot tell a voice from a door
slam. **No audio is sent to the server for it** — the `audio/` module makes no
network requests of any kind.

Speaking during an in-flight turn calls the same `POST /api/interrupt` the
button calls. There is no separate voice path on the server, and no
`/api/voice-interrupt` endpoint. What you then say becomes the next request, so
the abandoned work is fenced and your actual question is answered.

Guards that stop it being a nuisance:

- Speech while the app is **idle does nothing** — no request is sent.
- At most **one interruption per in-flight turn**; talking continuously does not
  produce a stream of interrupts.
- Sound must be sustained past a hold time, so a single cough or door slam is
  ignored.
- Re-arms only after a period of quiet, or when the turn settles.
- Stopping the microphone stops every track, so the browser's recording
  indicator goes out.

Tuning lives in `packages/web/src/audio/voiceActivityDetector.ts` as three named
constants (`VOICE_ACTIVITY_THRESHOLD`, `VOICE_ACTIVITY_HOLD_MS`,
`VOICE_ACTIVITY_RELEASE_MS`). They are hand-tuned demo defaults for a laptop
microphone in a quiet room, not calibrated figures — there are no environment
variables for them.

### Rime configuration — the exact shipped path

| Field | Value |
|-------|-------|
| Provider | **Rime** (the only synthesiser; no fallback exists) |
| Model ID | `mistv3` |
| Speaker | `luna` |
| Language | `eng` |
| Endpoint | `https://users.rime.ai/v1/rime-tts` (hard-coded constant; the browser cannot influence it) |
| Region | **US West (us-west-2)**. `users.rime.ai` is Rime’s documented default alias for `users-west`; the alternative is `users-east` (us-east-1). Rime publishes US regions only, so there is no endpoint nearer a demo recorded outside the US |
| Audio format | `audio/wav` (requested via `Accept`) |
| Transport | HTTPS request/response, **one request per clause**; audio reaches the browser over the app's own origin and plays via `HTMLAudioElement` |
| Request body | `{ text, speaker, modelId, lang }` — no undocumented parameters |

`mistv3` is Rime's lowest-latency model, chosen because this product is about
interruption: time-to-first-audio matters more than maximum fidelity. `luna` was
checked against the live catalog (`https://users.rime.ai/data/voices/all-v2.json`)
as an English voice on **both** `mistv3` and `coda`.

**Text is prepared for the ear before synthesis.** Following Rime's prompting
guide and "Writing for the ear", `packages/shared/src/speechText.ts` strips
markdown and bullets, rewrites arrows and symbols as words (`Delhi -> Mumbai` →
"Delhi to Mumbai"), flattens parenthetical asides, writes out non-dollar
currency (`INR 3586` → "3586 rupees"), and keeps spoken sentences under 25
words. **No SSML is ever sent** — Rime does not support it — and `spell()` is
not used, because an A/B render showed no evidence it was being processed
(§4.3 of the evidence doc). Rate slashes are spoken: `3056 rupees/night` becomes
"per night", not "slash night". This changes only what is *spoken*; the
displayed transcript is untouched.

⚠️ `celeste` is a **`coda`** voice and is *not* available on `mistv3`. The server
rejects that pairing at startup rather than failing on the first spoken turn.

The live configuration is visible in the UI's **Speech provider** panel and at
`GET /api/health`, so a reviewer never has to guess which provider is speaking.

**The key never reaches the browser.** Set `RIME_API_KEY` in `.env` to enable
speech. Synthesis goes browser → `POST /api/tts` → server → Rime. The client
sends only text: it cannot choose a voice, a model, or a URL, because the Rime
endpoint is a constant inside the server's client. The key is never logged.

### Third-party services

| Service | Required? | Used for | If absent |
|---------|-----------|----------|-----------|
| [Rime](https://docs.rime.ai) | **Yes, for the voice path** | All spoken output — the only synthesiser | Provider shows `None`; the app degrades to text and says so |
| Anthropic | No | Optional real LLM | Deterministic mock provider is the default |
| Browser Web Speech API | No | Speech recognition | UI says unsupported; typing still works |

There is **no speech-to-text service**: recognition is the browser's own Web Speech
API, so no STT credential, account or SDK exists in this project. Nothing else
is contacted, and the mock travel tools make no network calls.

### Failure behaviour

| Failure | What happens |
|---------|--------------|
| No `RIME_API_KEY` | `/api/tts` → `503`; UI shows *Voice output unavailable*; text unaffected |
| Invalid key | Rime `401` → our `502` + `tts-failed`; committed text untouched |
| Invalid speaker/model pair | Rime `400` → our `502`; the known-bad `mistv3`+`celeste` pair is refused at startup instead |
| Rime request fails | `502` + `tts-failed` event; **committed text is untouched** |
| Turn superseded before synthesis | `409` + `tts-fenced`; **no Rime credits spent** |
| Browser blocks autoplay | Explicit message asking for a click |
| Speech recognition unsupported/denied | Stated in the voice bar; text composer still works |
| Microphone denied | Mic button disabled with the reason |
| Provider/tool fails | `502`; nothing is appended — no dangling turn |

In every case the conversation transcript stays correct: speech is a
presentation layer applied *after* a reply has been committed. Playback stops
instantly when you interrupt, but nothing waits on that: the generation bump is
what makes old work obsolete.

## Known limitations

Stated plainly, because a reviewer will hit these.

**Voice output**

1. **Without `RIME_API_KEY` the app is silent.** Everything else works, and the
   UI and `/api/health` both say so, but nothing is spoken. That is a degraded
   mode, not the intended one — the interruption-of-audio behaviour cannot be
   observed in it.
2. **No streaming synthesis.** Rime documents HTTP and WebSocket streaming;
   this build sends one HTTP request per clause. Clause chunking recovers most
   of the time-to-first-audio benefit without an unverified protocol
   implementation.
3. **English only.** `lang` is fixed to `eng`. No multilingual or
   code-switched routing is attempted.
4. **`spell()` is not used — and that was measured, not assumed.** Rime
   documents it as available on `mistv3`, so it was implemented, A/B rendered
   against plain flight codes, and then removed: the extra duration did not
   grow with code length, which it must if the construct is being processed.
   Shipping it anyway risked the literal word "spell" being read aloud before
   every flight code. Flight codes are read plainly instead. Clips, timings and
   the reasoning are in [docs/RIME_EVIDENCE.md](docs/RIME_EVIDENCE.md) §4.3.
5. **No formal listening review.** Audio has been played in a browser session
   and the user-path timings are recorded in
   [docs/RIME_EVIDENCE.md](docs/RIME_EVIDENCE.md) §6.8, but nobody has sat down
   and assessed intelligibility, voice suitability and clause pacing as a
   deliberate exercise. A playable clip is committed at
   `docs/evidence/rime-mistv3-luna-hello.wav` so a reviewer can judge for
   themselves.
6. **The browser evidence is one setup.** §6.8 was recorded on a single machine,
   microphone, network and speaker. Other browsers, devices, accents and network
   conditions are untested.

**Listening**

7. **Voice activity detection is an energy threshold**, not production-grade
   VAD. It cannot tell speech from a door slam — which is exactly why tier 2
   confirmation exists before the generation advances.
8. **Browser speech recognition is not guaranteed to run on-device.** Chrome
   and Edge have historically used a remote Google service. This application
   never receives or uploads your audio, but no privacy claim about the
   *browser* is made. Firefox does not implement the API; the UI says so.
9. **Echo.** With speakers at volume the agent can hear itself and interrupt
   its own reply. Echo cancellation is requested on the microphone; headphones
   are recommended for the demo.
10. **Recognition quality is the browser’s.** Accents, noise and domain words
   are outside this project’s control.

**Application**

11. **In-memory state only.** History, generations and events live in the
    server process and are lost on restart. There is no database and no
    horizontal scaling: generation state is per-process, so a second instance
    would not share it.
12. **The default provider does not reason.** It is a deterministic stub that
    handles the three travel intents and otherwise says plainly that it cannot
    help. Set `LLM_PROVIDER=anthropic` for real replies. The stub is the
    default because it makes the acceptance test reproducible at zero cost.
13. **Tool selection is deterministic keyword matching**, not model-driven tool
    calling. This keeps the whole tool demonstration free and offline, but it
    is not how a production agent would choose a tool.
14. **The travel tools are mocks.** They return synthetic data derived from a
    hash of the input — never real flight, hotel or weather information.
15. **No token streaming.** A reply is committed whole, then spoken.
16. **Interruption is bounded by recognition latency.** Tier 1 stops audio on
    loudness within milliseconds, but the generation only advances once words
    are recognised, or after the 1200 ms confirmation window expires.

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

The **Conversation activity** panel below the composer shows the server's own
record of what happened, grouped by generation:

```
generation 1
• Generation advanced      Advanced by a new user turn.
• Provider work started    Provider work started for this turn.
• Interrupted by user      User interrupted with 1 request(s) in flight.
generation 2
• Generation advanced      Advanced by user interruption.
• Cancellation requested   Advisory only - not relied upon.
generation 1
• Result fenced            Reply for generation 1 discarded.
generation 3
• Generation advanced      Advanced by a new user turn.
• Result committed         Reply was still current and was committed.
```

The `generation 1` group reappearing after `generation 2` is the point: work
from the abandoned generation finished late and was rejected.

No API key is needed for any of this - the deterministic provider is the
default, and the whole demonstration runs locally at no cost.

### Interrupting a slow MOCK tool

This is the strongest demonstration, because the tool can be told to ignore
cancellation entirely:

```
DEV_MOCK_TOOL_DELAY_MS=1500 DEV_MOCK_TOOL_MODE=stubborn npm run dev
```

PowerShell:

```
$env:DEV_MOCK_TOOL_DELAY_MS=1500; $env:DEV_MOCK_TOOL_MODE="stubborn"; npm run dev
```

Send `Find flights from Delhi to Mumbai`, watch **Mock tool running:
searchFlights** appear, then press **Interrupt**. The tool ignores the
cancellation and finishes anyway — and its result is still thrown away:

```
generation 1
• Mock tool started            searchFlights
• Interrupted by user
generation 2
• Generation advanced          Advanced by user interruption.
• Cancellation requested       Advisory only - not relied upon.
generation 1
• Mock tool result fenced      ignored cancellation and finished, but its
                               result belonged to generation 1 while the
                               conversation is at 2. Discarded.
generation 3
• Mock tool completed          searchFlights
• Result committed
```

Run the same thing with `DEV_MOCK_TOOL_MODE=cooperative` (the default) and the
tool stops early instead, recording `Mock tool cancelled`. **Both outcomes are
correct**, and that is the point: cancellation changes how much work is wasted,
never whether a stale result can commit.

### Interrupting by voice

Same demonstration, triggered by speaking instead of clicking:

```
DEV_MOCK_TOOL_DELAY_MS=3000 DEV_MOCK_TOOL_MODE=stubborn npm run dev
```

This is the driver's situation end to end: a stop is being looked up, the driver
changes their mind out loud, and the abandoned lookup must never be spoken.

1. Press **Start listening** and allow microphone access.
2. Say `Find hotels in Jaipur`. The transcript appears and the mock tool starts
   — this is the lookup the driver is about to abandon.
3. While it is still running, talk straight over the reply:
   `Actually, make it hotels in Udaipur.`
4. Audio stops the instant you speak. That is tier 1 — **loudness only** — and
   the conversation has deliberately **not** changed yet.
5. Recognition confirms the noise was speech, and only now does the generation
   advance. That is tier 2.
6. The stubborn Jaipur lookup ignores the cancellation and finishes anyway. Its
   result is **fenced, not committed** — the driver never hears Jaipur again.
7. The new words become the next turn, and Udaipur is what gets answered.

Step 6 is the whole product. The Jaipur result was correct, complete and free of
errors; it was simply no longer what the driver asked for, so it was refused.

The chat states plainly which of the two stages happened, so a loud noise that
is never confirmed as speech is visibly *not* treated as an interruption. The
activity panel shows only what the server actually knows — that an interruption
was requested — and never claims the server heard anything, because it did not.

## Choosing a provider

Selection is by the `LLM_PROVIDER` environment variable.

### Deterministic mock (default - no API key)

Nothing to configure. With no `.env` file at all:

```
npm run dev
```

Replies are a pure function of the input, so they are predictable and testable.

**It does not reason.** It is a stub that recognises the three travel intents
and otherwise states its own scope. That is deliberate: determinism is what
makes the acceptance test in
[docs/RIME_EVIDENCE.md](docs/RIME_EVIDENCE.md) reproducible by anyone, with no
credential and no network. The replies are written to be *spoken* rather than
read, because everything committed here is handed to Rime and read aloud to
someone who cannot look at a screen.

Swap in a real model at any time with `LLM_PROVIDER=anthropic`; nothing in the
correctness path changes, and the fencing proofs assert on the server transcript
rather than on any provider’s wording, so they hold either way.

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
| `DEV_MOCK_TOOL_DELAY_MS` | no | `0` | Development aid: artificial MOCK tool latency |
| `DEV_MOCK_TOOL_MODE` | no | `cooperative` | `cooperative` or `stubborn` — how MOCK tools react to cancellation |
| `RIME_API_KEY` | **no** | – | Enables speech output. Without it the app runs fully in text mode |
| `RIME_SPEAKER` | no | `luna` | Rime voice (must be served by `RIME_MODEL`) |
| `RIME_MODEL` | no | `mistv3` | `mistv3` (low latency) or `coda` (quality) |

Real environment variables take precedence over values in `.env`, so you can
override a single setting for one run without editing the file:

```
LLM_PROVIDER=deterministic npm run dev
```

All values are read by the backend only. No key is ever sent to the browser,
and the API key is never written to the logs.

## Architecture

The conversation-versioning model, the cancellation and stale-result fencing
strategy, the scope split between core MVP and future work, and a record of how
the work was sequenced are documented in:

**[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**

## Requirements

- Node.js 22 or newer
- npm 10 or newer (workspaces)

## Setup

```
npm install
```

Then configure the voice path, which is what the demo runs on:

```
cp .env.example .env
```

Set `RIME_API_KEY` in `.env` and check it:

```
npm run preflight:rime
```

That confirms the credential is not committed anywhere, that `mistv3`/`luna`/
`eng` exists in Rime’s **live** catalogue, and that one real synthesis returns
non-silent audio.

The LLM needs no key — the deterministic provider is the default. Every
variable is documented in [.env.example](.env.example); `PORT` and `LOG_LEVEL`
fall back to `8787` and `info`.

The app also starts with **no** `.env` at all. That runs the text-only degraded
mode described under [Known limitations](#known-limitations) — useful for
working on the correctness core at zero cost, but nothing is spoken.

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
npm run typecheck        # type-check every workspace
npm run build            # production build of the web client
npm run verify           # 8 correctness suites - offline, no key, no server
npm run preflight:rime   # Rime config + secret hygiene checks
npm run audio:qa         # waveform checks on real Rime output (needs a key)
```

`npm run verify` covers generation fencing, conversation state, the event log,
voice activity detection, the generation-stamped playback queue, speech text
preparation, and tool intent parsing. It needs no credential and no network, and exits non-zero on
failure.

`npm run preflight:rime` is this project's **Rime configuration and secret
preflight**. It confirms `.env` is gitignored and untracked, that
`.env.example` holds placeholders only, that the credential appears in no
tracked file, and that the configured model/language/speaker triple exists in
Rime's **live** catalogue — queried at run time rather than compared against a
copied list, so it cannot go stale. With a credential present it also performs
one real synthesis and verifies the returned audio is not silence. Without one
it skips that step cleanly and still passes.

A full passing run is reproduced in
[docs/RIME_EVIDENCE.md](docs/RIME_EVIDENCE.md) §5.2, along with proof that it
fails correctly: run it with `RIME_SPEAKER=celeste` and it rejects the
combination instead of spending a credit on a request that cannot work.

The HTTP suites need a running server, started with both development delays —
without them a turn finishes before it can be interrupted and the suites fail
for the wrong reason:

```
DEV_DETERMINISTIC_DELAY_MS=1500 DEV_MOCK_TOOL_DELAY_MS=1500 DEV_MOCK_TOOL_MODE=stubborn npm run dev:server
```

Then `npm run verify:http`, plus `httpInterrupt` and `httpActivity`. Full
instructions, including the two suites that need their own server
configuration, are in [docs/RIME_EVIDENCE.md](docs/RIME_EVIDENCE.md) §5.

## Workspace layout

| Package | Purpose |
|---------|---------|
| `packages/shared` | Types shared by both sides. Consumed as raw TypeScript; no build step |
| `packages/server` | Fastify HTTP backend |
| `packages/web` | React + Vite client |

During development the browser talks only to the Vite dev server, which proxies
`/api/*` to the backend. There is therefore no cross-origin request and no CORS
configuration.
