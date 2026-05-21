# Build Journal — Archive

This directory is the raw build journal of The Engineer — the requirements, research, decisions, slices, and session-by-session notes captured while building the project. It spans every architectural phase from foundation through the current OSS-ready refinement work.

It is preserved here as an asset, not a chore. If you want to understand *why* The Engineer is shaped the way it is — what was tried, what was rejected, where the architectural invariants came from — this is the unedited record.

## What's inside

| Directory | Phase |
|---|---|
| `implementation-docs/0-foundation/` | Foundational vision and architectural premises |
| `implementation-docs/1-system/` | Detailed system design |
| `implementation-docs/2-components/` | Component-level architecture |
| `implementation-docs/3-interactions/` | Event catalog, protocols, adapter contracts |
| `implementation-docs/4-implementation/` | Technology stack, schemas, testing strategy |
| `implementation-docs/5-build/` | Initial implementation |
| `implementation-docs/6-refinement/` | Live-testing and refinement |
| `implementation-docs/7-restructure/` | Structural restructuring |
| `implementation-docs/8-refinement-v2/` | Second refinement pass — CLI-native architecture, dashboard, hardening |
| `implementation-docs/9-oss-ready/` | OSS-readiness slices (active work happens here) |

## Status and authority

- This is a **historical record**, not authoritative documentation. The authoritative documentation of how The Engineer works today lives in [`docs/`](../).
- Contents are preserved untouched after each phase. They are not maintained or updated.
- Some files reference old paths, old plugin names, or decisions that were later reversed. Trust the code and the main `docs/` directory over anything here.
- The journal will be removed (or pruned and consolidated) at `v1.0.0`. Until then, transparency over polish.

## How to read it

If you're a contributor or curious engineer:

- Start at `implementation-docs/0-foundation/` for the original premises.
- Each phase directory has its own README explaining what was decided there.
- `implementation-docs/9-oss-ready/active.md` shows the most recent active work.
