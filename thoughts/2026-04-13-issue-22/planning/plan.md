# Plan: Add skip_pr_creation config — push-only mode for PR workflow

## Approach Evaluation

### Simplest Path
Add `skip_pr_creation` to `PrConfigSchema` with per-repo override shape. Thread `WorkspaceConfig` into `OrchestratorContext`. In `tryCommitPushAndCreatePR`, after successful push, check the config — if skip enabled for this repo, send a "pushed to branch" notification and return `null` (continue pipeline → integration → `completed`).

This reuses the existing `no_hosting_plugin` continuation path (return null from `tryCommitPushAndCreatePR`), requires no new outcome types, no new session end reasons, no new state transitions.

**Cost:** Adding `workspaceConfig` to `OrchestratorContext` touches the interface, constructor, bootstrap, and all test mocks that construct the context. This is the largest structural change.

### Alternative Path
Instead of threading the entire `WorkspaceConfig` through, pass only the resolved `skip_pr_creation` boolean into `tryCommitPushAndCreatePR` as a parameter. This avoids modifying `OrchestratorContext` and keeps the function signature self-documenting.

**Benefit:** No structural change to the context interface. Smaller blast radius in tests — only `handlePostPhaseActions` call sites need updating, not every `createMockContext()`.

**Cost:** The resolution logic (per-repo lookup) must happen in `handlePostPhaseActions` before calling `tryCommitPushAndCreatePR`, requiring `handlePostPhaseActions` to also access workspace config somehow — so we still need to thread it through. Or we resolve it even earlier (in the Orchestrator) and pass it down through `PhaseRunnerDeps`. This just moves the problem.

### Chosen Approach
**Simplest path — add `workspaceConfig` to `OrchestratorContext`.**

The alternative moves the same complexity around without reducing it. `OrchestratorContext` is the established dependency-injection surface for orchestrator subsystems (14 fields already). Adding one more follows the pattern. `DaemonContext` already has `workspaceConfig` — the orchestrator should too, and will likely need it for future workspace-level config access. The mock update in tests is mechanical.

## Architectural Filters

- **Plugin Blindness:** ✅ Core remains unaware of plugins. The skip decision is in the phase runner (Core), gated by config — no plugin knowledge needed. The `no_hosting_plugin` path already exists and is unchanged.
- **Isolation:** ✅ No shared mutable state. `WorkspaceConfig` is startup-only (not hot-reloadable, per the config.ts comment). Read-only after construction.
- **Boundaries:** ✅ Working through defined contracts — `OrchestratorContext` interface, `PrConfigSchema`, `WorkspaceRecord.repo`. No reaching into module internals.
- **Reversibility:** Low risk. Adding a field to `OrchestratorContext` is additive. The schema field has a `default: false` — disabling it returns to current behavior. **One irreversible decision:** the config shape (`{ default, repos }` nested object). Once users write configs against it, changing the shape is a migration. But this matches `auto_merge_after_approval` exactly, so it's a proven pattern.

## Phases

### Phase 1: Schema — Add `skip_pr_creation` to `PrConfigSchema`
- [x] In `src/schemas/config.ts`, add `skip_pr_creation` field to `PrConfigSchema` (after `branch_retention_days`, line ~343):
  ```
  skip_pr_creation: z.object({
    default: z.boolean().default(false),
    repos: z.record(z.boolean()).default({}),
  }).default({}).describe("Skip PR creation after push. When enabled, the task completes after pushing to the remote branch. Supports per-repo overrides.")
  ```
- [x] In `src/schemas/config.test.ts`, add tests for `skip_pr_creation`:
  - Default from empty input: `{ default: false, repos: {} }`
  - Override default: `{ default: true }` → parsed correctly
  - Per-repo override: `{ repos: { "owner/repo": true } }` → parsed correctly
- **Verify:** `npm run typecheck` passes. Schema tests pass.

### Phase 2: Context — Thread `workspaceConfig` into OrchestratorContext
- [x] In `src/core/orchestrator/types.ts`, add `workspaceConfig: WorkspaceConfig` to `OrchestratorContext` interface (import `WorkspaceConfig` from `../../schemas/config.ts`)
- [x] In `src/core/orchestrator/index.ts`, the `Orchestrator` constructor already receives `ctx: OrchestratorContext` — no changes needed to the constructor itself. The caller must pass `workspaceConfig` as part of the context object.
- [x] In `src/cli/bootstrap.ts`, add `workspaceConfig: config.workspace` to the object passed to `new Orchestrator({...})` (line ~173-187)
- [x] Update `createMockContext()` in ALL 5 test files + 2 test helpers (integration-context.ts, test-orchestrator.ts) + test-workspace-manager.ts that construct `OrchestratorContext` to include `workspaceConfig: WorkspaceConfigSchema.parse({})` (import `WorkspaceConfigSchema`):
  - `src/core/orchestrator/phase-runner.test.ts`
  - `src/core/orchestrator/pr-manager.test.ts`
  - `src/core/orchestrator/workspace-lifecycle.test.ts`
  - `src/core/orchestrator/llm-caller.test.ts`
  - `src/core/orchestrator/decomposition-handler.test.ts`
- **Verify:** `npm run typecheck` passes. All existing tests pass unchanged.

### Phase 3: Logic — Skip PR creation in phase-runner
- [x] In `src/core/orchestrator/phase-runner.ts`, in `tryCommitPushAndCreatePR` (line ~484), after the push success check and before `createPullRequest` call, add:
  1. Get workspace record: `const record = ctx.workspaceManager.getWorkspaceRecord(taskId)`
  2. If record exists, resolve skip setting: `const skipConfig = ctx.workspaceConfig.pr.skip_pr_creation; const shouldSkip = record ? (skipConfig.repos[record.repo] ?? skipConfig.default) : skipConfig.default`
  3. If `shouldSkip`: log it, send milestone + ticket_comment notifications ("Changes pushed to branch `{record.branch}` on `{record.repo}` — PR creation skipped per config"), return `null`
- [x] The notification uses `ctx.notifications.notify()` which is already on the context (used elsewhere in phase-runner for error cases).
- **Verify:** `npm run typecheck` passes.

### Phase 4: Tests — Cover skip and no-skip paths
- [x] In `src/core/orchestrator/phase-runner.test.ts`, add test: "completes with `completed` when `skip_pr_creation` is enabled and push succeeds":
  - Create mock context with `workspaceConfig: WorkspaceConfigSchema.parse({ pr: { skip_pr_creation: { default: true } } })`
  - Mock `workspaceManager.getWorkspaceRecord` to return `{ repo: "owner/repo", branch: "feature-branch", ... }`
  - Mock `commitAndPush` → `{ outcome: "pushed", committed: true }`
  - Assert: `createPullRequest` never called, result outcome is `completed`
- [x] Add test: "creates PR when `skip_pr_creation` is disabled (default)" (covered by existing test at line 530):
  - Use default workspace config (skip_pr_creation defaults to false)
  - Assert: `createPullRequest` IS called (existing test `529` already covers this, but verify the new config doesn't regress it)
- [x] Add test: "respects per-repo override for skip_pr_creation":
  - Config: `{ default: false, repos: { "owner/repo": true } }`
  - Mock workspace record with repo `"owner/repo"`
  - Assert: PR creation skipped
- [x] Add test: "sends notification when skipping PR creation":
  - Assert `ctx.notifications.notify` called with milestone kind containing branch info
- **Verify:** `npm run test:unit` passes — all new and existing tests green.

### Phase 5: Docs and seed config
- [x] In `docs/user-flows/pr-management/overview.md`, add a section (after Section 1 "PR Creation" or in a "Configuration" section) documenting `skip_pr_creation`:
  - What it does
  - Config location (`workspace.yaml` → `pr` → `skip_pr_creation`)
  - Per-repo override example
  - Behavior when enabled vs disabled
- [x] In `seed-example/configs/workspace.yaml`, add `skip_pr_creation` under `pr:`:
  ```yaml
  skip_pr_creation:
    default: false
  ```
- **Verify:** Docs render correctly. Seed config parses without error (run a quick schema parse).

### Phase 6: Final validation
- [x] Run `npm run typecheck` — zero errors (only pre-existing git-hosting.test.ts error)
- [x] Run `npm run lint` — zero new warnings/errors
- [x] Run `npm run test:unit` — all 2547 tests green
- [x] No integration test changes needed — config-gated branch in existing logic
- **Verify:** All checks pass.

## Risks & Mitigations
- **Risk:** Adding `workspaceConfig` to `OrchestratorContext` breaks tests that construct the context without it → **Mitigation:** TypeScript will catch every callsite. Update `createMockContext` in phase-runner.test.ts and search for other test files constructing `OrchestratorContext`.
- **Risk:** `getWorkspaceRecord(taskId)` returns null (no workspace allocated for task) → **Mitigation:** Already handled — `tryCommitPushAndCreatePR` is only called after `commitAndPush` succeeds, which itself checks for workspace record. But add a defensive check: if no record, fall through to default config value.
- **Risk:** Config shape mismatch with `auto_merge_after_approval` confuses users → **Mitigation:** Same shape, same section comment pattern, `.describe()` on the field.

## Pre-mortem

1. **Stale config on rework:** If a user changes `skip_pr_creation` between the initial run and a rework run, the config is loaded at startup and not hot-reloaded. The rework run would use the config from when the daemon started. **Acceptable:** All workspace config is startup-only (documented in config.ts comment). Restart the daemon to pick up changes — matches existing behavior for all other workspace config.

2. **Race between skip decision and PR creation by another path:** Could `createPullRequest` be called from somewhere other than `tryCommitPushAndCreatePR`? Searched: it's only called from `tryCommitPushAndCreatePR` (line 485). No race. Single code path.

3. **Notification gap:** If skip is enabled and push succeeds but the notification fails (notify throws), the pipeline continues without notifying the owner. **Mitigated:** `notify()` is fire-and-forget in the existing codebase (no await, no throw propagation). The pattern is consistent.

## Test Strategy

- **Unit tests in phase-runner.test.ts:** Primary coverage. Test the skip decision at the orchestration level — the only place the logic lives. Four tests: skip enabled (default true), skip disabled (default false, existing behavior), per-repo override, notification sent.
- **Unit tests in config.test.ts:** Schema parsing — defaults, overrides, per-repo structure.
- **Edge cases:** No workspace record (defensive null check), `nothing_to_push` outcome (skip logic never reached — existing test covers this), push error (skip logic never reached).
- **No integration tests needed:** The change is a config-gated branch in existing orchestration logic. The git/push mechanics are unchanged.

## Success Criteria
- [ ] `skip_pr_creation: { default: true }` in workspace.yaml causes tasks to complete with `completed` outcome after push, without calling `createPullRequest`
- [ ] Default behavior (skip disabled) is unchanged — PR is created as before
- [ ] Per-repo overrides work: `repos: { "owner/repo": true }` skips for that repo, others use default
- [ ] Notification sent when PR creation is skipped (milestone + ticket_comment)
- [ ] All existing tests pass without modification (beyond adding `workspaceConfig` to mock contexts)
- [ ] `typecheck`, `lint`, `test:unit` all clean
- [ ] Docs and seed config updated
