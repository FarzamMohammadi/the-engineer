# Slice 1: Standards Alignment

## Status: COMPLETE

## What Was Done

Probed Farzam for coding standards across 10 categories. Researched eclectic sources (Ousterhout, Hickey, Muratori, Metz, Bernhardt, King, Knuth, DDD, Unix, Gestalt psychology, Google/Deno style guides). Made deliberate decisions for each category through Q&A.

Output: `docs/standards.md` — the law for all subsequent slices.

## Key Decisions

1. **File Structure** — Newspaper order. `function` declarations (hoisting enables caller-above-callee). Section dividers sparingly.
2. **Naming** — kebab-case files. snake_case schemas. Full names, no abbreviations. Acronyms as words. No vague -ER suffixes.
3. **Functions** — Ousterhout pragmatic length. 2-3 params then options object. Guard clauses always. Strict FCIS.
4. **Types** — interface for contracts, type for unions. Branded IDs by default. Schema-first Zod. Always annotate return types.
5. **Errors** — Results for expected, exceptions for unexpected. Deno-style messages. Bubble unless you can meaningfully handle.
6. **Imports** — Barrels for public API only. No default exports. Separate import type. Formatter handles ordering.
7. **Modules** — One concept per file. Split on change-reason divergence. Tests in separate `tests/` mirroring `src/`.
8. **Comments** — Minimal (WHY only). JSDoc one-liner on every export. TODOs with author + context.
9. **Testing** — Nested describe (max 2). Behavior-as-fact naming. Mock only system boundaries. Don't test what compiler proves.
10. **Layout** — Biome. 120 chars. Semicolons. Trailing commas. Double quotes. 2-space indent.

## Discovered From Other Slices

(None yet — this is the first slice.)
