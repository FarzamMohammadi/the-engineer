# Requirements: Update seed-example config claude code model to opus

## Task Description

**Original task:** Update seed-example config claude code model to opus

**Additional context:** The user wants to update the Claude Code model to opus (latest) in seed files located in `/seed-example`. These are used through `/scripts/reset.sh` to quickly rebuild The Engineer.

**Source:** GitHub issue FarzamMohammadi/the-engineer#8

## Gathered Context

### Current State
- The seed configuration is located in `seed-example/plugins/claude-code-llm.yaml`
- Current model is set to: `claude-sonnet-4-20250514` 
- The reset script (`scripts/reset.sh`) uses `engineer start --seed ./seed-example/` when doing a fresh setup
- The model identifier also appears in several other locations for consistency:
  - `src/plugins/llm/claude-code-llm/config.ts` (default value in schema)
  - `src/cli/templates.ts` (configuration templates)
  - `docs/plugins/llm/claude-code-llm.md` (documentation examples)

### Latest Claude Opus Model
Through web research, I found that the latest Claude Opus model is:
- **Model ID**: `claude-opus-4-6` 
- **Name**: Claude Opus 4.6
- **Status**: Latest generation model with exceptional performance in coding and reasoning

**Sources:**
- [Models overview - Claude API Docs](https://platform.claude.com/docs/en/about-claude/models/overview)
- [What's the Claude Opus 4.6 model ID in the API?](https://milvus.io/ai-quick-reference/whats-the-claude-opus-46-model-id-in-the-api)
- [Claude 4.5 Opus | AI/ML API Documentation](https://docs.aimlapi.com/api-references/text-models-llm/anthropic/claude-4.5-opus)

### Scope Considerations

**Primary scope (explicitly requested):**
- Update `seed-example/plugins/claude-code-llm.yaml` from `claude-sonnet-4-20250514` to `claude-opus-4-6`

**Secondary scope (for consistency):**
- Should also update the default model in `src/plugins/llm/claude-code-llm/config.ts` 
- Should update templates in `src/cli/templates.ts`
- Should update documentation examples in `docs/plugins/llm/claude-code-llm.md`

The task is focused on the seed-example directory, but updating related files ensures consistency across the codebase and prevents confusion when users see different model names in different places.

## Questions Asked

None required. The task is straightforward and all necessary information has been gathered through codebase exploration and web research.

## Assessment

This is a **trivial** task with clear requirements:
1. Update the Claude model identifier from Sonnet to the latest Opus
2. Target model: `claude-opus-4-6` 
3. Primary file: `seed-example/plugins/claude-code-llm.yaml`
4. Consider updating related references for consistency

The scope is well-defined, the target files are identified, and the exact model identifier is known. No ambiguities exist that would require human clarification.

**Complexity:** Trivial - Simple configuration value updates in multiple files.

## Team Contacts Referenced

No contacts needed - task is self-contained and fully researchable.