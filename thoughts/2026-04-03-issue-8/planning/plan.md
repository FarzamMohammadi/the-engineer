# Plan: Update seed-example config claude code model to opus

## Approach

Update the default Claude model in the seed configuration from Sonnet to Opus. This involves a single configuration file change that will affect the default LLM model for new Engineer installations when using the reset script.

The seed configuration is used by `scripts/reset.sh` when setting up fresh Engineer installations via `engineer start --seed ./seed-example/`. By updating the model in the seed config, all new setups will default to using Claude Opus instead of Claude Sonnet.

## Phases

### Phase 1: Update Model Configuration
- [x] Edit `/seed-example/plugins/claude-code-llm.yaml`
- [x] Change `model: claude-sonnet-4-20250514` to `model: claude-opus-4-20250514`
- [x] Preserve all other configuration values (max_tokens, cli_path)
- **Verify:** Confirm file contains the updated model name and no syntax errors ✅

### Phase 2: Validation
- [x] Check that the file is valid YAML syntax
- [x] Confirm no other files reference the old model name in seed-example/
- [x] Verify the target model name matches the pattern used in tests (`claude-opus-4-20250514`)
- **Verify:** Reset script can successfully use the updated seed configuration ✅

## Risks & Mitigations

- **Risk:** YAML syntax error breaks seed configuration → **Mitigation:** Validate YAML syntax after edit
- **Risk:** Incorrect model name causes runtime failure → **Mitigation:** Use exact model name from existing test files (`claude-opus-4-20250514`)
- **Risk:** Cost implications for users (Opus is more expensive than Sonnet) → **Mitigation:** This is intentional per task requirements; users get the most capable model by default

## Test Strategy

- Verify YAML file is syntactically correct after edit
- Confirm the change affects only the intended configuration
- Test that reset script can start with the updated seed (if possible)
- No unit tests needed - this is a configuration-only change

## Success Criteria

- [x] `/seed-example/plugins/claude-code-llm.yaml` contains `model: claude-opus-4-20250514`
- [x] File remains valid YAML with all other settings preserved
- [x] No other references to the old model name exist in seed-example/
- [x] Reset script continues to work with updated seed configuration

## Implementation Complete ✅

Successfully updated the seed configuration to use Claude Opus (`claude-opus-4-20250514`) instead of Claude Sonnet. All validation passed:

- YAML syntax is valid
- No other references to old model name found
- All Claude LLM plugin tests pass (37/37)
- Configuration change committed (commit: 8be764e)

The seed configuration will now default new Engineer installations to use Claude Opus when using `engineer start --seed ./seed-example/`.