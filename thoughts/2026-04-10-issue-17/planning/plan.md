# Plan: Cross-CLI Portable Skills System

## Approach

Inject skill content into phase prompts so any CLI tool receives skills as embedded text — no CLI-specific registration, no file paths the CLI needs to resolve. The skill loader reads markdown files from `resources/skills/` at runtime (using `import.meta.url`-based path resolution), and phase prompt builders include relevant skill content as a new section.

**Key design decisions:**

1. **Phase prompts, not system prompt.** Skills are phase-specific (`commit` for execution/self_review/integration, `expert-panel-review` for self_review only). Injecting into the system prompt would bloat every phase with irrelevant content. Phase prompts are already phase-aware — skills are a natural addition.

2. **Read from `resources/skills/` in the repo.** No copy-to-`~/.engineer/` mechanism exists, and building one is unnecessary complexity. The repo's `resources/` directory is available at runtime via path resolution from the source module. The built output mirrors the source structure.

3. **Inline persona files into skill content.** The expert-panel-review SKILL.md references `personas/*.md` relatively. The skill loader resolves and appends persona content so the embedded prompt is fully self-contained.

4. **Skills as a new module `src/core/orchestrator/prompts/skills.ts`.** Follows the existing pattern: a module in `prompts/` with types + public API + internal helpers. Exports a function that returns skill content for a given phase.

## Phases

### Phase 1: Skill Loader Module

Create `src/core/orchestrator/prompts/skills.ts` — the core of the feature.

- [x] Create `src/core/orchestrator/prompts/skills.ts` with:
  - A `SkillName` type: `"commit" | "expert-panel-review"`
  - A `SKILL_PHASE_MAP` constant: `Record<Phase, SkillName[]>` mapping phases to their relevant skills:
    - `execution` → `["commit"]`
    - `self_review` → `["commit", "expert-panel-review"]`
    - `integration` → `["commit"]`
    - All other phases → `[]` (empty array)
  - A `loadSkillContent(skillName: SkillName): string` function that:
    - Resolves the skill directory path relative to the module using `import.meta.url` → `fileURLToPath` → navigate up to repo root → `resources/skills/{skillName}/`
    - Reads `SKILL.md` from that directory
    - If the skill directory contains a `personas/` subdirectory, reads all `.md` files in it and appends them as labeled sections (e.g., `\n\n## Persona: Technical Architect\n\n{content}`)
    - Returns the combined content as a string
    - On file read error: logs a warning and returns empty string (don't crash the pipeline over a missing skill file)
  - A `buildSkillsSection(phase: Phase): string | null` public function that:
    - Looks up `SKILL_PHASE_MAP[phase]`
    - If empty, returns `null`
    - For each skill in the list, calls `loadSkillContent()` and wraps each in a delimited block: `### Skill: {name}\n\n{content}`
    - Returns the full section wrapped with `section("Skills", combinedContent)` using the existing `section()` helper from `format.ts`
- [x] Export `buildSkillsSection` from `src/core/orchestrator/prompts/index.ts` barrel file

**Path resolution detail:** Use `import.meta.url` → `fileURLToPath(import.meta.url)` → `path.resolve(dirname, '../../../../resources/skills/')`. This resolves correctly from both `src/` (dev via tsx) and `dist/` (built). Verify the path resolves correctly in the build output — the `resources/` directory must be accessible from the built module. If the build doesn't copy `resources/`, a copy step in the build script is needed (check `tsconfig.json` and `package.json` build config).

**Verify:** Unit tests pass (Phase 3). Run `pnpm run typecheck` to confirm no type errors.

### Phase 2: Inject Skills into Phase Prompts

Modify the three phase prompt builders that need skills: `execution.ts`, `review.ts`, and `integration.ts`.

- [x] Modify `src/core/orchestrator/prompts/execution.ts`:
  - Import `buildSkillsSection` from `./skills.js`
  - In `buildExecutionPrompt()`, after building the task context (section 5), call `buildSkillsSection(Phases.execution)` and append the result to `parts` if non-null
  - Import `Phases` from the schemas module

- [x] Modify `src/core/orchestrator/prompts/review.ts`:
  - Import `buildSkillsSection` from `./skills.js`
  - In `buildReviewSubPhasePrompt()`, after section 5, call `buildSkillsSection(Phases.self_review)` and append if non-null. This gives review sub-phases access to the expert-panel-review skill.
  - In `buildRefinementPrompt()`, after section 5, call `buildSkillsSection(Phases.self_review)` and append if non-null. The refinement step can use commit skill for fixing and committing.

- [x] Modify `src/core/orchestrator/prompts/integration.ts`:
  - Import `buildSkillsSection` from `./skills.js`
  - In `buildIntegrationPrompt()`, after section 5, call `buildSkillsSection(Phases.integration)` and append if non-null

**Note:** `phase-handlers.ts` does NOT change. Skills are injected by the prompt builders themselves, not by the handlers. This keeps the change contained within the prompts module.

**Verify:** `pnpm run typecheck` passes. Manually inspect prompt output (via a test) to confirm skills appear in the right phases and not in others.

### Phase 3: Tests

Create `src/core/orchestrator/prompts/skills.test.ts` and add skill-related assertions to prompt builder tests.

- [x] Create `src/core/orchestrator/prompts/skills.test.ts` with:
  - `describe("SKILL_PHASE_MAP")`:
    - `it("should map commit skill to execution, self_review, and integration phases")`
    - `it("should map expert-panel-review skill to self_review phase only")`
    - `it("should have no skills for requirements_gathering, research, planning, demo_prep")`
  - `describe("loadSkillContent")`:
    - `it("should load commit skill content")` — verify returns non-empty string containing key phrases from SKILL.md (e.g., "Grouping Priority", "HEREDOC")
    - `it("should load expert-panel-review skill with inlined personas")` — verify returns content from SKILL.md AND all three persona files (check for "Technical Architect", "Critical Reviewer", "Pragmatic Senior Engineer")
    - `it("should return empty string for non-existent skill")` — pass a bad skill name, verify empty string returned without throwing
  - `describe("buildSkillsSection")`:
    - `it("should return section with commit skill for execution phase")` — verify contains "## Skills" and commit content
    - `it("should return section with both skills for self_review phase")` — verify contains both commit and expert-panel-review content
    - `it("should return null for phases with no skills")` — verify returns null for `requirements_gathering`
    - `it("should include persona content in expert-panel-review skill")` — verify persona names appear in the section

- [x] Create `src/core/orchestrator/prompts/execution.test.ts` with:
  - `it("should include skills section in execution prompt")` — call `buildExecutionPrompt()` with minimal context, verify output contains commit skill content (e.g., "Grouping Priority")
  - `it("should not include expert-panel-review skill in execution prompt")` — verify "Expert Panel Review" does NOT appear

- [x] Add review prompt test assertions in `src/core/orchestrator/prompts/review.test.ts`:
  - `it("should include skills section in review sub-phase prompt")` — call `buildReviewSubPhasePrompt()`, verify output contains expert-panel-review content
  - `it("should include skills section in refinement prompt")` — call `buildRefinementPrompt()`, verify output contains commit skill content

- [x] Add integration prompt test in `src/core/orchestrator/prompts/integration.test.ts`:
  - `it("should include skills section in integration prompt")` — call `buildIntegrationPrompt()`, verify output contains commit skill content
  - `it("should not include expert-panel-review skill in integration prompt")` — verify "Expert Panel Review" does NOT appear

**Verify:** `pnpm test -- src/core/orchestrator/prompts/` passes. All assertions verify real behavior (skill content appears where expected, absent where not).

### Phase 4: Build & Resource Accessibility

Ensure `resources/skills/` is accessible from the built output.

- [x] Check `tsconfig.json` — TypeScript doesn't copy non-TS files. Verify if the build process copies `resources/` to `dist/` or if the path resolution needs to go up to the repo root (not `dist/`).
- [x] If resources are NOT in `dist/`: Adjust path resolution in `skills.ts` to resolve to the repo root `resources/` directory rather than relative to `dist/`. The path `import.meta.url` → up to repo root → `resources/skills/` works from both `src/` and `dist/` as long as the traversal goes far enough.
- [x] If a build copy step is needed: Add a `cp -r resources dist/resources` step to the build script in `package.json`. Only do this if path resolution to repo root is not viable.
- [x] Run `pnpm run build && pnpm test` to verify everything works end-to-end.

**Verify:** `pnpm run build` succeeds. `pnpm test` passes. Skills load correctly from both dev mode (`tsx`) and built output.

### Phase 5: Cleanup & Documentation

- [x] Update `resources/README.md` to document that skills in `resources/skills/` are loaded by the orchestrator's prompt system and injected into phase prompts. Remove or correct the claim about "copied to `~/.engineer/` at startup" if it's inaccurate for skills.
- [x] Verify `.claude/skills/commit/` and `.claude/skills/expert-panel-review/` still exist (leave them — they're out of scope, and other `.claude/skills/` are owner dev tools). The two in-scope skills now work via prompt injection regardless of whether `.claude/skills/` exists.
- [x] Run full verification: `pnpm run typecheck && pnpm run lint && pnpm test`

**Verify:** All checks pass. `resources/README.md` accurately describes the skill loading mechanism.

## Risks & Mitigations

- **Risk:** `resources/` directory not accessible from built `dist/` output at runtime. → **Mitigation:** Phase 4 explicitly addresses this. Path resolution from `import.meta.url` can traverse up to repo root. Fallback: add a copy step to the build script.

- **Risk:** Skill file read failures crash the pipeline. → **Mitigation:** `loadSkillContent()` catches errors and returns empty string with a warning log. Pipeline continues without the skill.

- **Risk:** Token bloat from embedding full skill + persona content (~5000 tokens). → **Mitigation:** Skills only injected in relevant phases (3 of 7). Non-relevant phases pay zero cost. The token impact is acceptable for the value delivered.

- **Risk:** Expert-panel-review persona file references break when embedded. → **Mitigation:** The loader inlines persona content directly, eliminating relative path references. The embedded text is self-contained.

## Pre-mortem

1. **Path resolution breaks in production but works in dev.** `import.meta.url` resolves differently when running from `src/` via `tsx` vs from `dist/` after build. The traversal depth to reach `resources/` differs. **Mitigation:** Calculate path based on known repo structure markers (e.g., check for `package.json` at each level) or use a fixed traversal that works from both locations. Test explicitly in Phase 4 by running tests against the built output.

2. **Skill content silently empty, pipeline runs without skills.** If `loadSkillContent` returns empty string due to path errors, no one notices — the phase just runs without skills. **Mitigation:** Log a warning when a mapped skill fails to load. In tests, assert that skill content is non-empty for known skills. Consider throwing during test runs but warning in production (use `NODE_ENV` or similar).

3. **Future skill additions require code changes in multiple files.** Adding a new skill requires: (a) adding files to `resources/skills/`, (b) updating `SkillName` type, (c) updating `SKILL_PHASE_MAP`. This is 3 places. **Mitigation:** This is acceptable for now — skills are added rarely, and the mapping is intentional (each skill-to-phase relationship is a deliberate decision). A discovery-based system would add complexity without proportional value at 2 skills.

## Test Strategy

- **Unit tests for skill loader** (`skills.test.ts`): Verify file reading, persona inlining, phase mapping, error handling.
- **Prompt integration tests** (`execution.test.ts`, `review.test.ts`, `integration.test.ts`): Verify skill content appears in prompt output for correct phases and is absent for incorrect phases.
- **No mocking of file system** for skill loader tests — read the actual `resources/skills/` files. This tests the real path resolution and file content, which is the most likely failure point.
- **Edge cases:** Missing skill files, empty skill directories, phases with no skills mapped.
- **Existing tests:** Run `pnpm test` to confirm no regressions. No existing prompt tests exist, so no existing tests should break.

## Success Criteria

- [x] `buildSkillsSection(Phases.execution)` returns content containing commit skill text
- [x] `buildSkillsSection(Phases.self_review)` returns content containing both commit and expert-panel-review skill text (with inlined personas)
- [x] `buildSkillsSection(Phases.integration)` returns content containing commit skill text
- [x] `buildSkillsSection(Phases.requirements_gathering)` returns `null`
- [x] `buildExecutionPrompt()` output contains commit skill content
- [x] `buildReviewSubPhasePrompt()` output contains expert-panel-review skill content
- [x] `buildIntegrationPrompt()` output contains commit skill content
- [x] No CLI-specific registration — skills are plain text in prompts
- [x] Skills work from worktrees — content is embedded, not file paths
- [x] `pnpm run typecheck` passes with zero errors
- [x] `pnpm run lint` passes with zero warnings
- [x] `pnpm test` passes — all existing + new tests
- [x] `resources/README.md` accurately documents skill loading
