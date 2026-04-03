# Requirements: Update seed-example config claude code model to opus

## Task Description
Update seed-example config claude code model to opus. The seed-files in `/seed-examples` are used through the `/scripts/reset.sh` to quickly rebuild The Engineer. The Claude Code model needs to be updated to opus (latest).

## Gathered Context

### Current Configuration
- **File**: `seed-example/plugins/claude-code-llm.yaml`
- **Current model**: `claude-sonnet-4-20250514` (Claude Sonnet 4 from May 14, 2025)
- **Other settings**: `max_tokens: 16384`, `cli_path: /Users/farzammohammadi/.local/bin/claude`

### Target Configuration  
- **New model**: `claude-opus-4-6` (Claude Opus 4.6, released February 5, 2026)
- **Model naming pattern**: Newer Claude models (4.6+) use simplified identifiers without date suffixes

### Usage Context
- The `scripts/reset.sh` script uses `engineer start --seed ./seed-example/` when doing a full reset
- This seeds the configuration during initial setup, making it the default for new installations
- The script rebuilds the CLI and optionally wipes `~/.engineer` directory before starting with seed configs

### Research Sources
- [Claude Code model configuration | Claude Help Center](https://support.claude.com/en/articles/11940350-claude-code-model-configuration)
- [Model configuration - Claude Code Docs](https://code.claude.com/docs/en/model-config)  
- [What's the Claude Opus 4.6 model ID in the API?](https://milvus.io/ai-quick-reference/whats-the-claude-opus-46-model-id-in-the-api)
- [Models overview - Claude API Docs](https://platform.claude.com/docs/en/about-claude/models/overview)

### Codebase Evidence
- Test file `src/plugins/llm/claude-code-llm/claude-code-llm.test.ts` shows usage of `claude-opus-4-20250514` pattern
- Default model in `src/plugins/llm/claude-code-llm/config.ts` is `claude-sonnet-4-20250514`
- Model identifiers follow format: `claude-{model-type}-{version}` for newer models (4.6+)

## Questions Asked
None required - all information was researchable.

## Assessment
This is enough to proceed to research. The task is well-defined:

**What to change**: Update the `model` field in `seed-example/plugins/claude-code-llm.yaml`  
**From**: `claude-sonnet-4-20250514`  
**To**: `claude-opus-4-6`

The change is minimal, isolated, and has a clear expected outcome. No ambiguity remains about the requirements or implementation approach.

## Team Contacts Referenced
None required - task is self-contained.