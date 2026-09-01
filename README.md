# InterruptSafe

A full-duplex voice agent that never continues an outdated conversation: when the
user interrupts, playback stops, the conversation advances to a new generation,
and results from the superseded generation can no longer re-enter it.

## Current development status

**Phase 0 of 16 - architecture approved, documentation only.**

No application code exists yet. This repository currently contains the approved
architecture plan and project scaffolding files. Frontend and backend packages
are created in Phase 1.

| Phase | Status |
|-------|--------|
| 0 - Project planning and architecture | Complete |
| 1 - Frontend and backend structure | Not started |
| 2-16 | Not started |

## Architecture

The approved design, the conversation-versioning model, the cancellation and
stale-result fencing strategy, the scope split between core MVP and future work,
and the full phase plan are documented in:

**[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**

## Setup

Not applicable yet. Environment variables are documented in
[.env.example](.env.example); copy it to `.env` when Phase 1 begins.
