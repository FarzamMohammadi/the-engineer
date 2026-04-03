# Requirements: Update seed-example config claude code model to opus

## Task Description
Update seed-example config claude code model to opus

**Context provided:** There are seed-files in `/seed-examples`. They're mainly used through the `/scripts/reset.sh` script to quickly rebuild The Engineer. Need to update the claude code model to opus (latest).

## Gathered Context

### Current State Analysis
- **Seed configuration location**: `/seed-example/plugins/claude-code-llm.yaml` (note: singular "seed-example", not plural)
- **Current model**: `claude-sonnet-4-20250514` 
- **Target model**: `claude-opus-4-20250514` (based on test file patterns in `src/plugins/llm/claude-code-llm/claude-code-llm.test.ts`)
- **Usage pattern**: The `scripts/reset.sh` script uses `engineer start --seed ./seed-example/` to seed initial configuration during setup

### File Structure Confirmed
```
seed-example/
├── configs/
│   ├── daemon.yaml
│   ├── orchestrator.yaml
│   ├── people.yaml
│   ├── safety.yaml
│   └── workspace.yaml
└── plugins/
    ├── bash-tool.yaml
    ├── claude-code-llm.yaml      <-- TARGET FILE
    ├── github-comm.yaml
    ├── github-hosting.yaml
    ├── github-trigger.yaml
    └── telegram-comm.yaml
```

### Current Configuration
```yaml
# Claude Code LLM plugin

model: claude-sonnet-4-20250514
max_tokens: 16384
cli_path: /Users/farzammohammadi/.local/bin/claude
```

### Model Naming Pattern
- **Sonnet (current)**: `claude-sonnet-4-20250514`
- **Opus (target)**: `claude-opus-4-20250514` 
- Pattern confirmed from test files and codebase exploration

### Cost Considerations
- Claude Opus is more expensive than Sonnet
- Current seed safety configuration has no cost limits (`cost_limits` section not present, defaults to unlimited)
- This affects the default experience for new setups but doesn't impose cost constraints

## Questions Asked
*No questions required - task scope and implementation details are clear from codebase exploration.*

## Assessment

**Clear scope and ready to proceed.** This is a simple, well-defined configuration change:

1. **What to change**: Single field `model` in `/seed-example/plugins/claude-code-llm.yaml`
2. **From**: `claude-sonnet-4-20250514`
3. **To**: `claude-opus-4-20250514`
4. **Impact**: Changes default Claude model for new Engineer setups to use the most powerful Claude tier
5. **Scope**: Single file, single field change - no other dependencies or configurations need updating

The change is straightforward with no ambiguity. The model identifier pattern is consistent and confirmed through existing test cases. This will provide users with the latest and most capable Claude model by default when they run the reset script.

## Team Contacts Referenced
- **farzam** (Farzam Mohammadi) - Task owner who confirmed the location and purpose of seed configuration files