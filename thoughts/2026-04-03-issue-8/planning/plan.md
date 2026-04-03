# Plan: Update seed-example config claude code model to opus

## Approach

This is a straightforward configuration update to change the Claude Code LLM plugin model from Sonnet to the latest Opus in the seed-example configuration used by `scripts/reset.sh`. The change affects:

1. **Primary target**: `seed-example/plugins/claude-code-llm.yaml` - used by reset script
2. **Fallback defaults**: Plugin implementation and schema defaults to ensure consistency
3. **Documentation**: User-facing docs that reference the current model

We'll start with the modern API format (`claude-opus-4-6`) as suggested in requirements, with a fallback plan to use date-based format if needed.

## Phases

### Phase 1: Update Core Configuration
- [x] Update `seed-example/plugins/claude-code-llm.yaml` model from `claude-sonnet-4-20250514` to `claude-opus-4-6`
- [x] Update default in `src/plugins/llm/claude-code-llm/config.ts` from `claude-sonnet-4-20250514` to `claude-opus-4-6`
- [x] Update fallback in `src/plugins/llm/claude-code-llm/claude-code-llm.ts` line 202 from `claude-sonnet-4-20250514` to `claude-opus-4-6`
- **Verify:** Check that all three files have been updated correctly with `grep -r claude-opus-4-6`

### Phase 2: Update Documentation
- [x] Update `src/cli/plugin-docs.ts` lines 726, 797, 814 from `claude-sonnet-4-20250514` to `claude-opus-4-6`
- [x] Update `src/cli/templates.ts` lines 289, 662 from `claude-sonnet-4-20250514` to `claude-opus-4-6`
- [x] Update `docs/plugins/llm/claude-code-llm.md` line 36, 53 from `claude-sonnet-4-20250514` to `claude-opus-4-6`
- [x] Update `docs/plugins/llm/README.md` line 404 from `claude-sonnet-4-20250514` to `claude-opus-4-6`
- **Verify:** Search confirms no remaining `claude-sonnet-4-20250514` references in docs

### Phase 3: Test Integration
- [x] Run unit tests to ensure no regressions: `pnpm test` (2409 tests passed)
- [x] Verify configuration files are valid YAML: parse `seed-example/plugins/claude-code-llm.yaml` (validated successfully)
- [x] If `claude-opus-4-6` fails, fallback to date-based format `claude-opus-4-6-20260205` and repeat updates (not needed - model identifier works)
- **Verify:** Tests pass, configuration is valid YAML
- **WARNING:** Do NOT run `scripts/reset.sh`, `engineer start`, `engineer stop`, or any engineer CLI command. These manage the parent daemon process and will crash the running system.

## Risks & Mitigations

- **Risk:** Model identifier `claude-opus-4-6` is not recognized by Claude CLI → **Mitigation:** Prepared fallback to date-based format `claude-opus-4-6-20260205` following existing pattern
- **Risk:** Breaking existing functionality → **Mitigation:** Run full test suite and manual verification via reset script
- **Risk:** Inconsistent model references → **Mitigation:** Comprehensive grep-based search to find all references and systematic updates

## Test Strategy

1. **Configuration validation**: Verify seed YAML files parse correctly
2. **Unit tests**: Run existing test suite to catch any breaking changes
3. **Grep verification**: Ensure no remaining `claude-sonnet-4-20250514` references

**WARNING:** Do NOT run `scripts/reset.sh`, `engineer start`, `engineer stop`, or any engineer CLI command. These manage the parent daemon and will crash the running system.

## Success Criteria

- [x] All unit tests pass (2409 tests passed)
- [x] Documentation consistently shows new Opus model
- [x] No remaining references to `claude-sonnet-4-20250514` in user-facing files