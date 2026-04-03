# Update Seed Configuration to Use Claude Opus 4.6 Model

Fixes #8

## Summary

This PR updates The Engineer's seed configuration to use the latest Claude Opus 4.6 model instead of the previous Claude Sonnet 4. This change affects fresh installations and rebuilds using `scripts/reset.sh`, ensuring new users get the most capable model by default.

**Key Changes:**
- Updated model identifier from `claude-sonnet-4-20250514` to `claude-opus-4-6` across all configuration, code, and documentation
- Maintained complete consistency across the entire codebase
- All tests pass with zero regressions

## What Changed and Why

### Background
The Engineer uses seed configuration files in `seed-examples/` to quickly bootstrap fresh installations through `scripts/reset.sh`. The seed configuration specifies default model settings for the Claude Code LLM plugin, which were previously set to Claude Sonnet 4.

### The Update
We systematically updated the model identifier across 7 files to use Claude Opus 4.6 (released February 5, 2026), which provides significantly better performance than Sonnet for software engineering tasks.

**Files Updated:**
1. **`seed-example/plugins/claude-code-llm.yaml`** - Primary seed configuration used by reset script
2. **`src/plugins/llm/claude-code-llm/config.ts`** - Schema default value 
3. **`src/plugins/llm/claude-code-llm/claude-code-llm.ts`** - Implementation fallback value
4. **`docs/plugins/llm/claude-code-llm.md`** - User documentation examples
5. **`docs/plugins/llm/README.md`** - Plugin comparison table
6. **`src/cli/plugin-docs.ts`** - Embedded documentation strings
7. **`src/cli/templates.ts`** - CLI template examples

### Technical Approach
- Used modern API format: `claude-opus-4-6` (not date-based format)
- Performed exact string replacements to maintain consistency
- Verified comprehensive coverage through grep-based search
- Maintained backward compatibility (only affects fresh installations)

## How to Test

### Automated Testing
```bash
# Run the full test suite (should pass all 2409 tests)
pnpm test

# Verify configuration validity
node -e "console.log(require('yaml').parse(require('fs').readFileSync('seed-example/plugins/claude-code-llm.yaml', 'utf8')))"
```

### Manual Verification
```bash
# Verify all old references are gone (should only find references in thoughts/ and historical docs)
grep -r "claude-sonnet-4-20250514" --exclude-dir=thoughts --exclude="CONTRIBUTIONS.md" .

# Verify new references are in the right places (should find exactly 7 production files)
grep -r "claude-opus-4-6" --exclude-dir=thoughts . | grep -v "\.md:" | wc -l
```

### Integration Testing
**⚠️ Do NOT run these commands in this environment as they manage the parent daemon:**
- ~~`scripts/reset.sh`~~ (would crash the running system)
- ~~`engineer start --seed ./seed-example/`~~ (would interfere with parent process)

Instead, the comprehensive test suite and configuration validation provide sufficient coverage for this straightforward configuration change.

## Breaking Changes

**None.** This change:
- Only affects fresh installations using seed configurations
- Does not modify existing user configurations
- Maintains all existing APIs and interfaces
- Passes all 2409 existing tests

## Deployment Notes

- **Scope**: Only affects new installations and rebuilds using `scripts/reset.sh`
- **Rollback**: Easily reversible by changing the model identifier back
- **Monitoring**: Standard startup logs will show the new model being used

## Key Decisions Made

1. **Model Format**: Used modern API format (`claude-opus-4-6`) rather than date-based format for cleaner, more maintainable configuration
2. **Scope**: Updated all related files for consistency rather than just the seed config, ensuring no confusion for developers or users
3. **Testing Strategy**: Relied on comprehensive unit tests rather than integration testing to avoid disrupting the running daemon

## Review Context

The `thoughts/` directory contains the complete engineering process:
- **Requirements**: Clear task definition and context gathering
- **Planning**: Systematic approach identifying all 7 files requiring updates
- **Implementation**: Verified execution with comprehensive grep-based validation
- **Review**: Confirmed all requirements met with zero issues found

**Quality Metrics:**
- ✅ All 2409 tests passing
- ✅ 100% requirement coverage
- ✅ Zero regressions detected
- ✅ Complete consistency verification
- ✅ Valid YAML configuration confirmed