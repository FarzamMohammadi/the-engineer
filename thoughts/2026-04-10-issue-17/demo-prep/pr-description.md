# PR Description: Cross-CLI Portable Skills System

## Title
Decouple skills from CLI-specific locations with prompt-injected skill system

## Body

Closes #17

## Summary

Skills previously lived in `.claude/skills/` — a Claude Code-specific directory. This tied skills to one CLI tool and violated the Agent-Agnostic Protocol. This PR introduces a CLI-agnostic skill system where the orchestrator loads skill content from `resources/skills/` and embeds it as text into phase prompts. Any CLI that receives the prompt gets the skills — no CLI-specific registration, directories, or format translation needed.

- New skill loader module (`src/core/orchestrator/prompts/skills.ts`) reads skill markdown from `resources/skills/`, inlines persona files, and builds formatted prompt sections
- Phase prompt builders (`execution.ts`, `review.ts`, `integration.ts`) inject relevant skills per phase
- Skills are mapped to RRPIR phases: `commit` for execution/self_review/integration, `expert-panel-review` for self_review only
- 17 new tests across 4 test files covering skill loading, persona inlining, phase mapping, error handling, and prompt integration

## What changed

### New files
- **`src/core/orchestrator/prompts/skills.ts`** — Skill loader and phase mapper. Exports `buildSkillsSection(phase)` which returns formatted skill content for a given RRPIR phase, or `null` if no skills apply. Resolves `resources/skills/` from repo root via `import.meta.url`, handles missing files gracefully (warns, never crashes).
- **`src/core/orchestrator/prompts/skills.test.ts`** — 9 tests for skill loading, persona inlining, phase mapping, error handling.
- **`src/core/orchestrator/prompts/execution.test.ts`** — 2 tests verifying correct skill presence/absence in execution prompts.
- **`src/core/orchestrator/prompts/review.test.ts`** — 4 tests for both review sub-phase and refinement prompts.
- **`src/core/orchestrator/prompts/integration.test.ts`** — 2 tests for integration prompt skill injection.

### Modified files
- **`src/core/orchestrator/prompts/execution.ts`** — Calls `buildSkillsSection("execution")` and appends commit skill to prompt.
- **`src/core/orchestrator/prompts/review.ts`** — Calls `buildSkillsSection("self_review")` in both `buildReviewSubPhasePrompt()` and `buildRefinementPrompt()`, adding commit + expert-panel-review skills.
- **`src/core/orchestrator/prompts/integration.ts`** — Calls `buildSkillsSection("integration")` and appends commit skill.
- **`src/core/orchestrator/prompts/index.ts`** — Re-exports `buildSkillsSection` from the barrel.
- **`resources/README.md`** — Updated to accurately describe skill loading mechanism. Removed stale claim about copying to `~/.engineer/`.

## Technical approach

**Phase prompts, not system prompt.** Skills are phase-specific, so injecting them into the system prompt would bloat phases that don't need them. Phase prompts are already phase-aware — skills are a natural fit.

**Inline embedding, not file references.** Skill content is read from disk and embedded as text in the prompt. The CLI never needs to resolve file paths, making this work from any worktree with any CLI tool.

**Repo-root resolution via `import.meta.url`.** The `findRepoRoot()` helper walks up from the module's location looking for `package.json`, working correctly from both `src/` (dev via tsx) and `dist/` (built output).

**Graceful degradation.** Missing skill files produce a console warning and empty string — the pipeline continues without the skill. Individual persona file failures skip only that persona, not all of them (bug caught and fixed during review).

## Key decisions

1. **Read from `resources/skills/` in the repo** rather than copying to `~/.engineer/`. No copy mechanism existed, and building one would add unnecessary complexity. Path resolution from the source module handles dev and built scenarios.

2. **Explicit phase-to-skill mapping** over auto-discovery. Adding a skill requires updating `SkillName` type and `SKILL_PHASE_MAP` — intentional, since each mapping is a deliberate decision. At 2 skills, auto-discovery would add complexity without value.

3. **No changes to `.claude/skills/`**. The 4 out-of-scope skills there are owner dev tools. The 2 in-scope skills (`commit`, `expert-panel-review`) now work via prompt injection regardless of `.claude/skills/` presence.

## How to test

1. **Run the full test suite:**
   ```bash
   pnpm test
   ```
   All 2492+ tests should pass, including 17 new skill-related tests.

2. **Run typecheck and lint:**
   ```bash
   pnpm run typecheck && pnpm run lint
   ```
   Zero new errors or warnings.

3. **Verify skill injection manually** — inspect the new test files to see assertions that skill content (e.g., "Grouping Priority" from commit skill, persona names from expert-panel-review) appears in the correct phase prompts and is absent from others.

4. **Verify build works:**
   ```bash
   pnpm run build && pnpm test
   ```
   Skills should load correctly from both dev mode and built output.

## Breaking changes

None. This is additive — skills are injected into existing prompts without changing their structure. No API changes, no configuration changes, no migration needed.

## Acceptance criteria checklist

- [x] Skills are accessible from any CLI running in any worktree (embedded as prompt text)
- [x] Both starting skills included and functional (commit + expert-panel-review with personas)
- [x] No CLI-specific registration (no `.claude/commands/`, no Codex equivalent)
- [x] No `.gitignore` entries needed (skills live in tracked `resources/skills/`)
- [x] System prompt communicates skill availability to the CLI (via phase prompts)
- [x] Existing tests pass, new behavior has tests (17 new tests, 2492+ total passing)
