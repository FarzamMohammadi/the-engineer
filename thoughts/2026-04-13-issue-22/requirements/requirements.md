# Requirements: Add skip_pr_creation config — push-only mode for PR workflow

## Task Description
Add a configuration option (`skip_pr_creation`) that tells The Engineer to skip PR creation after pushing code. When enabled, `commitAndPush` runs normally but `createPullRequest` is skipped entirely. The task completes with outcome `completed` instead of `review_pending`.

Source: GitHub issue FarzamMohammadi/the-engineer#22

## Gathered Context

### Current PR Workflow
The PR workflow lives in `tryCommitPushAndCreatePR()` in `src/core/orchestrator/phase-runner.ts` (lines 457-512). It is called from two locations in `handlePostPhaseActions()`:
1. After `demo_prep` phase (line 742)
2. Fast-path: when `self_review` is the final phase (line 771)

The flow is:
1. `prManager.commitAndPush()` — commit and push to remote
2. `prManager.createPullRequest()` — create or update PR via git hosting plugin
3. If PR created: exit pipeline with `review_pending` outcome
4. If `no_hosting_plugin`: return null (continue pipeline to next phase)

### Where the Config Goes
The issue says to follow `auto_merge_after_approval` pattern. That config lives in `MergePolicySchema` in `src/schemas/config.ts` (lines 592-621) under `safety.yaml`, with a `default: boolean` + `repos: Record<string, boolean>` structure for per-repo overrides.

However, `skip_pr_creation` is semantically a **workspace/PR workflow concern**, not a safety concern. The existing `PrConfigSchema` in `workspace.yaml` (lines 323-343) already holds PR-related settings (`default_merge_strategy`, `delete_branch_after_merge`, `branch_retention_days`).

**Decision: place it in `PrConfigSchema` under `workspace.yaml`**, but use the `auto_merge_after_approval` per-repo override pattern (`default` + `repos` map). This gives per-repo control while keeping PR config co-located.

The issue explicitly says "follow the existing YAML config pattern" and "support per-repo overrides," so using the `{ default: bool, repos: Record<string, bool> }` shape is correct.

### Config Access Path
- `OrchestratorContext.config` is `OrchestratorConfig` (orchestrator.yaml only)
- `tryCommitPushAndCreatePR` has access to `ctx` (OrchestratorContext) and `prManager`
- `PrManager` constructor takes the full `OrchestratorContext` — so it has access to `ctx.workspaceManager` but NOT workspace config directly
- Need to determine how workspace config is accessed at runtime. The `PrManager` already uses `ctx.workspaceManager` for worktree paths. The workspace config itself may need to be passed in or accessed via a config store.

### What Changes

1. **Schema** (`src/schemas/config.ts`): Add `skip_pr_creation` to `PrConfigSchema` with `{ default: false, repos: {} }` shape
2. **Phase runner** (`src/core/orchestrator/phase-runner.ts`): In `tryCommitPushAndCreatePR()`, after successful push, check config before calling `createPullRequest()`. If skip is enabled for this repo, return null (continue pipeline) with outcome `completed`
3. **Notification**: When skipping PR, send a "pushed to branch" notification instead of "PR created"
4. **Docs** (`docs/user-flows/pr-management/overview.md`): Document the new config option
5. **Seed configs** (`seed-example/configs/workspace.yaml`): Add commented example
6. **Tests**: Cover enabled/disabled paths in both phase-runner and config schema tests

### Key Design Details

**When skip is enabled, after push:**
- Do NOT call `createPullRequest()` at all
- Record phase transition
- End session with `completed` outcome (not `review_pending`)
- Send milestone notification about branch push
- Return a pipeline exit result

**When skip is disabled (default):**
- No behavior change whatsoever

**Per-repo resolution:**
- Check `repos[repoSlug]` first, fall back to `default`
- Repo identifier format: match `auto_merge_after_approval` convention (likely `owner/repo`)

### Files to Modify
- `src/schemas/config.ts` — add `skip_pr_creation` to `PrConfigSchema`
- `src/schemas/config.test.ts` — schema validation tests
- `src/core/orchestrator/phase-runner.ts` — check config in `tryCommitPushAndCreatePR()`
- `src/core/orchestrator/phase-runner.test.ts` — test both paths
- `src/core/orchestrator/pr-manager.ts` — may need to expose repo slug for config lookup
- `docs/user-flows/pr-management/overview.md` — document the config
- `seed-example/configs/workspace.yaml` — add example
- `test/fixtures/configs/valid-workspace.yaml` — add fixture if needed
- `src/config/loader.test.ts` — config loading tests if needed

## Questions Asked
None — all requirements are determinable from the issue and codebase.

## Assessment
Requirements are clear and complete. The issue is well-scoped with explicit acceptance criteria. The codebase patterns are well-established. No ambiguity requires human input.

**One design question I resolved through investigation:** Where to put the config. The issue references both `safety.yaml` (`auto_merge_after_approval`) and `workspace.yaml` (`pr` settings) as patterns to follow. I chose `workspace.yaml` under `PrConfigSchema` because:
1. It's a PR workflow behavior, not a safety guard
2. It co-locates with other PR settings
3. The per-repo override pattern from `auto_merge_after_approval` can be reused regardless of which YAML file hosts it

**Edge cases considered:**
- Process restart mid-push: `commitAndPush` is synchronous git operations — no new state to worry about. If restart happens after push but before pipeline continues, normal task resumption from checkpoint handles it
- No git hosting plugin AND skip enabled: skip takes precedence (both lead to same result — no PR created)
- Multi-repo tasks: per-repo override handles this naturally
- Rework flow (PR already exists): skip config should still apply — if enabled, rework pushes but doesn't update PR. The `isRework` check in `createPullRequest` is bypassed entirely

## Team Contacts Referenced
- Farzam Mohammadi (owner) — not contacted, requirements are clear from issue
