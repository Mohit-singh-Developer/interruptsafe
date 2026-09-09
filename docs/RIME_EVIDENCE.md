# RIME_EVIDENCE

Evidence for the hard voice claim made by InterruptSafe.

**Honesty statement, up front.** Every result marked **MEASURED** was produced
by running the commands given, against the real Rime API with a real key.
Nothing is invented. One thing remains outside what an automated run can
establish: **nobody has listened to the audio yet.** The clips are verified to
be genuine non-silent WAVE speech waveforms of the right duration, and a
playable sample is committed at `docs/evidence/rime-mistv3-luna-hello.wav`, but
Rime's own quickstart is right that "hearing speech is the success condition" —
that final step needs a human ear.

---

## 1. Claim

> When a user interrupts a voice turn, InterruptSafe stops the obsolete speech
> immediately, and work belonging to the abandoned turn — a slow tool, a model
> reply, or queued speech audio — **can never become the current answer**, even
> when that work ignores cancellation entirely and completes successfully.

The sharp part of the claim is the last clause. Most systems rely on cancelling
the old work. InterruptSafe assumes cancellation fails, and is still correct.

## 2. Acceptance test

Defined before the demo. The system passes only if **all** of these hold:

| # | Criterion |
|---|-----------|
| A1 | A tool with a fixed 3 s delay starts, and the user interrupts mid-run |
| A2 | The conversation generation advances on confirmed speech |
| A3 | The tool **ignores** the abort and completes normally |
| A4 | Its result is rejected and **never enters conversation history** |
| A5 | The rejection is visible as a `tool-result-fenced` event |
| A6 | The next turn commits normally at the new generation |
| A7 | Queued speech audio for the old generation becomes inaudible |
| A8 | Old-generation audio never plays into the new answer |
| A9 | A second conversation is completely unaffected |
| A10 | No Rime credits are spent synthesising a superseded turn |

## 3. Exact setup

```
node --version        # v22.14.0 used here
npm install
```

Zero credentials are required for A1–A9. A10 is provable with a deliberately
invalid key.

## 4. Exact Rime configuration (the shipped path)

| Field | Value |
|-------|-------|
| Provider | Rime |
| Model ID | `mistv3` |
| Speaker | `luna` |
| Language | `eng` |
| Endpoint | `https://users.rime.ai/v1/rime-tts` |
| Audio format | `audio/wav` (requested via `Accept`) |
| Transport | HTTPS request/response, **one request per clause**; audio returned to the browser over the app's own HTTP origin and played with `HTMLAudioElement` |
| Region | **US West (us-west-2)**. `users.rime.ai` is Rime's documented default alias for `users-west`; `users-east` (us-east-1) is the alternative. Rime publishes US regions only |
| Auth | `Authorization: Bearer <RIME_API_KEY>`, server-side only |
| Request body | `{ text, speaker, modelId, lang }` — no undocumented parameters |

**Catalog check (MEASURED).** `mistv3` and `luna` were checked against Rime's
live catalog at `https://users.rime.ai/data/voices/all-v2.json`. `luna` is an
English voice present on **both** `mistv3` and `coda`, so changing model does not
invalidate the voice.

This check found a real defect: an earlier default of `mistv3` + `celeste` is
**invalid** — `celeste` is a `coda` voice and is not offered on `mistv3`. The
server now refuses that pairing at startup rather than failing on the first
spoken turn:

```
Configuration error: RIME_SPEAKER "celeste" is a coda voice and is not available
on mistv3. Use a mistv3 English voice such as luna, or set RIME_MODEL=coda.
```

`mistv3` was chosen over `coda` deliberately. Rime's models page describes
`mistv3` as optimised for "lowest time to first audio", quoting approximately
37 ms P50 — **their figure, not ours**, and quoted here only as the basis for
the choice. For an interruption-focused agent, time-to-first-audio matters more
than maximum fidelity. The cost is language coverage: `mistv3` serves 4
languages against coda's 9, which this project can afford because it ships
English only.

**Region and network honesty.** Rime publishes US regions only, so a demo
recorded outside the US crosses an ocean before synthesis begins. Every
server-side figure this project reports is wall-clock around one `fetch` and
therefore *includes* that transit; none of them is a time-to-first-byte
measurement, and none should be compared against Rime's own 37 ms P50, which is
model latency. Choosing `users-east` would change the number for a reviewer on
the US East coast and is a one-constant edit, but no such measurement is
claimed here because none was taken.

### 4.1 Text preparation before synthesis

Rime's prompting guide and "Writing for the ear" both make the same point: text
written to be read is not text written to be heard. `packages/shared/src/speechText.ts`
prepares every reply before synthesis, and is applied on the client before
chunking and again on the server before the Rime call (it is idempotent).

Applied rules, each from the official guidance:

| Rule | Source | Example |
|------|--------|---------|
| Remove markdown, bullets, headings, code fences | Writing for the ear | `- IS486` → `IS486` |
| Rewrite symbols and arrows as words | Writing for the ear | `Delhi -> Mumbai` → `Delhi to Mumbai` |
| Flatten parenthetical asides | Writing for the ear | `(synthetic)` → `, synthetic,` |
| Write out non-dollar currency | Prompting guide | `INR 3586` → `3586 rupees` |
| Keep spoken sentences under 25 words | Prompting guide | long sentences are split at commas |
| Never send SSML or inline tags | Prompting guide | any `<…>` tag is stripped |

**`spell()` is not used — and this was measured, not assumed.** An earlier
version of this document claimed `spell()` was unavailable on `mistv3`. That was
wrong, and the correction is recorded here rather than quietly edited away:
Rime's models page lists `spell()` as supported on **both** `mistv3` and `coda`,
while inline *phoneme* control is the separate feature restricted to Mist v2.
The spell() page adds that "spell() is a Mist-family feature; Coda's pipeline
does not process it", so the two pages disagree about coda — but agree that
`mistv3`, which this project ships, has it.

So it was implemented, tested against the live API, and then removed. Section
4.2 has the numbers.

**MEASURED.** The real mock-tool reply, captured from a running server and put
through `prepareForSpeech`:

```
3 mock flights from Delhi to Mumbai. IS486 Delhi to Mumbai departs 08:00
approx 3586 rupees. IS499 Delhi to Mumbai departs 15:00 approx 3897 rupees.
IS512 Delhi to Mumbai departs 10:00 approx 4208 rupees.
```

Before this change the synthesiser would have been sent `- IS486  Delhi ->
Mumbai  approx INR 3586`, i.e. "dash I S four eight six, Delhi hyphen
greater-than Mumbai, approx I N R". Verified idempotent, and verified not to
alter the semantic content of the reply.

### 4.2 What is disclosed on screen rather than spoken

An earlier build prefixed every tool reply with *"MOCK DATA from searchFlights —
synthetic, not real information"* and answered ordinary questions by echoing the
user's words back with a character count. Both were honest, and both were wrong
for this product: they were **spoken aloud, in full, on every turn**, to a
listener who cannot look at a screen. The disclaimer alone cost roughly four
seconds before every answer, and it became the first clause — so it was also the
first thing synthesised, delaying the useful audio.

Disclosure now lives in the UI, in the activity timeline and in the README. The
word "mock" remains in every tool summary, which is where a listener will
actually hear it, and the first clause is now the answer:

```
clause 1 (first Rime request):  3 mock flights from Delhi to Mumbai.
clause 2:                       IS486 Delhi to Mumbai departs 08:00 approx 3586 rupees.
```

**Rate units.** Hotel rows read `approx 3056 rupees/night`, and a bare slash is
pronounced "slash". `speakSymbols` now rewrites a slash before a known rate unit
as " per ", while leaving ordinary uses such as `and/or` alone. Both cases are
covered by `npm run verify`.

### 4.3 The `spell()` experiment — MEASURED, negative result

The problem statement asks that a delivery claim be proved by holding model and
voice constant, rendering at least two text variants, and explaining which
wording changed the result. This is that test, and the result is negative.

Flight codes like `IS486` are the kind of identifier a listener may need to
write down, and `spell()` is documented as available on `mistv3`. The question
was whether it does anything through the shipped HTTP path.

**Method.** `mistv3` / `luna` / `eng` held constant. For each code, two variants
were synthesised — `Flight <CODE> departs.` and `Flight spell(<CODE>) departs.`
Duration was computed from the PCM payload (24 kHz, 16-bit mono, 44-byte
header), not from the request time, so network variance does not enter.

**The discriminator.** If `spell()` is processed, the extra duration must *grow
with code length* — there are more characters to enunciate. If Rime is instead
reading the literal word "spell", the delta stays roughly constant.

| Code | plain | `spell()` | delta |
|------|-------|-----------|-------|
| `IS4` | 2.24 s | 2.24 s | +0.00 s |
| `IS486` | 2.89 s | 3.15 s | +0.26 s |
| `ABCD12345678` | 5.82 s | 5.70 s | **−0.12 s** |

**Result: no evidence that `spell()` is processed on this path.** The delta does
not grow with code length, and for the twelve-character code the `spell()` clip
was *shorter* than the plain one — the opposite of what enunciating twelve
characters would produce.

**Decision: not shipped.** The implementation was written (it required exempting
`spell()` from parenthetical flattening, and a lookbehind to stay idempotent)
and then removed. If Rime does not process the construct, the most likely
audible outcome is the word "spell" being read aloud before every flight code —
a visible regression traded for a benefit that could not be demonstrated.

**Limitation.** This measures duration, not intelligibility. It is possible that
`spell()` is processed and simply produces audio of similar length; only
listening would settle that. What can be said is that no measurable effect was
found, and an unverified delivery claim is worth less than an honest negative.

## 5. Procedure

### 5.1 Automated (zero cost, no credentials)

Everything below is committed and runnable from a clean checkout.

```
npm install
npm run typecheck
npm run build
npm run verify            # 8 offline suites: fencing, generation, conversation
                          # state, events, VAD, playback queue, speech text,
                          # tool intent
```

`npm run verify` needs no credential, no network and no running server. It exits
non-zero if any suite fails, so it works in CI.

The HTTP suites need a running server, and they need it started with **both**
development delays. Three of the four interrupt work while it is still in
flight, so without an artificial delay the mock finishes first and there is
nothing to interrupt — the suites then fail for the wrong reason.

In one terminal:

```
DEV_DETERMINISTIC_DELAY_MS=1500 DEV_MOCK_TOOL_DELAY_MS=1500 DEV_MOCK_TOOL_MODE=stubborn npm run dev:server
```

PowerShell:

```
$env:DEV_DETERMINISTIC_DELAY_MS=1500; $env:DEV_MOCK_TOOL_DELAY_MS=1500; $env:DEV_MOCK_TOOL_MODE="stubborn"; npm run dev:server
```

and in another:

```
npm run verify:http                      # A1-A6, A9 - tool interruption + fencing
npx tsx scripts/http/httpInterrupt.ts    # text-path interruption
npx tsx scripts/http/httpActivity.ts     # activity timeline + transcript
```

All three report `ALL CHECKS PASSED` against that one server.

The fourth suite asserts behaviour with **no** credential configured, so it
needs a server started without `RIME_API_KEY`:

```
npx tsx scripts/http/httpTts.ts unconfigured   # graceful no-credential behaviour
```

For A10, restart the server with a deliberately invalid key and run:

```
npx tsx scripts/http/httpTts.ts fakekey
```

### 5.2 Rime configuration and secret preflight

```
npm run preflight:rime
```

Checks, in order: `.env` is gitignored and untracked, `.env.example` carries
placeholders only, the configured credential appears in no tracked file, the
model/language/speaker triple exists in Rime's **live** catalogue, and — only if
a credential is present — one real synthesis returns non-silent WAVE audio.

It skips cleanly with no credential, and it refuses to spend one if the
configuration is already wrong. Verified to fail correctly: running it with
`RIME_SPEAKER=celeste` reports

```
FAIL  speaker "celeste" is served by mistv3/eng — not in catalogue
SKIP  real synthesis — configuration failed above; fix that first
```

which is the exact defect this project shipped with before the catalogue was
checked.

### 5.3 Manual (browser)

1. `DEV_MOCK_TOOL_DELAY_MS=3000 DEV_MOCK_TOOL_MODE=stubborn npm run dev`
2. Open `http://localhost:5173` in Chrome or Edge.
3. Say (or type) **"Find flights from Delhi to Mumbai"**.
4. While *Mock tool running: searchFlights* is shown, say **"Actually, make it Delhi to Bangalore."**
5. Observe the activity timeline and the transcript.

## 6. Results

### 6.1 Normal run — MEASURED

Zero configuration, deterministic provider, mock tools. All three tools return
clearly-labelled synthetic data; multi-turn history works; the activity timeline
populates. `GET /api/health` reports `"speech": { "provider": "none" }` when no
credential is set, so the active provider is never ambiguous.

### 6.2 Stress run: interrupt a stubborn 3 s tool — MEASURED

Recorded server-side event sequence, taken verbatim from the automated run:

```
1:generation-advanced
1:turn-started
1:tool-started (searchFlights)
1:interruption-requested
2:generation-advanced
2:cancellation-requested
1:tool-result-fenced (searchFlights)   <-- ignored cancellation, finished, REJECTED
3:generation-advanced
3:turn-started
3:tool-started (searchHotels)
3:tool-completed (searchHotels)
3:result-committed
```

The `generation 1` group reappearing *after* generation 2 is the whole claim: the
abandoned tool finished late and was refused.

| Criterion | Result |
|-----------|--------|
| A1 | **PASS** — tool started, interrupted at ~400 ms into a 3 s run |
| A2 | **PASS** — generation advanced 1 → 2 |
| A3 | **PASS** — `stubborn` mode ignores the abort and returns a full result |
| A4 | **PASS** — transcript contained **zero** committed exchanges for that turn |
| A5 | **PASS** — `tool-result-fenced` recorded with both generations |
| A6 | **PASS** — next turn committed at generation 3 |
| A7 | **PASS** — see 6.3 |
| A8 | **PASS** — see 6.3 |
| A9 | **PASS** — second conversation started at its own generation 1, unaffected |
| A10 | **PASS** — see 6.4 |

A4 is proved from the server's own transcript, read back through
`GET /api/conversations/:id/activity`: after the fenced turn it holds exactly
**one** committed exchange, that exchange is the *new* question, and the
abandoned question appears nowhere in it.

This proof deliberately does not read the provider's reply text. An earlier
version asserted that the reply lacked a particular phrase the mock emits —
which tied a correctness proof to whichever provider happened to be configured,
so switching to a real model would have silently destroyed the evidence. The
transcript is what the conversation actually contains, so the proof holds for
any provider.

### 6.3 Playback flushing — MEASURED (headless, stubbed audio element)

The playback queue stamps every clip with its generation. Verified:

- advancing the generation discarded the queued clips **and paused the one
  playing** (`dropped = 2`, `paused = true`);
- a late `ended` event from the superseded clip started nothing;
- new-generation audio then played normally;
- `flush()` reported how many queued clips it discarded.

This test found and fixed a real defect: the queue previously **deadlocked**
after a flush, because the promise for the stopped clip was never settled — so
no new-generation audio would ever have played. That is precisely the failure
A8 guards against, and it would have broken the demo.

A **second** deadlock, distinct from the first, was found later in the same
queue and is now covered by a regression test. `audio.play()` resolves
asynchronously — the browser decodes before playback begins — and an
interruption landing inside that window stopped the clip *before* its completion
promise existed, so nothing could ever settle it. The drain loop was then left
awaiting forever with its `draining` flag stuck true, which silently disabled
**all** later audio including the new generation's: the interruption appeared to
work, and the application never spoke again for the rest of the session.

That window is not an unlikely one. It is the moment the assistant starts
talking, which is precisely when a user barges in. The test holds `play()`
pending, interrupts, and then asserts that new-generation audio still plays;
removing the guard makes it fail.

**Limitation:** this is a headless test with a stubbed `HTMLAudioElement`. It
proves the queue's logic, not the browser's audio-device behaviour.

### 6.4 No credits spent on superseded speech — MEASURED (invalid key)

With `RIME_API_KEY` set to a deliberately invalid value, a synthesis request
carrying a stale generation returned `409 superseded`, recorded a `tts-fenced`
event, and recorded **no** `tts-started` event — i.e. Rime was never called.

### 6.5 Real Rime synthesis — MEASURED

Run against the live API with a real key on 2026-09-08.

**Direct call, the shipped configuration** (`mistv3` / `luna` / `eng`,
`Accept: audio/wav`):

```
HTTP 200 · 105,370 bytes · first four bytes "RIFF"
RIFF (little-endian) data, WAVE audio, Microsoft PCM, 16 bit, mono 24000 Hz
```

**Through our own `/api/tts`**, sending the real mock-tool reply with bullets,
arrows and `INR`:

```
HTTP 200 · 736,210 bytes · RIFF/WAVE · X-Rime-Upstream-Ms: 3041
```

**Full chain** — chat → tool → `fencedCommit` → generation-stamped `/api/tts`:

```
HTTP 200 · 1,426,122 bytes · RIFF/WAVE
```

**Waveform analysis** (decoded PCM, not just headers) — this is what
distinguishes real speech from a valid-but-silent file:

| Clip | Duration | Peak | Audible samples | Verdict |
|------|----------|------|-----------------|---------|
| "Hello! This is Rime speaking." | 2.19 s | 91.7% FS | 84.9% | real waveform |
| Prepared demo clause | 15.34 s | 91.1% FS | 92.4% | real waveform |
| Committed tool reply | 29.71 s | 92.0% FS | 92.8% | real waveform |

2.19 s is the right length for that sentence spoken naturally. A committed,
playable copy of the first clip is at
`docs/evidence/rime-mistv3-luna-hello.wav`.

The credential appeared **0 times** in server logs across every run.

### 6.6 Failure modes — MEASURED against the live API

| Condition | Rime returns | We return |
|-----------|--------------|-----------|
| Invalid API key | `401 invalid api key` | `502`, generic message |
| Invalid speaker/model pair | `400` `Speaker 'celeste' not found in any backend speaker map for language 'en'` | `502`, generic message |
| Unrecognised `Accept` | `406` | `502`, generic message |
| Turn already superseded | *never called* | `409 superseded` |

The second row is worth dwelling on. Rime **does** reject an invalid pairing,
with a 400 — so the earlier default of `mistv3` + `celeste` would have failed
every spoken turn of the demo. The startup guard added for that is not
hypothetical.

### 6.7 A bug this testing found — and it only appeared with a real key

The first real request through `/api/tts` returned `502` after 181 ms, with
`"reason":"This operation was aborted"`. The cause: the route listened on
`request.raw`'s `close` event to detect the browser going away, but Fastify
fully consumes the request body before the handler runs, so that event fires on
**normal completion**. Every synthesis was cancelling itself.

It now listens on `reply.raw` and aborts only when `writableFinished` is false,
which distinguishes a real disconnect from a completed response. **Speech had
never once worked through the server before this fix**, and no amount of
testing with an invalid key would have revealed it — the 502 looked like an
auth failure.

## 7. Measurements

The application measures and displays, in the browser:

| Metric | Meaning |
|--------|---------|
| Turn → first audio | Submit to first assistant audio actually playing |
| Loudness → audio stopped | Detection to queue flush (JS time only) |
| Loudness → speech confirmed | Tier 1 detection to tier 2 confirmation |
| Interrupt round trip | `POST /api/interrupt` request to generation advanced |
| Rime request (server-side) | Whole-request duration, **includes network** |
| Queued clips discarded | Clips dropped by the last flush |

**No latency figures are published in this document.** They depend on a live Rime
key and on the reviewer's machine and network. The application shows the values
it actually measured; nothing is precomputed or asserted here.

**Cached vs uncached:** no caching layer exists. Every clause is a fresh Rime
request, so all figures the app displays are uncached. Should caching ever be
added, this section must distinguish the two.

**Precision:** timings are `performance.now()` deltas in the browser and exclude
audio-device output latency, which the page cannot observe. The Rime figure is
wall-clock around one `fetch` on the server and does **not** separate provider
time from network time, and is **not** a time-to-first-byte measurement.

## 8. Limitations

1. **PARTIALLY VERIFIED: nobody has listened yet.** Synthesis is confirmed to
   return genuine, non-silent WAVE speech of the correct duration through the
   full shipped path, and a playable clip is committed. What automated checks
   cannot establish is intelligibility, voice suitability, or clause pacing.
   Play `docs/evidence/rime-mistv3-luna-hello.wav` — it should say *"Hello! This
   is Rime speaking."* — and run the browser demo once to confirm playback and
   pacing in situ.
2. **UNVERIFIED: live browser behaviour.** Microphone capture, speech
   recognition, and audio playback were not exercised in a real browser by the
   author; they are covered by headless tests and typechecking only.
3. **Voice activity detection is an energy threshold**, not production VAD. It
   cannot distinguish speech from a door slam — which is exactly why tier 2
   confirmation exists.
4. **Browser speech recognition is not guaranteed on-device.** Chrome and Edge
   have historically used a remote Google service. The application never
   receives the audio, but no privacy claim about the browser is made. Firefox
   does not implement the API; the UI says so and text still works.
5. **No streaming synthesis.** Rime documents HTTP and WebSocket streaming;
   this build uses one HTTP request per clause. Chunking gives most of the
   latency benefit without an unverifiable protocol implementation.
6. **Echo:** with speakers at volume the agent can hear itself. Echo
   cancellation is requested on the microphone; headphones are recommended.
7. **In-memory state only.** History, generations and events are lost on restart.

## 9. Reproduction

The shortest path that demonstrates the claim, with no credentials at all:

```
npm install
npm run verify                                    # correctness suites, offline
npm run preflight:rime                            # config + secret checks
DEV_MOCK_TOOL_DELAY_MS=3000 DEV_MOCK_TOOL_MODE=stubborn npm run dev
# open http://localhost:5173, ask for flights, then interrupt mid-run
```

To exercise the Rime path, add `RIME_API_KEY` to `.env` and repeat.
`npm run preflight:rime` will then also perform one real synthesis and confirm
the audio is not silence. The **Speech provider** panel in the UI states which
provider is active, so a reviewer never has to guess whether Rime produced the
audio.

Expected output of a full passing preflight with a credential configured:

```
1. Secret hygiene
  PASS  .env is gitignored
  PASS  .env is not tracked by git
  PASS  .env.example carries placeholders only
  PASS  credential appears in no tracked file
2. Configuration against Rime's live catalogue
  PASS  model "mistv3" exists
  PASS  model "mistv3" supports language "eng"
  PASS  speaker "luna" is served by mistv3/eng — 62 voices available
3. Live synthesis
  PASS  response is WAVE audio
  PASS  audio is not silence
PREFLIGHT PASSED
```
