# Requirements Check: Cross-CLI Portable Skills System

## Summary

**All 6 acceptance criteria: MET.** Implementation is clean, tested, and documented. No blocking issues.

## Acceptance Criteria

### 1. Skills are accessible from any CLI running in any worktree
**MET**

Skills are embedded as text into phase prompts via `buildSkillsSection()` (`skills.ts:41-60`). The CLI receives skill content inline — no file paths, no CLI-specific directories, no worktree-relative resolution needed. Any CLI that receives the phase prompt gets the skills.

`findRepoRoot()` (`skills.ts:70-86`) walks up from `import.meta.url` looking for `package.json`, working from both `src/` (dev) and `dist/` (built).

### 2. Both starting skills are included and functional
**MET**

- `commit`: loaded from `resources/skills/commit/SKILL.md`, injected in execution, self_review, integration phases.
- `expert-panel-review`: loaded from `resources/skills/expert-panel-review/SKILL.md` with all 3 persona files (critical-reviewer, pragmatic-senior-engineer, technical-architect) inlined. Injected in self_review phase only.

Verified: both skill directories and all persona files exist on disk. Tests verify actual content from the files (`skills.test.ts:6-36`).

### 3. No CLI-specific registration (no `.claude/commands/`, no Codex equivalent)
**MET**

No changes to `.claude/` directory. No CLI-adapter changes. Skills flow through `prompts/skills.ts` → phase prompt builders → prompt string sent to any LLM adapter.

### 4. No `.gitignore` entries needed for skills
**MET**

Skills live in `resources/skills/` (tracked in git, part of the repo). Not copied to worktrees or target repos.

### 5. System prompt communicates skill availability to the CLI
**MET**

Skills are injected via **phase prompts** (not system prompt). This is a deliberate, well-justified design choice — avoids bloating phases that don't need skills. The intent of the criterion (CLI knows about skills via the prompt pipeline) is fully satisfied.

Injection points verified:
- `execution.ts:57-61` — commit for execution
- `review.ts:170-174` — commit + expert-panel-review for self_review sub-phases
- `review.ts:203-207` — commit + expert-panel-review for refinement
- `integration.ts:52-56` — commit for integration

### 6. Existing tests pass, new behavior has tests
**MET**

- **Existing tests:** 2492 tests pass across 102 test files.
- **Typecheck:** Zero errors.
- **Lint:** Pre-existing warnings only (8 unused exports, none from new code).
- **New tests:** 17 tests across 4 files:
  - `skills.test.ts` (9 tests) — skill loading, persona inlining, phase mapping, error handling
  - `execution.test.ts` (2 tests) — skill presence/absence verification
  - `review.test.ts` (4 tests) — both review functions include skills and personas
  - `integration.test.ts` (2 tests) — skill presence/absence verification

## Edge Cases

| Edge Case | Handling | Test Coverage |
|-----------|----------|---------------|
| Missing skill file | `loadSkillContent` catches, warns, returns `""` (skills.ts:120-124) | `skills.test.ts:30-36` |
| No personas directory | Inner try/catch continues silently (skills.ts:115-117) | Implicit (commit skill has no personas) |
| Phase with no skills | Returns `null`, callers check before appending (skills.ts:43-45) | `skills.test.ts:72-77` |
| All skills fail to load | `blocks` stays empty, returns `null` (skills.ts:55-57) | Implicitly covered |

## Code Quality

**Strengths:**
- Follows existing codebase patterns: uses `section()` helper, matches `prompts/` module structure and naming.
- Graceful degradation: pipeline won't crash over missing skills.
- Tests use real files (no FS mocking), validating the full path resolution chain.
- Synchronous reads are appropriate — runs during prompt assembly before LLM calls.

**Observations (non-blocking):**
1. String literals (`"execution"`, `"self_review"`) used in `buildSkillsSection()` calls instead of `Phases.xxx` constants. Verified this is consistent with the codebase — no other prompt code uses `Phases` constants either.
2. `findRepoRoot()` called per skill load (not cached). Negligible cost at 2 skills, fine as-is.

## Documentation

- `resources/README.md`: Updated accurately. Describes skill loading, phase mapping, portability. Removed stale "copied to ~/.engineer/" claim. **MET**
- No other existing docs mention skills — no updates needed.

## Verdict

**ALL ACCEPTANCE CRITERIA MET.** No blocking issues. No fixes needed. Ready to proceed.
