# Active — Phase 9: OSS Ready

> **ALWAYS READ BEFORE PROCEEDING.** Then read [approach.md](approach.md) and the current slice file.
> These references are permanent. Never remove them.

## Key Files

- [vision.md](vision.md) — why we're doing this, what done looks like
- [approach.md](approach.md) — strategy, lenses, co-founder rules, session protocol
- Current slice: `slices/01-standards-alignment.md` (not yet created — first session work)

## Current State

**Phase:** 9 — OSS Ready
**Session:** 0 (brainstorm complete, no implementation yet)
**Slice:** Pre-work — Phase 9 foundations written

### What's Done

- Vision, approach, and active files created
- 16-slice roadmap defined
- Lenses established (resilience, plugin integrity, plugin authoring simplicity, UX quality)
- Co-founder dynamic agreed
- Strategy agreed: vertical slices, RRPIR per slice, tangents welcome, no coming back

### What's Next

**Session 1: Standards Alignment (Slice 1)**

The agent probes Farzam for coding standards, naming conventions, style preferences, and what "beautiful code" means specifically to him. This becomes the law for all subsequent slices.

Topics to probe:
- Naming conventions (files, variables, functions, classes, types)
- Code organization within files (ordering of exports, helpers, types)
- Import style and organization
- Error handling patterns
- Function style (arrow vs declaration, length limits, parameter patterns)
- Comments philosophy (when, where, what style)
- Type patterns (interfaces vs types, generics style, Zod patterns)
- Test file organization and naming
- What makes code "beautiful" vs "acceptable" to Farzam specifically
- Examples from the codebase of code he loves vs code he hates

### Decisions Made This Session

- Vertical slice strategy with two permanent lenses (resilience, plugin integrity) + two additional (authoring simplicity, UX quality)
- Plugin architecture is the moat — never compromise genericity
- Every commit is green. Every slice is done fully. No coming back.
- Zero backward compatibility. Consolidate migrations. Prompts are preview.
- Main branch by default. Branches only for temporary breakage.
- RRPIR methodology for each slice
- Tangents are welcome — active.md tracks state
- Session logs in 9-oss-ready/sessions/, starting at 1.md
- future-considerations.md gets a fresh version in docs/
- npm publish readiness is the final slice
- Dashboard early (slice 3) to expose API/data gaps, revisited near end (slice 15)
- Standards alignment first (slice 1) so all subsequent work is consistent
