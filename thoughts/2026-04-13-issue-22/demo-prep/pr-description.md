## Summary

Adds `skip_pr_creation` config to `workspace.yaml` that lets users skip PR creation after push. When enabled, the pipeline completes after `commitAndPush` without calling `createPullRequest`, finishing with outcome `completed` instead of `review_pending`.

Closes #22

## What changed

- **Schema** (`config.ts`): Added `skip_pr_creation` to `PrConfigSchema` with `{ default: boolean, repos: Record<string, boolean> }` shape — same per-repo override pattern as `auto_merge_after_approval` in safety.yaml.
- **Context threading** (`types.ts`, `bootstrap.ts`): Added `workspaceConfig` to `OrchestratorContext` so the phase runner can read workspace-level config.
- **Phase runner** (`phase-runner.ts`): 27-line block after successful push checks skip config. If enabled, logs, sends milestone + ticket notifications ("PR creation skipped per config"), and returns `null` to continue the pipeline to integration/completion.
- **Docs** (`overview.md`): Updated flow diagram, added config section with YAML example, added notification matrix row.
- **Seed config** (`workspace.yaml`): Added `skip_pr_creation: { default: false }` example.
- **Tests**: 3 schema tests (defaults, global override, per-repo override) + 3 phase-runner tests (skip enabled, per-repo override, notification verification). All 80 targeted tests pass.

## Configuration

```yaml
# workspace.yaml
pr:
  skip_pr_creation:
    default: false                # Global default (PR created as usual)
    repos:
      owner/internal-tools: true  # Push-only for this repo
```

Per-repo values override the global default. Repos not listed fall back to `default`.

## How to test

1. **Schema validation**: `npm run test:unit -- --testPathPattern config.test`
2. **Phase runner logic**: `npm run test:unit -- --testPathPattern phase-runner.test`
3. **Type check**: `npm run typecheck` (only pre-existing error in `git-hosting.test.ts`)
4. **Full unit suite**: `npm run test:unit`
5. **Manual**: Set `skip_pr_creation.default: true` in workspace.yaml, run a task — verify no PR is created and task completes with `completed` outcome.
