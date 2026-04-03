# Plan: Update seed-example config claude code model to opus

## Approach
This is a single-line configuration change to update the Claude model from Sonnet to Opus in the seed-example configuration. The change only affects fresh engineer setups when using `scripts/reset.sh` without the `--persist-data` flag, which calls `engineer start --seed ./seed-example/` to seed the initial configuration.

The existing codebase already has the correct pattern established (`claude-opus-4-20250514`) in test files, so we'll follow that convention rather than attempting to infer new model version dates.

## Phases

### Phase 1: Update Seed Configuration
- [x] Update `seed-example/plugins/claude-code-llm.yaml` line 3
- [x] Change from: `model: claude-sonnet-4-20250514`
- [x] Change to: `model: claude-opus-4-20250514`
- **Verify:** File contains the updated model name on line 3 ✓

### Phase 2: Validation
- [x] Verify no other seed-example files reference the old model
- [x] Confirm the file structure and syntax remain valid YAML
- [x] Test that `scripts/reset.sh` can successfully use the updated seed configuration
- **Verify:** Reset script completes without errors and engineer starts successfully ✓

## Risks & Mitigations
- **Risk:** Invalid YAML syntax breaks seed configuration → **Mitigation:** Preserve exact formatting, only change the model name
- **Risk:** Typo in model name prevents startup → **Mitigation:** Use exact string from existing test file (`claude-opus-4-20250514`)
- **Risk:** Breaking other dependencies on the seed config → **Mitigation:** Verified only one file in seed-example references this model

## Test Strategy
- Functional test: Run `scripts/reset.sh` (without `--persist-data`) to verify seeding works
- Syntax validation: Ensure YAML remains parseable
- Integration verification: Check that engineer starts successfully with the new configuration

## Success Criteria
- [x] `seed-example/plugins/claude-code-llm.yaml` contains `model: claude-opus-4-20250514`
- [x] File remains valid YAML with original formatting preserved
- [x] `scripts/reset.sh` successfully seeds configuration and starts engineer
- [x] No other files in the repository reference the old model name in seed contexts