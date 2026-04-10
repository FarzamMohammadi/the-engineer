# Research: Cross-CLI Portable Skills System

## Task Context
Decouple skills from `.claude/skills/` (Claude Code-specific) so they work with any CLI tool. Skills should be injected via the orchestrator's prompt assembly — the same mechanism that already controls CLI behavior. Two skills in scope: `commit` and `expert-panel-review`. Full details in requirements.md.

## Codebase Analysis

### Prompt Assembly Pipeline (the injection point)

The orchestrator controls CLIs through two prompts:

1. **System prompt** — `buildCliNativeSystemPrompt(phase)` in `src/core/orchestrator/prompts/system.ts`. Assembles: IDENTITY + HOW_WE_WORK + RRPIR_METHODOLOGY + SECURITY_BOUNDARY + PHASE_GUIDANCE[phase]. This is **phase-aware** (different PHASE_GUIDANCE per phase) but otherwise static content.

2. **Phase prompt** — Phase-specific builder functions (e.g., `buildExecutionPrompt(ctx)`) in individual files under `prompts/`. These follow a 5-section structure: (1) RRPIR Overview, (2) Prior Phases, (3) Instructions, (4) Output Section, (5) Task Context. All are **pure functions**: context in, prompt string out.

Both prompts are assembled in `phase-handlers.ts`, which calls `llmCaller.runPhaseWithCli(phase, taskId, systemPrompt, phasePrompt, state, thoughtsDir)`.

### How Phase Handlers Wire It Together

`createPhaseHandlers(llmCaller, ctx)` in `phase-handlers.ts` creates all 7 handlers. Each:
1. Builds the system prompt: `buildCliNativeSystemPrompt(phase)`
2. Builds the phase prompt: `buildXxxPrompt({...context})`
3. Calls `llmCaller.runPhaseWithCli(...)` which wraps these into an `InferenceRequest { prompt, system_prompt, cwd, trace_output_path }`

The `InferenceRequest` only carries `prompt` (string) and `system_prompt` (string | null). Skills must be embedded as text in one of these two strings.

### Existing Skills in `resources/skills/`

5 files total:
- `resources/skills/commit/SKILL.md` — ~116 lines. Commit strategy with 4 levels of detail + execution format.
- `resources/skills/expert-panel-review/SKILL.md` — ~228 lines. 3-panelist review with discovery, process, synthesis.
- `resources/skills/expert-panel-review/personas/technical-architect.md` — ~40 lines
- `resources/skills/expert-panel-review/personas/critical-reviewer.md` — ~40 lines
- `resources/skills/expert-panel-review/personas/pragmatic-senior-engineer.md` — ~40 lines

**Total token estimate**: ~4500-5000 tokens for all skill content combined. The expert-panel-review skill references persona files relative to itself ("in the `personas/` directory alongside this skill").

### No Existing Resource Loading Mechanism

Despite `resources/README.md` claiming files are "copied to `~/.engineer/` at startup," **no code does this**. The `resources/` directory has no loader. The word "resources" in source code only appears in GitHub API rate-limit contexts and OS resource cleanup.

The `how-we-work.md` resource (commit `9b3d2ef`) was later **embedded directly into the system prompt** as a string constant (commit `bb2be0b`). There is no file-based resource loading pattern established.

### No Existing Tests for Prompt Builders

There are **zero test files** for any prompt builder (`system.ts`, `execution.ts`, `review.ts`, etc.). Tests exist for `llm-caller.ts`, `phase-runner.ts`, and `index.ts` (orchestrator), but prompt assembly is untested. This means we need to create new test files following existing patterns.

## Relevant Files

### Files That Will Change

- `src/core/orchestrator/prompts/system.ts` — **Primary injection point.** If skills go in system prompt, this file changes. Currently exports `buildCliNativeSystemPrompt(phase)`. Would need to accept skills content or build it internally.
- `src/core/orchestrator/prompts/execution.ts` — If skills go in phase prompts instead, this needs to embed `commit` skill content.
- `src/core/orchestrator/prompts/review.ts` — Would embed `expert-panel-review` skill content for self-review phases.
- `src/core/orchestrator/prompts/integration.ts` — Would embed `commit` skill content (commits happen during integration).
- `src/core/orchestrator/phase-handlers.ts` — If the skill loader is a dependency injected via context, phase handlers would pass skill content to prompt builders.
- `src/core/orchestrator/prompts/index.ts` — Barrel file, would export new skill-related functions.

### New Files Needed

- **Skill loader module** — reads skill markdown from disk, returns content keyed by skill name. Location: likely `src/core/orchestrator/prompts/skills.ts` or `src/core/orchestrator/skills.ts`.
- **Tests** — at minimum `skills.test.ts` for the loader, plus prompt assembly tests verifying skills appear in correct phases.

### Context Files (read-only reference)

- `src/core/orchestrator/prompts/format.ts` — Shared helpers: `section()`, `wrapUntrustedContent()`, `buildRRPIROverview()`, `buildTaskBrief()`, `buildKnowledgeSection()`, `buildRepoOverview()`.
- `src/core/orchestrator/llm-caller.ts` — Bridges prompt assembly to LLM adapter. `runPhaseWithCli()` takes `systemPrompt` and `prompt` strings.
- `src/core/orchestrator/types.ts` — `OrchestratorContext`, `PipelineState` types.
- `src/schemas/orchestrator.ts` — `Phase`, `Phases` enum, `PhaseOutput`, `SessionResult` schemas.
- `src/schemas/adapters.ts` — `InferenceRequest` schema (`prompt`, `system_prompt`, `cwd`, `trace_output_path`).
- `src/adapters/llm.ts` — `LLMAdapter` abstract class with `infer(InferenceRequest)`.
- `resources/skills/**/*` — The actual skill markdown files (5 files).
- `resources/README.md` — Documents the resource convention.

## Patterns & Conventions

### Coding Style
- TypeScript strict mode, ES modules with `.js` extensions in imports
- `const` for all constants, `function` declarations (not arrow functions) for named exports
- Section comment headers: `// ── Section Name ─────────────────────────────────`
- Pure functions preferred — context in, result out, no side effects
- Zod schemas for all data contracts

### Test Patterns
- Framework: Vitest 3.1.4
- Tests co-located with source: `module.test.ts` alongside `module.ts`
- `describe()` blocks grouped by feature, `it("should ...")` naming
- `vi.fn()` for mocking, `vi.mock()` for module mocks
- `createMock*()` helpers for complex context objects
- `expect().toBe()`, `expect().toContain()`, `expect().toHaveBeenCalledWith()` assertions

### Directory Structure
- Prompt builders live in `src/core/orchestrator/prompts/`
- Each prompt builder is a single file with types + public API + internal helpers
- Barrel export in `prompts/index.ts`

### Import Style
- Relative paths with `.js` extension: `import { foo } from "./bar.js"`
- Type imports: `import type { Foo } from "./types.js"`

## Architectural Patterns in Target Files

### `system.ts` Pattern
- Constants defined as module-level `const` strings (IDENTITY, HOW_WE_WORK, etc.)
- `PHASE_GUIDANCE` is a `Record<Phase, string>` map
- Single public function `buildCliNativeSystemPrompt(phase)` joins sections with newlines
- No external dependencies beyond the `Phase` type
- No file I/O — all content is string constants

### Phase Prompt Builder Pattern (`execution.ts`, `review.ts`, `integration.ts`)
- Export interface for context type (e.g., `ExecutionPromptContext`)
- Single public `build*Prompt(ctx)` function
- Internal helper functions for each section (`buildPriorPhasesSection`, `buildInstructions`, etc.)
- Uses `section()` from `format.ts` for consistent heading formatting
- Returns string (all parts joined with `\n\n`)
- Pure functions — no side effects, no file I/O

### `phase-handlers.ts` Pattern
- Factory function `createPhaseHandlers(llmCaller, ctx)` returns `Record<Phase, PhaseHandler>`
- Each handler is a closure that captures `llmCaller` and `ctx`
- Handlers call prompt builders directly, then `llmCaller.runPhaseWithCli()`
- No intermediate abstractions — direct function calls

## Dependencies & Integration Points

### What This Change Touches
1. **Prompt assembly** — Core skill content injected into prompts sent to CLIs
2. **File system** — New module reads markdown files from `resources/skills/` at runtime (or build time)
3. **Phase routing** — Which skills appear in which phases (mapping concern)

### What Depends On It
- **Every CLI plugin** (ClaudeCodeLLM, etc.) — receives skills via prompt, no plugin changes needed
- **Every RRPIR phase** — affected only for phases that receive skills
- **Existing tests** — no test touches prompt content directly, so existing tests should be unaffected

### Ripple Effects
- Token consumption increases for phases that receive skills (~2000-5000 extra tokens per phase)
- If skills are in the system prompt, ALL phases get the token cost. If in phase prompts, only relevant phases pay.

## Contract Verification

### InferenceRequest Contract
The `InferenceRequest` schema carries `prompt` and `system_prompt` as plain strings. Skills embedded in either string will pass through the adapter contract without any adapter changes. Verified in `src/schemas/adapters.ts`.

### LLM Adapter Contract
`LLMAdapter.infer(request)` is abstract — plugins implement `doInfer()`. The adapter applies no transformation to the prompt content. Skills in the prompt string will reach the CLI tool unchanged. No adapter changes needed.

### Plugin Blindness
The skill loader lives in Core (prompt assembly). It reads static files from `resources/`. No plugin is aware of skills — they just see a longer prompt string. Plugin Blindness is preserved.

## Complexity Assessment

**Moderate.** The architecture is well-understood. The injection point (prompt assembly) is clear. The main work is:
1. A skill loader module (~50-80 lines)
2. A phase-to-skill mapping (~20 lines)
3. Modifications to prompt builders to include skill content (~30-50 lines across 2-3 files)
4. Tests for the new module and prompt assembly changes (~150-200 lines)

No new adapter contracts, no schema changes, no plugin modifications, no configuration changes.

## Open Questions

1. **System prompt vs phase prompt injection**: System prompt means skills appear in every phase (wasteful for phases that don't need them). Phase prompt means skills are only in relevant phases (more precise, less token waste). Phase prompt is the better fit, but it means modifying multiple prompt builder files. **Recommendation**: Phase prompt injection — it's cleaner and more efficient.

2. **Where to read skill files from**: `resources/skills/` in the repo source (available at build/runtime, simple) vs `~/.engineer/resources/skills/` (requires copy mechanism that doesn't exist). **Recommendation**: Read from the repo's `resources/skills/` directory using `__dirname`-based path resolution. No copy mechanism needed.

3. **Expert-panel-review persona references**: The SKILL.md references persona files as "in the `personas/` directory alongside this skill." When embedding in a prompt, these relative references won't work. The skill loader should inline persona content into the skill text, or include them as additional sections. **This must be handled by the loader.**

## Key Findings

1. **Injection point is clear**: Skills are markdown text that gets embedded into phase prompts. The orchestrator already controls what CLIs know via prompts. This is a natural extension.

2. **Phase prompts are the right target**: System prompt is shared across all phases. Phase prompts are already phase-specific and follow a consistent structure. Skills should be a new section in relevant phase prompts.

3. **No existing resource loading**: Despite `resources/README.md` claiming files are copied to `~/.engineer/`, no code does this. The precedent (how-we-work.md) was to embed content directly as string constants. For skills, reading from disk at runtime is more maintainable than copying content into string constants.

4. **Persona inlining is required**: The expert-panel-review skill references persona files relatively. The skill loader must resolve and inline these references so the embedded prompt is self-contained.

5. **No existing prompt tests**: No test files exist for any prompt builder. New tests should follow the existing vitest patterns (co-located `.test.ts`, describe/it blocks, vi.fn() mocking).

6. **Phase-to-skill mapping**:
   - `commit` skill → `execution`, `self_review` (refinement step), `integration`
   - `expert-panel-review` skill → `self_review` (review sub-phases)

7. **Token impact is manageable**: ~2000-5000 extra tokens per relevant phase. With phase-level injection, non-relevant phases pay nothing.

8. **No adapter or plugin changes needed**: Skills are just text in the prompt. The adapter contract (`InferenceRequest.prompt` / `system_prompt`) passes strings unchanged. Plugin Blindness is fully preserved.
