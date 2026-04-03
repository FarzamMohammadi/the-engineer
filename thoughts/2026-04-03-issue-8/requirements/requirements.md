# Requirements: Update seed-example config claude code model to opus

## Task Description
Update seed-example config claude code model to opus

From additional context:
> hey, we have some seed-files in `/seed-examples`. we use it mainly through the `/scripts/reset.sh` to quickly rebuild The Engineer. that's where we need to update the claude code model to opus (latest).

## Gathered Context

### Current Configuration
- File: `seed-example/plugins/claude-code-llm.yaml`
- Current model: `claude-sonnet-4-20250514`
- Configuration schema includes: model, max_tokens, cli_path, command_timeout_ms

### How It Works
1. The `scripts/reset.sh` script uses `engineer start --seed ./seed-example/` for fresh setups
2. The seed configuration contains plugin configs including the Claude Code LLM plugin
3. The model identifier is passed directly to Claude CLI with `--model <model>` flag
4. Command: `claude --print --output-format stream-json --verbose --model <model> --setting-sources user --dangerously-skip-permissions`

### Model Research
- **Latest Claude Opus**: Claude Opus 4.6 (released February 5, 2026)
- **API identifier**: `claude-opus-4-6` (modern API format)
- **Codebase pattern**: Uses `claude-{model}-{version}-{date}` format (e.g., `claude-sonnet-4-20250514`)
- **Test reference**: Found test case using `claude-opus-4-20250514`

### Naming Pattern Analysis
Two possible formats:
1. **Modern API format**: `claude-opus-4-6` 
2. **Codebase date format**: `claude-opus-4-6-YYYYMMDD` (following existing pattern)

## Questions Asked
None - this is researchable and the scope is clear.

## Assessment
**Ready to proceed** - This is a straightforward configuration update with clear requirements:

1. **What**: Change model identifier from Sonnet to latest Opus
2. **Where**: `seed-example/plugins/claude-code-llm.yaml`, line 3
3. **How**: Replace `claude-sonnet-4-20250514` with appropriate Opus identifier

**Implementation approach**: 
- Start with `claude-opus-4-6` (modern API format)
- If that doesn't work with Claude Code CLI, fallback to date-based format following existing pattern
- The exact format can be validated during implementation/testing

**Complexity**: Trivial - single line configuration change in a seed file.

## Team Contacts Referenced
None needed - task scope is clear and researchable.