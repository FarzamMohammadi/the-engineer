# Plan: Update seed-example config claude code model to opus

## Approach
Update the Claude Code LLM model from `claude-sonnet-4-20250514` to `claude-opus-4-6` across all configuration files and templates. This ensures that:
- New installations using `engineer start --seed ./seed-example/` get the latest model  
- Default fallback configurations use the updated model
- Template documentation reflects the current recommendation

## Phases

### Phase 1: Update Seed Configuration
- [x] Update `seed-example/plugins/claude-code-llm.yaml` line 3: Change `model: claude-sonnet-4-20250514` to `model: claude-opus-4-6`
- **Verify:** Content shows the new model identifier on line 3

### Phase 2: Update Source Code Defaults  
- [x] Update `src/plugins/llm/claude-code-llm/config.ts` line 4: Change `.default("claude-sonnet-4-20250514")` to `.default("claude-opus-4-6")`
- [x] Update `src/plugins/llm/claude-code-llm/claude-code-llm.ts` line 202: Change `?? "claude-sonnet-4-20250514"` to `?? "claude-opus-4-6"`  
- **Verify:** Both files reference the new model in default/fallback scenarios

### Phase 3: Update CLI Templates
- [x] Update `src/cli/templates.ts` line 289: Change `# model: claude-sonnet-4-20250514` to `# model: claude-opus-4-6`
- [x] Update `src/cli/templates.ts` line 662: Change `model: claude-sonnet-4-20250514` to `model: claude-opus-4-6` and update the comment
- **Verify:** Template examples and documentation reflect the new model

### Phase 4: Validation
- [x] Run `pnpm run typecheck` to ensure no TypeScript errors  
- [x] Run `pnpm run lint` to ensure code formatting consistency
- [x] Search for any remaining references to the old model to ensure complete update
- **Verify:** All checks pass, no remaining old model references

## Risks & Mitigations
- **Risk:** Model identifier format is incorrect → **Mitigation:** The requirements document confirmed `claude-opus-4-6` is the correct format based on API documentation
- **Risk:** Breaking existing configurations → **Mitigation:** This only affects new installations via seed; existing user configs remain unchanged  
- **Risk:** Missing references to old model → **Mitigation:** Comprehensive grep search identified all 4 locations that need updating

## Test Strategy  
- Verify TypeScript compilation succeeds (no type errors from model string changes)
- Verify linting passes (consistent formatting)
- Manual verification that `scripts/reset.sh` would use the new model for fresh installations
- No unit test changes needed - the model identifier is just a string value

## Success Criteria
- [x] All 4 identified files contain `claude-opus-4-6` instead of `claude-sonnet-4-20250514`
- [x] TypeScript compilation succeeds without errors
- [x] Linting passes without warnings  
- [x] No remaining references to the old model identifier in the codebase
- [x] Fresh installations via `engineer start --seed ./seed-example/` will use Claude Opus 4.6