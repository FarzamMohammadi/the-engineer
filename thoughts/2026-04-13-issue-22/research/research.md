# Research: Add skip_pr_creation config — push-only mode for PR workflow

## Task Context
Add `skip_pr_creation` to `PrConfigSchema` (workspace.yaml) with per-repo overrides. When enabled, skip PR creation after push and complete the task with `completed` outcome instead of `review_pending`. Full details in requirements.md.

## Codebase Analysis

### Config System
- **Config loading**: `src/config/loader.ts` loads `workspace.yaml` → `WorkspaceConfigSchema` → `ConfigBundle.workspace`
- **WorkspaceConfigSchema** (config.ts:374-404) contains `pr: PrConfigSchema.default({})` at line 395
- **PrConfigSchema** (config.ts:323-343) currently has 3 fields: `default_merge_strategy`, `delete_branch_after_merge`, `branch_retention_days`
- **Per-repo override pattern**: `MergePolicySchema` (config.ts:592-611) uses `{ default: z.boolean().default(false), repos: z.record(z.boolean()).default({}) }` — this is the exact pattern to replicate

### Config Access: The Critical Gap
- **OrchestratorContext** (types.ts:20-36) has `config: OrchestratorConfig` — this is `orchestrator.yaml`, NOT workspace config
- **DaemonContext** (daemon/types.ts:18-20) has `workspaceConfig: WorkspaceConfig` — the daemon CAN access workspace config
- **Bootstrap** (cli/bootstrap.ts:173-187) passes `config.orchestrator` to Orchestrator, `config.workspace` to Daemon separately
- **The orchestrator does not have workspace config.** This is the main integration challenge.

### PR Workflow: tryCommitPushAndCreatePR
- Located at `phase-runner.ts:457-512`
- Called from two places in `handlePostPhaseActions`:
  1. After `demo_prep` phase (line 742)
  2. Fast-path: when `self_review` is the last phase (line 771)
- Signature: takes `ctx: OrchestratorContext` and `prManager: PrManager`
- After successful push, calls `prManager.createPullRequest()`. The skip logic goes between push success and PR creation.

### PrManager
- Interface at `pr-manager.ts:89-107`, factory at line 112
- `createPrManager(ctx: OrchestratorContext, notifications: NotificationRouter)` — created in Orchestrator constructor (index.ts:127)
- `commitAndPush` uses `ctx.workspaceManager.getWorkspaceRecord(taskId)` which returns `record.repo` (format: `"owner/repo"`) — this is the repo identifier for per-repo config lookup

### How the Pipeline Completes
- Normal completion: pipeline reaches end, outcome = `Outcomes.completed` (phase-runner.ts:1126-1131)
- PR exit: `tryCommitPushAndCreatePR` returns `{ kind: "exit", result: { outcome: Outcomes.review_pending, ... } }` (line 508-511)
- When `tryCommitPushAndCreatePR` returns `null`, pipeline continues to next phase (integration, then completes normally)

### Notifications
- PR created: `NotificationKinds.milestone` + `NotificationKinds.ticket_comment` with "PR created: {url}" (pr-manager.ts:390-399)
- For skip_pr_creation, need a "pushed to branch" notification using same kinds

## Relevant Files

### Must Modify
- `src/schemas/config.ts` — Add `skip_pr_creation` to `PrConfigSchema` with `{ default: false, repos: {} }` shape
- `src/schemas/config.test.ts` — Schema validation tests (see existing `PrConfigSchema` test at line 218, `MergePolicySchema` per-repo test at line 404)
- `src/core/orchestrator/phase-runner.ts` — Check skip config in `tryCommitPushAndCreatePR()` between push success and PR creation (around line 484)
- `src/core/orchestrator/phase-runner.test.ts` — Test both skip/no-skip paths (see existing PR test at line 529)
- `src/core/orchestrator/types.ts` — Add `workspaceConfig: WorkspaceConfig` to `OrchestratorContext` interface
- `src/core/orchestrator/index.ts` — Accept and store workspace config in Orchestrator constructor
- `src/cli/bootstrap.ts` — Pass `config.workspace` to Orchestrator
- `docs/user-flows/pr-management/overview.md` — Document the config (Section 6: Configuration)
- `seed-example/configs/workspace.yaml` — Add commented example

### May Need to Modify
- `src/core/orchestrator/pr-manager.ts` — If notification logic for "pushed to branch" lives here rather than phase-runner. The current PR notification is in pr-manager.ts, so a new "skip" notification might go in phase-runner.ts instead since the skip decision is made there.

### Context Files (read-only reference)
- `src/config/loader.ts` — Config loading (no changes needed, already loads workspace.yaml)
- `src/core/daemon/types.ts` — `DaemonContext` pattern for workspace config access (line 20)
- `src/core/safety-layer/policy-engine.ts` — `checkAutoMergeAllowed()` per-repo resolution pattern (line 279-283)
- `src/schemas/notifications.ts` — Notification kinds (milestone, ticket_comment)

## Patterns & Conventions

### Config Schema Pattern
- Zod schemas with `.default()` and `.describe()` on every field
- Exported as `const FooSchema = z.object({...})` + `type Foo = z.infer<typeof FooSchema>`
- Per-repo override: `z.object({ default: z.boolean().default(false), repos: z.record(z.boolean()).default({}) }).default({})`

### Config Test Pattern
- One `describe` block per schema
- Test defaults from empty input, then test specific overrides
- Direct `Schema.parse({})` calls, expect assertions on each field

### Phase Runner Test Pattern
- `createMockContext()` builds `OrchestratorContext` with vi.fn() mocks
- `createDeps()` builds `PhaseRunnerDeps` with mock prManager
- Override specific mock return values via cast: `(deps.prManager.commitAndPush as ReturnType<typeof vi.fn>).mockReturnValue(...)`
- Test PR flow by configuring mock prManager responses, run `runPhasePipeline`, assert outcome

### Per-Repo Resolution Pattern (from policy-engine.ts:279-283)
```typescript
const mergeConfig = this.config.merge.auto_merge_after_approval;
const repoSetting = mergeConfig.repos[repo];
return repoSetting ?? mergeConfig.default;
```

### Seed Config Pattern
- YAML with comments, fields present with reasonable values (not commented-out defaults)

## Architectural Patterns in Target Files

### phase-runner.ts
- Pure functions at module level (not class methods)
- `tryCommitPushAndCreatePR` is a standalone async function taking explicit dependencies
- Returns `PhaseCompletionResult | null` — null means "continue pipeline"
- Error handling via `blockForPrWorkflowError` helper
- Post-PR bookkeeping (recordPhaseTransition, endSession) in a try/catch that never blocks

### config.ts
- Schemas grouped by config file with section comments
- Each config file section has a top-level schema (WorkspaceConfigSchema) that nests sub-schemas (PrConfigSchema, CleanupConfigSchema)
- Defaults handle missing fields gracefully — empty `{}` always produces valid config

### types.ts (OrchestratorContext)
- Flat interface, no nesting — each dependency is a top-level field
- Mixed concerns: config, event bus, plugins, engines, managers, observer

## Dependencies & Integration Points

### Adding workspaceConfig to OrchestratorContext
This is the only way to get workspace config into `tryCommitPushAndCreatePR`. The change touches:
1. `types.ts` — Add field to interface
2. `index.ts` — Orchestrator constructor accepts and stores it
3. `bootstrap.ts` — Pass `config.workspace` alongside `config.orchestrator`
4. `phase-runner.test.ts` — `createMockContext()` must include `workspaceConfig`

### Repo slug availability
`tryCommitPushAndCreatePR` doesn't currently know the repo slug. Two options:
1. Get it from `ctx.workspaceManager.getWorkspaceRecord(taskId).repo` — same pattern pr-manager uses
2. Pass it up from the push result

Option 1 is cleaner — the workspace manager is already on the context, and pr-manager already uses this exact call pattern.

## Contract Verification

- `getWorkspaceRecord(taskId)` returns `{ repo: string, branch: string, baseBranch: string }` — `repo` is the `owner/repo` format used in per-repo configs (verified from policy-engine.test.ts line 66-67)
- `Outcomes.completed` and `Outcomes.review_pending` are the two relevant outcome constants (types.ts:80-84)
- `SessionEndReasons.review_pending` and `SessionEndReasons.completed` are the session end reasons
- `NotificationKinds.milestone` and `NotificationKinds.ticket_comment` are the notification kinds for PR-like events

## Complexity Assessment

**Moderate.** The config addition and schema changes are straightforward. The main complexity is:
1. Threading workspace config into OrchestratorContext (touches 4 files, all test mocks)
2. Getting the notification right when skipping PR creation
3. Handling the interaction with rework flow (when `isRework` and skip is enabled)

## Open Questions

None. All design decisions are resolved through codebase investigation.

## Key Findings

1. **OrchestratorContext needs workspaceConfig added.** This is the biggest structural change — the orchestrator currently cannot access workspace config. DaemonContext already has this pattern, so it's a known approach.

2. **The skip logic goes in `tryCommitPushAndCreatePR` (phase-runner.ts), not in pr-manager.** The decision to skip is a pipeline orchestration concern, not a PR mechanics concern. After push succeeds and before `createPullRequest` is called, check the config.

3. **When skip is enabled, return `null` from `tryCommitPushAndCreatePR`.** Returning null means "continue pipeline" — the pipeline proceeds to integration phase and completes normally with `completed` outcome. This is the same path as `no_hosting_plugin`.

4. **A "pushed to branch" notification should be sent before returning null.** Without this, the owner gets no feedback that work was pushed.

5. **Repo slug for per-repo lookup**: use `ctx.workspaceManager.getWorkspaceRecord(taskId)?.repo` — same pattern pr-manager already uses.

## Simplest Viable Approach

1. Add `skip_pr_creation: z.object({ default: z.boolean().default(false), repos: z.record(z.boolean()).default({}) }).default({})` to `PrConfigSchema`
2. Add `workspaceConfig: WorkspaceConfig` to `OrchestratorContext`
3. In `tryCommitPushAndCreatePR`, after push succeeds (line ~484), check `workspaceConfig.pr.skip_pr_creation` for the repo. If skip enabled: send "pushed to branch" notification, return null (continue pipeline to integration → completed)
4. Update tests, docs, seed config

The "return null" approach is the minimum change — it reuses the existing "no hosting plugin" continuation path. The pipeline proceeds to integration and completes normally. No new outcome types, no new session end reasons, no new state transitions.

## Assumptions Made

1. **Returning null from tryCommitPushAndCreatePR when skip is enabled will produce the correct completion flow.** Verified: null → pipeline continues → integration runs → completes with `Outcomes.completed`. This matches the `no_hosting_plugin` path.
2. **The repo slug from `getWorkspaceRecord` matches the format used in per-repo config keys.** Verified: both use `"owner/repo"` format.
3. **Adding workspaceConfig to OrchestratorContext won't break existing tests** beyond requiring mock updates. Verified: OrchestratorContext is an interface, adding an optional or required field only affects code that constructs instances of it.

## Patterns Questioned

1. **OrchestratorContext not having workspaceConfig**: This seems like an oversight rather than intentional design. DaemonContext has it, and the Orchestrator's PrManager already needs workspace-level config (the skip_pr_creation feature proves this). The workspace config was probably not needed before because PR settings were only consumed by the daemon (merge strategy, branch deletion). Now that pre-PR decisions need workspace config, it should be added. This is not over-engineering — it's filling a gap.

2. **The notification when skipping**: The current code sends notifications from inside pr-manager.ts (for PR created) and phase-runner.ts (for errors). For the skip case, the notification should come from phase-runner.ts since the decision is made there and pr-manager is not called at all.
