# Plan: Fix CI Failures for PR #13

## Background
**Original task completed:** Update seed-example config claude code model to opus ✅
- Successfully implemented in PR #13
- Configuration change verified and tested 
- PR approved and ready for merge

**Current task:** Fix CI failures preventing PR #13 merge

## Approach
Fix TypeScript compilation errors in test configurations to enable merge of PR #13. The original seed-example config change (updating claude model to opus) was successfully implemented and is ready for merge once CI passes. The failures are caused by recent schema evolution that exposed missing properties in test objects.

## Phases

### Phase 1: Fix LLM Test Configuration
- [x] Edit `src/adapters/llm.test.ts` line 73-77
- [x] Add missing `trace_output_path: null` property to `testRequest` object
- **Verify:** ✅ TypeScript compilation passes for the test request object

### Phase 2: Fix Doctor Test Configuration  
- [x] Edit `src/cli/commands/doctor.test.ts` line 562
- [x] Add missing properties to `makeSafeBundle()` function's merge configuration:
  - [x] `enable_comment_approval: false`
  - [x] `exclude_thoughts_on_merge: false`
- **Verify:** ✅ TypeScript compilation passes for all `makeSafeBundle()` usages (lines 200, 209, 216, 224, 232, 239, 248, 256)

### Phase 3: Validate CI Fix
- [x] Run `pnpm lint` locally to verify TypeScript compilation passes
- [x] Push changes to the existing branch to trigger CI
- **Verify:** ✅ CI pipeline passes completely, enabling merge of PR #13

## Risks & Mitigations
- **Risk:** Changes might break existing test behavior → **Mitigation:** Using schema-defined defaults (both properties default to `false`, trace_output_path defaults to `null`) ensures no behavioral changes
- **Risk:** Missing other schema mismatches → **Mitigation:** Running full lint command locally before push catches any remaining issues
- **Risk:** Breaking production code → **Mitigation:** These are test-only changes with no production impact

## Test Strategy
- Run `pnpm lint` locally to verify TypeScript compilation
- Existing tests continue to pass with no behavioral changes (using schema defaults)
- No new tests needed - this aligns existing tests with current schema definitions

## Success Criteria
- [x] TypeScript compilation passes locally (`pnpm lint` succeeds)
- [x] CI pipeline passes for PR #13
- [x] PR #13 becomes mergeable, allowing the opus model configuration to deploy
- [x] No existing test behaviors change (using schema defaults maintains current behavior)

## Original Task Completion (Reference)
✅ **Phase 1:** Update Seed Configuration
- [x] Updated `seed-example/plugins/claude-code-llm.yaml` line 3
- [x] Changed from: `model: claude-sonnet-4-20250514`
- [x] Changed to: `model: claude-opus-4-20250514`

✅ **Phase 2:** Validation  
- [x] Verified no other seed-example files reference the old model
- [x] Confirmed file structure and syntax remain valid YAML
- [x] Tested that `scripts/reset.sh` successfully uses updated seed configuration