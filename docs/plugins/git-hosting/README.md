# Git Hosting Adapter

Git Hosting adapters manage the PR lifecycle on remote code hosting platforms. They are the remote API layer -- local git operations (worktrees, commits, branches) are handled by the Workspace Manager, not here.

This adapter type is fully separate from Communication adapters. PRs are code artifacts, not messages. GitHub needs three plugins (Trigger, Communication, Hosting) because each operates in a different capability domain.

Every method is required. There are no optional or capability-gated methods. Each implementation must handle the full PR lifecycle: create, update, merge, close, query status, query reviews, dismiss stale approvals, comment, fetch comments, check branch protection, and resolve default branch. The full method list is in the contract table below.

A core safety invariant: never force-merge. If branch protection rules are not satisfied, return a failed `MergeResult` (`success: false` with `reason: "not_mergeable"`) rather than bypassing them.

## Contract

The abstract class `GitHostingAdapter` extends `BaseAdapter`. Plugin authors implement the `do*` protected methods. The public methods wrap them with error handling -- unknown errors become `AdapterMethodError` with `internal_error` code. Like every adapter, it receives a [PluginContext](../plugin-context.md) (`this.context.logger`, `this.context.stateStore`) injected before `initialize()`.

| Public Method | Signature | Returns |
|---|---|---|
| `createPR` | `(options: PROptions) => Promise<PRResult>` | `{ pr_number, url }` |
| `updatePR` | `(repo: string, prNumber: number, updates: PRUpdates) => Promise<void>` | -- |
| `mergePR` | `(repo: string, prNumber: number, strategy: MergeStrategy) => Promise<MergeResult>` | `{ success: true, merge_sha }` or `{ success: false, reason, message }` |
| `closePR` | `(repo: string, prNumber: number) => Promise<void>` | -- |
| `getPRStatus` | `(repo: string, prNumber: number) => Promise<PRStatus>` | `{ state, checks_state, merge_state, url }` |
| `getReviewStatus` | `(repo: string, prNumber: number) => Promise<ReviewStatus>` | `{ approved, approvals, changes_requested, reviewers, comments }` |
| `getPRComments` | `(repo: string, prNumber: number) => Promise<PRComment[]>` | Array of `{ id, author, body, created_at }` |
| `detectPrEvents` | `(repo: string, prNumber: number) => Promise<PrEvent[]>` | Typed PR events that currently hold (see below) |
| `commentOnPR` | `(repo: string, prNumber: number, comment: string, replyTo?: string) => Promise<CommentResult>` | `{ comment_id, url }` |
| `dismissApprovals` | `(repo: string, prNumber: number, message: string) => Promise<void>` | -- |
| `getBranchProtection` | `(repo: string, branch: string) => Promise<BranchProtection>` | `{ protected, required_reviews, required_checks, restrictions }` |
| `getDefaultBranch` | `(repo: string) => Promise<string>` | Branch name (e.g. `"main"`) |
| `getAuthenticatedRemoteUrl` | `(remoteUrl: string) => SecureValue` | Authenticated remote URL (token wrapped in a `SecureValue` so it never leaks through logs). Synchronous. |

The `repo` parameter uses `"owner/repo"` format throughout.

`detectPrEvents` aggregates the platform's live PR state into the small typed vocabulary Core reacts to (`pr_comments`, `pr_ci_failure`, `pr_merge_conflict`, `pr_ready_to_merge`, `pr_merged`). The plugin reports **facts**, recomputed on every call so merge-readiness survives a daemon restart with no in-memory wait state: emit `pr_ready_to_merge` only when approval, green CI, and mergeability all hold at once. Core owns the **policy** — arbitrating a single winner when several hold, deduping already-accommodated feedback, and authorizing `/approve` comments against the people directory. A plugin never sees the people directory or The Engineer's `/approve` convention, so a new hosting plugin re-implements none of it.

### Lifecycle (inherited from BaseAdapter)

| Method | Signature | Notes |
|---|---|---|
| `initialize` | `(config: Record<string, unknown>) => Promise<InitResult>` | Validate config, set up API client. Never throws -- returns `{ success: false }` on failure. |
| `shutdown` | `() => Promise<void>` | Clean up resources. Errors are swallowed. |
| `healthCheck` | `() => Promise<HealthStatus>` | Report API availability. Timeout handled by Registry. |

## Key Types

All types are Zod schemas exported from `src/schemas/adapters.ts`.

```typescript
// PR creation input
type PROptions = {
  repo: string;        // "owner/repo"
  branch: string;      // head branch
  base: string;        // target branch
  title: string;
  body: string;
  draft: boolean;
  labels: string[] | null;
  reviewers: string[] | null;
};

// PR creation result
type PRResult = { pr_number: number; url: string };

// PR update fields (null = no change)
type PRUpdates = {
  title: string | null;
  body: string | null;
  draft: boolean | null;
  labels_add: string[] | null;
  labels_remove: string[] | null;
};

// Merge strategies
type MergeStrategy = "merge" | "squash" | "rebase";

// Merge result — a discriminated union on `success`. A failure REQUIRES a typed `reason` Core routes on,
// so a host block (a required review the token cannot satisfy) can never be silently dropped.
type MergeResult =
  | { success: true; merge_sha: string }
  | { success: false; reason: MergeFailureReason; message: string };

// Why a merge failed — host-agnostic and closed. Map your platform's failure into one of these.
type MergeFailureReason = "not_mergeable" | "conflict" | "transient";

// PR state query
type PRStatus = {
  number: number;
  state: "open" | "closed" | "merged";
  draft: boolean;
  // Tri-plus-state, like checks_state. "unknown" means the host has not finished computing mergeability
  // (common right after a push) — it is NOT a conflict, and Core treats it as a wait, never rework.
  // "blocked" means mergeable in shape but the host will not complete the merge (branch protection / a
  // required review a comment cannot satisfy) — Core waits or hands off to the owner, never reworks.
  merge_state: "mergeable" | "conflicting" | "blocked" | "unknown";
  // "unknown" means the CI status could not be determined — the lookup itself errored (network blip,
  // dropped connection, rate-limit). It is NOT "failing": Core treats it as a wait — never rework,
  // never merge — so a transient blip cannot trigger a phantom rework, and we never claim "passing".
  checks_state: "passing" | "failing" | "pending" | "none" | "unknown";
  url: string;
};

// Review aggregation
type ReviewStatus = {
  approved: boolean;           // true only if approvals > 0 AND no changes_requested
  approvals: number;
  changes_requested: boolean;
  reviewers: { username: string; state: "approved" | "changes_requested" | "commented" | "pending" }[];
  comments: string[];          // review body text
};

// Branch protection
type BranchProtection = {
  protected: boolean;
  required_reviews: number;
  required_checks: string[];
  restrictions: Record<string, unknown> | null;
};

// Typed PR events (discriminated union on `type`). Payloads are thin by design —
// only pr_comments carries data (Core dedups it and scans it for `/approve`).
// Other re-entered phases fetch richer detail live via the query methods above.
type PrEvent =
  | { type: "pr_comments"; comments: PRComment[] }
  | { type: "pr_ci_failure" }
  | { type: "pr_merge_conflict" }
  | { type: "pr_ready_to_merge" }
  | { type: "pr_merged" };
```

## Developing a New Plugin

The full authoring flow — scaffold, register, run the contract suite, configure, verify, and contribute back — is the same for every adapter and lives in **[Authoring a Plugin](../../contribution-docs/how-tos/plugins/authoring.md)**. This section covers only what is specific to a git-hosting plugin: the class skeleton, the manifest fields, and the contract suite. Note the adapter-unique rules: **every method is required** (no capability gating), and a plugin must **never force-merge** — return a failed `MergeResult` (`reason: "not_mergeable"`) when branch protection blocks a merge, rather than bypassing it.

### Class skeleton

```typescript
import {
  GitHostingAdapter,
  type HealthStatus,
  type InitResult,
  type PROptions,
  type PRResult,
  type PRStatus,
  type PRUpdates,
  type MergeResult,
  type MergeStrategy,
  type ReviewStatus,
  type PRComment,
  type PrEvent,
  type CommentResult,
  type BranchProtection,
  createAdapterError,
} from "../../../adapters/index.js";
import { type YourConfig, YourConfigSchema } from "./config.js";

export class YourHostingPlugin extends GitHostingAdapter {
  private config!: YourConfig;

  // ── PR Lifecycle ────────────────────────────────────
  protected async doCreatePR(options: PROptions): Promise<PRResult> { /* ... */ }
  protected async doUpdatePR(repo: string, prNumber: number, updates: PRUpdates): Promise<void> { /* ... */ }
  protected async doMergePR(repo: string, prNumber: number, strategy: MergeStrategy): Promise<MergeResult> { /* ... */ }
  protected async doClosePR(repo: string, prNumber: number): Promise<void> { /* ... */ }

  // ── PR Queries ──────────────────────────────────────
  protected async doGetPRStatus(repo: string, prNumber: number): Promise<PRStatus> { /* ... */ }
  protected async doGetReviewStatus(repo: string, prNumber: number): Promise<ReviewStatus> { /* ... */ }
  protected async doGetPRComments(repo: string, prNumber: number): Promise<PRComment[]> { /* ... */ }

  // ── PR Events ───────────────────────────────────────
  protected async doDetectPrEvents(repo: string, prNumber: number): Promise<PrEvent[]> { /* aggregate live PR state into typed events */ }

  // ── PR Comments ─────────────────────────────────────
  protected async doCommentOnPR(repo: string, prNumber: number, comment: string, replyTo: string | undefined): Promise<CommentResult> { /* ... */ }

  // ── Review Actions ─────────────────────────────────
  protected async doDismissApprovals(repo: string, prNumber: number, message: string): Promise<void> { /* ... */ }

  // ── Branch Queries ──────────────────────────────────
  protected async doGetBranchProtection(repo: string, branch: string): Promise<BranchProtection> { /* ... */ }
  protected async doGetDefaultBranch(repo: string): Promise<string> { /* ... */ }
  protected doGetAuthenticatedRemoteUrl(remoteUrl: string): SecureValue { /* synchronous; wrap token in SecureValue */ }

  // ── Lifecycle ───────────────────────────────────────
  protected async doInitialize(config: Record<string, unknown>): Promise<InitResult> {
    const parsed = YourConfigSchema.safeParse(config);
    if (!parsed.success) {
      return { success: false, message: `Invalid config: ${parsed.error.message}` };
    }
    this.config = parsed.data;
    // Set up API client here
    return { success: true, message: null };
  }

  protected async doShutdown(): Promise<void> { /* clean up */ }
  protected async doHealthCheck(): Promise<HealthStatus> { /* check API reachability */ }
}
```

### Config schema

A git-hosting config typically reuses the shared `MergeStrategySchema` for its default merge strategy:

```typescript
import { z } from "zod";
import { MergeStrategySchema } from "../../../schemas/adapters.js";

export const YourConfigSchema = z.object({
  api_token: z.string().min(1),
  default_merge_strategy: MergeStrategySchema.default("squash"),
});

export type YourConfig = z.output<typeof YourConfigSchema>;
```

### Git-hosting manifest fields

When you register in `builtin.ts` (authoring guide Step 5), a git-hosting manifest uses `type: "git_hosting"` and declares two `adapter_meta` keys: **`action_classes`** (the kinds of outside-world actions it performs, e.g. `"git-remote"`, `"merge"`) and **`channel`** (the platform name your host's identities live under, e.g. `"github"`, `"gitlab"`):

```typescript
// Manifest entry (in the manifests array)
{
  id: "your-hosting",
  type: "git_hosting",
  version: "1.0.0",
  name: "Your Hosting",
  description: "PR lifecycle management via Your Platform API",
  critical: true,
  requirements: [{ type: "env", name: "YOUR_API_TOKEN" }],
  entry: "builtin",
  adapter_meta: { action_classes: ["git-remote", "merge"], channel: "your-platform" },
  contributes: { events: ["git.pr_merged"] },
}
```

**Why `channel` matters.** When a sole contributor cannot approve their own pull request on the host, The Engineer accepts a `/approve` comment as the approval (gated by `safety.merge.enable_comment_approval`). Core authorizes that comment by matching its author — a username on your host — against the configured owner/reviewer's contact handle on **a git-hosting channel**. It derives that set of channels from the registered git-hosting plugins by adapter type, so declaring `channel` is what lets your platform's `/approve` be authorized. The match is deliberately confined to git-hosting channels: a host username never gains merge authority by coincidentally equalling someone's Slack or Telegram handle. A person's contact for your platform is `{ channel: "your-platform", handle: "their-username" }` in `people.yaml`.

### Contract tests

The git-hosting suite is **`runGitHostingContractSuite`** from `tests/helpers/contract-suites/git-hosting-contract.ts`. Beyond the standard valid/invalid config and manifest, it needs a git-hosting-specific `prOptions` fixture:

```typescript
// tests/unit/plugins/git-hosting/your-hosting/your-hosting.test.ts
import { describe } from "vitest";
import { runGitHostingContractSuite, type GitHostingContractFixtures } from "../../../../helpers/contract-suites/git-hosting-contract.js";
import { YourHostingPlugin } from "../../../../../src/plugins/git-hosting/your-hosting/your-hosting.js";

const fixtures: GitHostingContractFixtures = {
  validConfig: { api_token: "test-token" },
  invalidConfig: {},
  manifest: {
    id: "your-hosting",
    type: "git_hosting",
    version: "1.0.0",
    name: "Your Hosting",
    description: "Test",
    critical: true,
    requirements: [],
    entry: "builtin",
    adapter_meta: {},
    contributes: {},
  },
  prOptions: {
    repo: "owner/repo",
    branch: "feature",
    base: "main",
    title: "Test PR",
    body: "Test body",
    draft: false,
    labels: null,
    reviewers: null,
  },
};

describe("YourHostingPlugin", () => {
  runGitHostingContractSuite(() => new YourHostingPlugin(), fixtures);
});
```

The contract suite validates: lifecycle (init, health, shutdown), PR lifecycle (create, status, review, comments, detect events, comment, merge, dismiss approvals), and branch queries (default branch, protection).

## Built-in Plugins

| Plugin | Platform | API Client | Config Keys | Requirements |
|---|---|---|---|---|
| `GitHubHostingPlugin` | GitHub | `@octokit/rest` | `github_token`, `default_merge_strategy` | `GITHUB_TOKEN` env var |

The GitHub implementation uses Octokit for all API calls. It parses `"owner/repo"` strings internally with `splitRepo()`. Merge errors are classified by HTTP status (405 = not mergeable, 409 = conflict). Review aggregation takes the latest state per reviewer and collects review body text.

## Reference

| File | Description |
|---|---|
| `src/adapters/git-hosting.ts` | Abstract class with 13 public methods + 13 protected abstract `do*` methods |
| `src/adapters/base.ts` | `BaseAdapter` -- lifecycle template methods, manifest, `hasCapability()` |
| `src/adapters/errors.ts` | `AdapterMethodError` and `createAdapterError()` |
| `src/schemas/adapters.ts` | All Zod schemas: `PROptionsSchema`, `PRResultSchema`, `MergeResultSchema`, etc. |
| `src/plugins/git-hosting/github-hosting/github-hosting.ts` | Reference implementation (GitHub via Octokit) |
| `src/plugins/git-hosting/github-hosting/config.ts` | GitHub-specific config schema |
| `src/plugins/builtin.ts` | Manifest definitions and factory registration |
| `tests/helpers/contract-suites/git-hosting-contract.ts` | Reusable contract compliance test suite |
