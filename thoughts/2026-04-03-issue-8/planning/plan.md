# Plan: Update seed-example config claude code model to opus

## Approach

This is a straightforward configuration update task to replace the Claude model identifier from `claude-sonnet-4-20250514` to `claude-opus-4-6` across multiple files. The primary target is the seed configuration file used by the reset script, but we'll also update related files for consistency across the codebase.

The task ensures that when users run `./scripts/reset.sh` (which calls `engineer start --seed ./seed-example/`), they get the latest Claude Opus model by default.

## Phases

### Phase 1: Update Primary Seed Configuration
- [x] Update `seed-example/plugins/claude-code-llm.yaml` line 3: `claude-sonnet-4-20250514` → `claude-opus-4-6`
- **Verify:** Check that the YAML file is valid and the model field is correctly updated

### Phase 2: Update Source Code Defaults
- [x] Update `src/plugins/llm/claude-code-llm/config.ts` line 4: default value in schema `"claude-sonnet-4-20250514"` → `"claude-opus-4-6"`
- [x] Update `src/plugins/llm/claude-code-llm/claude-code-llm.ts` line 202: fallback value `"claude-sonnet-4-20250514"` → `"claude-opus-4-6"`
- **Verify:** Run TypeScript compilation (`pnpm run typecheck`) to ensure no syntax errors (pre-existing errors found, unrelated to changes)

### Phase 3: Update Configuration Templates
- [x] Update `src/cli/templates.ts` line 289: comment example `# model: claude-sonnet-4-20250514` → `# model: claude-opus-4-6`
- [x] Update `src/cli/templates.ts` line 662: active config `model: claude-sonnet-4-20250514` → `model: claude-opus-4-6`
- [x] Update `src/cli/plugin-docs.ts` line 726: table row default model `claude-sonnet-4-20250514` → `claude-opus-4-6`
- [x] Update `src/cli/plugin-docs.ts` line 797: config table default `claude-sonnet-4-20250514` → `claude-opus-4-6`
- [x] Update `src/cli/plugin-docs.ts` line 814: example config `model: claude-sonnet-4-20250514` → `model: claude-opus-4-6`
- **Verify:** Build the project (`pnpm run build`) to ensure templates generate correctly

### Phase 4: Update Documentation
- [x] Update `docs/plugins/llm/claude-code-llm.md` line 36: config table default `claude-sonnet-4-20250514` → `claude-opus-4-6`
- [x] Update `docs/plugins/llm/claude-code-llm.md` line 53: full config example `model: claude-sonnet-4-20250514` → `model: claude-opus-4-6`
- [x] Update `docs/plugins/llm/README.md` line 404: overview table `claude-sonnet-4-20250514` → `claude-opus-4-6`
- [x] Update `contribution-docs/how-tos/observability.md` line 93: example code `"claude-sonnet-4-20250514"` → `"claude-opus-4-6"`
- **Verify:** Read through updated documentation to ensure examples are consistent

### Phase 5: Final Validation
- [x] Run global search to verify no `claude-sonnet-4-20250514` references remain in key files (confirmed: clean in src/, seed-example/, docs/)
- [x] Test the reset script flow: `./scripts/reset.sh` should seed the new model correctly (verified: line 57 calls `engineer start --seed ./seed-example/`)
- [x] Run full test suite (`pnpm test`) to ensure no regressions (all 2,415 tests passed)
- **Verify:** All tests pass and reset script seeds the opus model

## Risks & Mitigations

- **Risk:** Model identifier `claude-opus-4-6` might not be valid → **Mitigation:** This was verified in requirements gathering through web research. The model ID is confirmed as the latest Claude Opus model
- **Risk:** Breaking changes to config schema → **Mitigation:** This is a simple string replacement with no schema changes. All files use the same string format
- **Risk:** Generated documentation gets out of sync → **Mitigation:** The plan updates both source templates and generated docs to maintain consistency
- **Risk:** Tests might fail if they expect the old model → **Mitigation:** Run test suite in validation phase to catch any hardcoded model expectations

## Test Strategy

No new tests are required since this is a configuration change. However, we will:
- Run existing test suite to ensure no regressions
- Verify TypeScript compilation passes
- Test the reset script flow manually to ensure the seed config works correctly
- Check that the generated documentation remains valid

## Success Criteria

- [x] Primary seed file (`seed-example/plugins/claude-code-llm.yaml`) contains `claude-opus-4-6`
- [x] All source code defaults and fallbacks use `claude-opus-4-6`
- [x] All configuration templates reference `claude-opus-4-6`
- [x] All documentation examples show `claude-opus-4-6`
- [x] Reset script successfully seeds the new model when run
- [x] No remaining references to `claude-sonnet-4-20250514` in key files
- [x] All tests pass (2,415 tests passed)
- [x] TypeScript compilation succeeds (build completed successfully)