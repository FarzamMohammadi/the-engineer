# Requirements: Update seed-example config claude code model to opus

## Task Description
Update seed-example config claude code model to opus

**Additional context:** We have some seed-files in `/seed-examples`. We use it mainly through the `/scripts/reset.sh` to quickly rebuild The Engineer. That's where we need to update the claude code model to opus (latest).

## Gathered Context

### Current Configuration
- **File:** `seed-example/plugins/claude-code-llm.yaml`
- **Current model:** `claude-sonnet-4-20250514`
- **Configuration format:** Simple YAML with `model`, `max_tokens`, and `cli_path` fields

### How seed-example is used
- The `scripts/reset.sh` script rebuilds and relinks The Engineer CLI
- When doing a full reset (not `--persist-data`), it calls `engineer start --seed ./seed-example/`
- This seeds the initial configuration from the seed-example directory

### Model Naming Convention Research
From codebase analysis:
- **Current pattern:** `claude-{model-type}-4-{YYYYMMDD}`
- **Current default:** `claude-sonnet-4-20250514`
- **Test example:** `claude-opus-4-20250514`
- **Consistent date:** All models use `20250514` across the codebase

### Latest Claude Model Research
From web search (April 2026):
- **Latest model:** Claude Opus 4.6 (released February 5, 2026)
- **Key features:** 1M token context window, improved coding skills, better agentic tasks
- **Outperforms:** GPT-5.2 by 144 Elo points, Claude Opus 4.5 by 190 points

### Scope Assessment
This is a **single file change**:
- **Change:** `seed-example/plugins/claude-code-llm.yaml`
- **From:** `model: claude-sonnet-4-20250514`
- **To:** `model: claude-opus-4-20250514` (based on existing test pattern)

The change only affects the seed configuration used during fresh setups, not existing deployments.

## Questions Asked
None required - scope is clear from codebase exploration.

## Assessment
**Ready to proceed.** This is a straightforward configuration change with clear scope:

1. **What to change:** Single line in one YAML file
2. **Pattern to follow:** Existing test shows `claude-opus-4-20250514`
3. **Impact:** Only affects fresh engineer setups via `scripts/reset.sh`
4. **Risk:** Minimal - just a model preference change for new setups

**Decision:** Use `claude-opus-4-20250514` to maintain consistency with existing codebase patterns rather than attempting to infer a new date format for 4.6.

## Team Contacts Referenced
None required for this scope.